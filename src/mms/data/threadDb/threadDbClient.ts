/**
 * The daemon's side of the thread database workers.
 *
 * - The write worker runs saves and the small reads a save needs (`callSync`). Its caller waits for the reply
 *   synchronously (`Atomics.wait`), so a save keeps the contract it has always had: when it returns, the change is
 *   on disk, and a failure throws. A save writes only the rows that changed, so the wait does not grow with the
 *   thread.
 * - The read worker runs everything whose cost grows with a thread or the profile (`call`): loading a thread, pages,
 *   checks and exports. Nothing waits for it synchronously, and it never delays a save.
 * - Search index work and imports each have a worker of their own, started on first use, so neither delays a page.
 *
 * When the built worker script is not beside this bundle (tests running from source), both run in-process.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { ThreadDbEngine, ThreadDbError } from './threadDbEngine'

export type ThreadDbOps = {
  [K in keyof ThreadDbEngine as ThreadDbEngine[K] extends (...args: never[]) => unknown ? K : never]: ThreadDbEngine[K]
}
type Op = keyof ThreadDbOps
type Args<K extends Op> = Parameters<ThreadDbOps[K]>
type Result<K extends Op> = ReturnType<ThreadDbOps[K]>

export interface WireError { name: string; message: string; code?: string }

export function toWireError(error: unknown): WireError {
  const value = error instanceof Error ? error : new Error(String(error))
  return { name: value.name, message: value.message, code: (value as { code?: string }).code }
}

function fromWireError(wire: WireError): Error {
  if (wire.name === 'ThreadDbError') return new ThreadDbError(wire.code as ThreadDbError['code'], wire.message)
  const error = new Error(wire.message)
  error.name = wire.name
  if (wire.code) (error as NodeJS.ErrnoException).code = wire.code
  return error
}

/** Runs one request on an engine; shared by the workers and the in-process mode. */
export function runOp(engine: ThreadDbEngine, op: string, args: unknown[]): unknown {
  const method = (engine as unknown as Record<string, unknown>)[op]
  if (typeof method !== 'function' || op === 'constructor') throw new Error(`Unknown thread database operation: ${op}`)
  return (method as (...a: unknown[]) => unknown).apply(engine, args)
}

/** The built worker beside the bundle that runs this code (`out/cli/threadDbWorker.js`, `out/main/threadDbWorker.js`). */
export function threadDbWorkerScript(): string | undefined {
  if (process.env.MOUSSE_THREAD_DB_WORKER === 'inline') return undefined
  if (process.env.MOUSSE_THREAD_DB_WORKER) return process.env.MOUSSE_THREAD_DB_WORKER
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..')]) {
    const script = join(dir, 'threadDbWorker.js')
    const unpacked = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (unpacked !== script && existsSync(unpacked)) return unpacked
    if (existsSync(script)) return script
  }
  return undefined
}

const SYNC_TIMEOUT_MS = 120_000

/** Where each worker writes its open connection count in the shared counters. */
const OPEN_COUNT_SLOTS = { write: 0, read: 1, index: 2, import: 3 } as const

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** A worker answering requests by id. It keeps the process alive only while a request is in flight. */
class AsyncWorker {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(script: string, role: 'read' | 'index' | 'import', openCounts?: Int32Array) {
    this.worker = new Worker(script, { workerData: { role, openCounts, slot: OPEN_COUNT_SLOTS[role] }, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    this.worker.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: WireError }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (!this.pending.size) this.worker.unref()
      if (message.ok) entry.resolve(message.value)
      else entry.reject(fromWireError(message.error!))
    })
    const failAll = (error: Error): void => {
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      this.worker.unref()
    }
    this.worker.on('error', failAll)
    this.worker.on('exit', (code) => failAll(new Error(`Thread database ${role} worker stopped (${code})`)))
    // After the listeners: adding a message listener refs a worker again.
    this.worker.unref()
  }

  call(op: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (!this.pending.size) this.worker.ref()
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  terminate(): Promise<number> {
    return this.worker.terminate()
  }

  /** Bytes of heap the worker uses, or null when it cannot say. */
  heapUsed(): Promise<number | null> {
    return workerHeapUsed(this.worker)
  }
}

