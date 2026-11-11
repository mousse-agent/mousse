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
/**
 * The search index and import workers stop after this long without a request, and start again on the next one. Each
 * idle worker holds about 11 MB (its own V8 heap and the worker bundle), and both are used in bursts.
 */
export const IDLE_WORKER_STOP_MS = 2 * 60_000

/**
 * What one worker reports about itself for the memory monitor, in shared memory it writes and the daemon only reads:
 * its open SQLite connections, its heap in KB, and whether it is running. Each worker has its own: a worker that was
 * replaced or ended writes into memory nobody reads any more, and reading never sends it a request.
 */
export const WORKER_STAT_OPEN = 0
export const WORKER_STAT_HEAP_KB = 1
export const WORKER_STAT_ALIVE = 2

export function newWorkerStats(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(3 * 4))
}

/** A worker's stats once it stopped: nothing open, not running. */
function markEnded(stats: Int32Array): void {
  Atomics.store(stats, WORKER_STAT_ALIVE, 0)
  Atomics.store(stats, WORKER_STAT_OPEN, 0)
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

interface AsyncWorkerOptions {
  /** The worker reports when it has had no request for `ms`; `stop` is then called once. */
  idle?: { ms: number; stop: () => void }
  /** Called once when the worker thread ends for any reason (a crash, `terminate`). */
  onExit?: () => void
}

/** A worker answering requests by id. It keeps the process alive only while a request is in flight. */
class AsyncWorker {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** What the worker reports about itself (`WORKER_STAT_*`); a new worker starts with its own, all zero. */
  readonly stats = newWorkerStats()
  private idleTimer?: ReturnType<typeof setTimeout>
  private readonly idle?: AsyncWorkerOptions['idle']
  /** Set once the thread has ended: a request then fails at once instead of waiting for an answer that never comes. */
  private exited?: Error

  constructor(script: string, role: 'read' | 'index' | 'import', options: AsyncWorkerOptions = {}) {
    this.idle = options.idle
    this.worker = new Worker(script, { workerData: { role, stats: this.stats }, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    this.worker.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: WireError }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (!this.pending.size) {
        this.worker.unref()
        this.armIdle()
      }
      if (message.ok) entry.resolve(message.value)
      else entry.reject(fromWireError(message.error!))
    })
    const failAll = (error: Error): void => {
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      this.worker.unref()
    }
    this.worker.on('error', failAll)
    this.worker.on('exit', (code) => {
      markEnded(this.stats)
      this.exited = new Error(`Thread database ${role} worker stopped (${code})`)
      this.clearIdle()
      failAll(this.exited)
      options.onExit?.()
    })
    // After the listeners: adding a message listener refs a worker again.
    this.worker.unref()
  }

  call(op: string, args: unknown[]): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited)
    const id = this.nextId++
    this.clearIdle()
    return new Promise((resolve, reject) => {
      if (!this.pending.size) this.worker.ref()
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  private armIdle(): void {
    if (!this.idle) return
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (!this.pending.size) this.idle!.stop()
    }, this.idle.ms)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /**
   * Closes what the worker holds open (the search index, any thread database), then ends it. Only called with no
   * request in flight; the owner has already stopped sending to it.
   */
  async retire(): Promise<void> {
    this.clearIdle()
    if (this.exited) return
    try {
      await this.call('closeEverything', [])
    } catch {
      // Ending the worker closes its connections anyway; SQLite recovers an unclosed WAL at the next open.
    }
    this.clearIdle()
    if (!this.exited) await this.worker.terminate()
  }

  terminate(): Promise<number> {
    this.clearIdle()
    return this.worker.terminate()
  }
}

export class ThreadDbClient {
  private readonly inlineWrite?: ThreadDbEngine
  private readonly inlineRead?: ThreadDbEngine
  private writer?: Worker
  /** The current write worker's stats; a replaced writer keeps writing only into its own, which is dropped. */
  private writerStats?: Int32Array
  private reader?: AsyncWorker
  private indexer?: AsyncWorker
  private importer?: AsyncWorker
  private script?: string
  private syncPort?: MessagePort
  private syncFlag?: Int32Array
  private closed = false
  private readonly idleWorkerStopMs: number
  /** Index and import workers that went idle and are closing; `close` waits for them. */
  private readonly retiring = new Set<Promise<void>>()
  readonly mode: 'worker' | 'inline'

