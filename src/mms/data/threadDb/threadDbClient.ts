/**
 * The daemon's side of the thread database workers.
 *
 * - The write worker runs saves and the small reads a save needs (`callSync`). Its caller waits for the reply
 *   synchronously (`Atomics.wait`), so a save keeps the contract it has always had: when it returns, the change is
 *   on disk, and a failure throws. A save writes only the rows that changed, so the wait does not grow with the
 *   thread.
 * - The read worker runs everything whose cost grows with a thread or the profile (`call`): loading a thread, pages,
 *   imports, checks and exports. Nothing waits for it synchronously, and it never delays a save.
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

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class ThreadDbClient {
  private readonly inlineWrite?: ThreadDbEngine
  private readonly inlineRead?: ThreadDbEngine
  private writer?: Worker
  private reader?: Worker
  private syncPort?: MessagePort
  private syncFlag?: Int32Array
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false
  readonly mode: 'worker' | 'inline'

  constructor(options: { script?: string | null } = {}) {
    const script = options.script === null ? undefined : options.script ?? threadDbWorkerScript()
    if (!script) {
      this.mode = 'inline'
      this.inlineWrite = new ThreadDbEngine({ idleCloseMs: 2_000 })
      this.inlineRead = new ThreadDbEngine({ idleCloseMs: 0, checkpointOnClose: false })
      return
    }
    this.mode = 'worker'
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const { port1, port2 } = new MessageChannel()
    this.writer = new Worker(script, {
      workerData: { role: 'write', flag, port: port2 },
      transferList: [port2],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    this.writer.unref()
    // The port is only read synchronously; it must not keep the process alive.
    port1.unref()
    this.syncPort = port1
    this.syncFlag = flag
    this.reader = new Worker(script, { workerData: { role: 'read' }, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    this.reader.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: WireError }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (!this.pending.size) this.reader?.unref()
      if (message.ok) entry.resolve(message.value)
      else entry.reject(fromWireError(message.error!))
    })
    const failAll = (error: Error): void => {
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
      this.reader?.unref()
    }
    this.reader.on('error', failAll)
    this.reader.on('exit', (code) => failAll(new Error(`Thread database reader stopped (${code})`)))
    // After the listeners: adding a message listener refs a worker again. Neither worker keeps the process alive.
    this.reader.unref()
  }

  /** A save or a small read, finished when this returns. */
  callSync<K extends Op>(op: K, ...args: Args<K>): Result<K> {
    if (this.closed) throw new Error('Thread database client is closed')
    if (this.inlineWrite) return runOp(this.inlineWrite, op, args) as Result<K>
    const flag = this.syncFlag!
    Atomics.store(flag, 0, 0)
    this.writer!.postMessage({ op, args })
    const waited = Atomics.wait(flag, 0, 0, SYNC_TIMEOUT_MS)
    if (waited === 'timed-out') throw new Error(`Thread database ${op} did not finish in ${SYNC_TIMEOUT_MS / 1000} s`)
    const reply = receiveMessageOnPort(this.syncPort!)?.message as { ok: boolean; value?: unknown; error?: WireError } | undefined
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
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // A read in flight keeps the process alive until it is answered; an idle reader does not.
      if (!this.pending.size) this.reader!.ref()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.reader!.postMessage({ id, op, args })
    })
  }

  /** Closes the write worker's connection to a thread's database (checkpointing it) before its folder moves. */
  quiesce(dir: string): void {
    if (this.closed) return
    this.callSync('quiesce', dir)
    if (this.inlineRead) this.inlineRead.quiesce(dir)
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
    this.inlineRead?.closeAll()
    await Promise.all([this.writer?.terminate(), this.reader?.terminate()])
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