async function workerHeapUsed(worker: Worker): Promise<number | null> {
  const read = (worker as { getHeapStatistics?: () => Promise<{ used_heap_size: number }> }).getHeapStatistics
  if (typeof read !== 'function') return null
  try {
    return (await read.call(worker)).used_heap_size
  } catch {
    return null
  }
}

/** A worker's answer, or null when it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.() })
  ]).finally(() => clearTimeout(timer))
}

export class ThreadDbClient {
  private readonly inlineWrite?: ThreadDbEngine
  private readonly inlineRead?: ThreadDbEngine
  private writer?: Worker
  /** Each worker's open SQLite connections, written by the worker itself: read without a request. */
  private readonly openCounts = new Int32Array(new SharedArrayBuffer(4 * 4))
  private reader?: AsyncWorker
  private indexer?: AsyncWorker
  private importer?: AsyncWorker
  private script?: string
  private syncPort?: MessagePort
  private syncFlag?: Int32Array
  private closed = false
  readonly mode: 'worker' | 'inline'

  constructor(options: { script?: string | null; syncTimeoutMs?: number } = {}) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS
    const script = options.script === null ? undefined : options.script ?? threadDbWorkerScript()
    if (!script) {
      this.mode = 'inline'
      this.inlineWrite = new ThreadDbEngine({ idleCloseMs: 2_000 })
      this.inlineRead = new ThreadDbEngine({ idleCloseMs: 0, checkpointOnClose: false })
      return
    }
    this.mode = 'worker'
    this.writerScript = script
    this.startWriter()
    this.reader = new AsyncWorker(script, 'read', this.openCounts)
    this.script = script
  }

  private writerScript?: string
  private readonly syncTimeoutMs: number
  private nextSyncId = 1

  /** A write worker with its own reply port and flag. A worker that timed out is replaced by a new one. */
  private startWriter(): void {
    Atomics.store(this.openCounts, OPEN_COUNT_SLOTS.write, 0)
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const { port1, port2 } = new MessageChannel()
    this.writer = new Worker(this.writerScript!, {
      workerData: { role: 'write', flag, port: port2, openCounts: this.openCounts, slot: OPEN_COUNT_SLOTS.write },
      transferList: [port2],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    this.writer.unref()
    // The port is only read synchronously; it must not keep the process alive.
    port1.unref()
    this.syncPort = port1
    this.syncFlag = flag
  }

  /** A save or a small read, finished when this returns. */
  callSync<K extends Op>(op: K, ...args: Args<K>): Result<K> {
    if (this.closed) throw new Error('Thread database client is closed')
    if (this.inlineWrite) return runOp(this.inlineWrite, op, args) as Result<K>
    const flag = this.syncFlag!
    const id = this.nextSyncId++
    Atomics.store(flag, 0, 0)
    this.writer!.postMessage({ id, op, args })
    const waited = Atomics.wait(flag, 0, 0, this.syncTimeoutMs)
    if (waited === 'timed-out') {
      // Its reply may still come, and must never be taken for the next request's: this worker and its port are
      // replaced. A save it was running either committed or not; the next save finds out by the sequence.
      const stuck = this.writer!
      this.startWriter()
      void stuck.terminate()
      throw new Error(`Thread database ${op} did not finish in ${this.syncTimeoutMs / 1000} s`)
    }
    // Only this request can be answered on this port; anything else is a bug, and is not taken as the answer.
    let reply: { id: number; ok: boolean; value?: unknown; error?: WireError } | undefined
    while ((reply = receiveMessageOnPort(this.syncPort!)?.message as typeof reply) !== undefined && reply.id !== id);
    if (!reply) throw new Error(`Thread database ${op} sent no reply`)
    if (!reply.ok) throw fromWireError(reply.error!)
    return reply.value as Result<K>
  }

  /** Work that grows with a thread or the profile, off the event loop. */
  call<K extends Op>(op: K, ...args: Args<K>): Promise<Result<K>> {
    if (this.closed) return Promise.reject(new Error('Thread database client is closed'))
    if (this.inlineRead) {
      return new Promise((resolve, reject) => setImmediate(() => {
        try { resolve(runOp(this.inlineRead!, op, args) as Result<K>) } catch (error) { reject(error as Error) } finally { this.inlineRead!.closeAll() }
      }))
    }
    return this.reader!.call(op, args) as Promise<Result<K>>
  }

  /**
   * Search index work, in a worker of its own (started on first use): indexing a long thread can take seconds, and
   * must never hold up a page a person is waiting for. In-process mode runs it on the read engine.
   */
  callIndex<K extends Op>(op: K, ...args: Args<K>): Promise<Result<K>> {
    if (this.closed) return Promise.reject(new Error('Thread database client is closed'))
    if (this.inlineRead) return this.call(op, ...args)
    this.indexer ??= new AsyncWorker(this.script!, 'index', this.openCounts)
    return this.indexer.call(op, args) as Promise<Result<K>>
  }

  /**
   * Building a thread's database from its JSON files, in a worker of its own (started on first use): an import reads
   * and checks the whole thread, and must never hold up a page or a search. In-process mode runs it on the read
   * engine.
   */
  callImport<K extends Op>(op: K, ...args: Args<K>): Promise<Result<K>> {
    if (this.closed) return Promise.reject(new Error('Thread database client is closed'))
    if (this.inlineRead) return this.call(op, ...args)
    this.importer ??= new AsyncWorker(this.script!, 'import', this.openCounts)
    return this.importer.call(op, args) as Promise<Result<K>>
  }

  /** Closes the write worker's connection to a thread's database (checkpointing it) before its folder moves. */
  quiesce(dir: string): void {
    if (this.closed) return
    this.callSync('quiesce', dir)
    if (this.inlineRead) this.inlineRead.quiesce(dir)
  }

  /**
   * The memory monitor's counts: worker threads started, the SQLite connections their engines hold, and each
   * worker's heap in bytes. The counts are read from shared memory each worker writes itself, so nothing waits on a
   * worker and no request can time out; the heaps are asked for without blocking. Starts nothing.
   */
  async diagnostics(): Promise<{ workers: number; connections: number | null; workerHeaps: number[] }> {
    if (this.closed) return { workers: 0, connections: 0, workerHeaps: [] }
    if (this.inlineWrite) {
      return { workers: 0, connections: this.inlineWrite.openCount() + (this.inlineRead?.openCount() ?? 0), workerHeaps: [] }
    }
    const asyncWorkers = [this.reader, this.indexer, this.importer].filter((worker): worker is AsyncWorker => Boolean(worker))
    let connections = 0
    for (let slot = 0; slot < this.openCounts.length; slot++) connections += Atomics.load(this.openCounts, slot)
    const heaps = await Promise.all([
      this.writer ? within(workerHeapUsed(this.writer), 5_000) : Promise.resolve(null),
      ...asyncWorkers.map((worker) => within(worker.heapUsed(), 5_000))
    ])
    return {
      workers: (this.writer ? 1 : 0) + asyncWorkers.length,
      connections,
      workerHeaps: heaps.filter((heap): heap is number => typeof heap === 'number')
    }
  }

  /** True when the client has workers to stop. */
  get usesWorkers(): boolean {
    return this.mode === 'worker'
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      if (this.inlineWrite) this.inlineWrite.closeAll()
      else this.callSync('closeAll')
    } catch {
      // Closing is best effort; SQLite recovers an unclosed WAL at the next open.
    }
    this.closed = true
    this.inlineRead?.closeEverything()
    await Promise.all([this.writer?.terminate(), this.reader?.terminate(), this.indexer?.terminate(), this.importer?.terminate()])
  }
}

let shared: ThreadDbClient | undefined

/** The process's thread database client, started on first use. */
export function sharedThreadDbClient(): ThreadDbClient {
  if (!shared) shared = new ThreadDbClient()
  return shared
}

/** The process's client when one was started; nothing is started by asking. */
export function existingThreadDbClient(): ThreadDbClient | undefined {
  return shared
}

export async function closeSharedThreadDbClient(): Promise<void> {
  const client = shared
  shared = undefined
  await client?.close()
}