  constructor(options: { script?: string | null; syncTimeoutMs?: number; idleWorkerStopMs?: number } = {}) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS
    this.idleWorkerStopMs = options.idleWorkerStopMs ?? IDLE_WORKER_STOP_MS
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
    this.script = script
    this.reader = this.startReader()
  }

  private writerScript?: string
  private readonly syncTimeoutMs: number
  private nextSyncId = 1

  /** A write worker with its own reply port and flag. A worker that timed out is replaced by a new one. */
  private startWriter(): void {
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const stats = newWorkerStats()
    const { port1, port2 } = new MessageChannel()
    this.writer = new Worker(this.writerScript!, {
      workerData: { role: 'write', flag, port: port2, stats },
      transferList: [port2],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    this.writer.once('exit', () => markEnded(stats))
    this.writerStats = stats
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
    this.reader ??= this.startReader()
    return this.reader.call(op, args) as Promise<Result<K>>
  }

  /**
   * Search index work, in a worker of its own (started on first use): indexing a long thread can take seconds, and
   * must never hold up a page a person is waiting for. In-process mode runs it on the read engine.
   */
  callIndex<K extends Op>(op: K, ...args: Args<K>): Promise<Result<K>> {
    if (this.closed) return Promise.reject(new Error('Thread database client is closed'))
    if (this.inlineRead) return this.call(op, ...args)
    this.indexer ??= this.startIdleWorker('index')
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
    this.importer ??= this.startIdleWorker('import')
    return this.importer.call(op, args) as Promise<Result<K>>
  }

  /**
   * An index or import worker that ends itself once idle. It is forgotten first, so a request that comes while it
   * closes starts a new worker instead of reaching this one.
   */
  private startIdleWorker(role: 'index' | 'import'): AsyncWorker {
    const forget = (): boolean => {
      if (role === 'index' ? this.indexer !== worker : this.importer !== worker) return false
      if (role === 'index') this.indexer = undefined
      else this.importer = undefined
      return true
    }
    const worker: AsyncWorker = new AsyncWorker(this.script!, role, {
      idle: {
        ms: this.idleWorkerStopMs,
        stop: () => {
          if (!forget()) return
          const done: Promise<void> = worker.retire().catch(() => undefined).finally(() => this.retiring.delete(done))
          this.retiring.add(done)
        }
      },
      // A worker that died is forgotten, so the next request starts a new one.
      onExit: () => { forget() }
    })
    return worker
  }

  /** The read worker; one that died is forgotten, and the next read starts a new one. */
  private startReader(): AsyncWorker {
    const worker: AsyncWorker = new AsyncWorker(this.script!, 'read', {
      onExit: () => { if (this.reader === worker) this.reader = undefined }
    })
    return worker
  }

  /** Workers running now, by role, for tests and diagnostics. */
  workerRoles(): string[] {
    if (this.mode === 'inline') return []
    return [this.writer && 'write', this.reader && 'read', this.indexer && 'index', this.importer && 'import'].filter((role): role is string => Boolean(role))
  }

  /** Closes the write worker's connection to a thread's database (checkpointing it) before its folder moves. */
  quiesce(dir: string): void {
    if (this.closed) return
    this.callSync('quiesce', dir)
    if (this.inlineRead) this.inlineRead.quiesce(dir)
  }

  /**
   * The memory monitor's counts: running worker threads, the SQLite connections they hold, and each one's heap in
   * bytes, read only from the stats each worker writes itself. It sends no request, so it never keeps a worker
   * alive, restarts one that ended, or waits on a busy one. A worker this client no longer holds is not counted.
   */
  async diagnostics(): Promise<{ workers: number; connections: number | null; workerHeaps: number[] }> {
    if (this.closed) return { workers: 0, connections: 0, workerHeaps: [] }
    if (this.inlineWrite) {
      return { workers: 0, connections: this.inlineWrite.openCount() + (this.inlineRead?.openCount() ?? 0), workerHeaps: [] }
    }
    const held = [this.writerStats, this.reader?.stats, this.indexer?.stats, this.importer?.stats]
    let workers = 0
    let connections = 0
    const workerHeaps: number[] = []
    for (const stats of held) {
      if (!stats || Atomics.load(stats, WORKER_STAT_ALIVE) !== 1) continue
      workers += 1
      connections += Atomics.load(stats, WORKER_STAT_OPEN)
      const heapKb = Atomics.load(stats, WORKER_STAT_HEAP_KB)
      if (heapKb > 0) workerHeaps.push(heapKb * 1024)
    }
    return { workers, connections, workerHeaps }
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
    await Promise.all([this.writer?.terminate(), this.reader?.terminate(), this.indexer?.terminate(), this.importer?.terminate(), ...this.retiring])
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
