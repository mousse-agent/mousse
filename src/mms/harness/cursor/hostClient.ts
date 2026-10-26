import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { isCursorAuthFailure, redactCursorText } from '../hosts/cursorProtocol'
import type {
  CursorHostError,
  CursorHostMessage,
  CursorHostMethod,
  CursorHostMethods,
  CursorRunStatus,
  CursorUsage
} from '../hosts/cursorProtocol'
import type { InstanceEnv } from '../env'
import { killTree, spawnHarness } from '../spawn'

/**
 * The driver's side of one Cursor host process: requests and replies over NDJSON, run updates
 * routed to the turn that started the run, and the host's exit turned into one typed failure for
 * every request and live run it served. A new host starts on the next request.
 */

/** A failed host call, with what the SDK said. */
export class CursorHostCallError extends Error implements CursorHostError {
  readonly code?: string
  readonly status?: number
  readonly activeRun?: boolean
  readonly auth?: boolean
  constructor(error: CursorHostError) {
    super(error.message)
    this.name = error.name ?? 'CursorHostCallError'
    if (error.code) this.code = error.code
    if (error.status !== undefined) this.status = error.status
    if (error.activeRun) this.activeRun = true
    // The pinned SDK's refusal codes count even when the host did not mark them.
    if (error.auth || isCursorAuthFailure(error)) this.auth = true
  }
}

/** The host process ended while a request or a run was in flight. */
export class CursorHostExitedError extends Error {
  readonly code = 'cursor_host_exited'
  constructor(detail?: string) {
    super(`The Cursor host stopped${detail ? ` (${detail})` : ''}.`)
    this.name = 'CursorHostExitedError'
  }
}

/** What a run reports: its updates, then exactly one end (or the host's exit). */
export interface CursorRunListener {
  update(update: Record<string, unknown>): void
  end(end: { status: CursorRunStatus; error?: CursorHostError; usage?: CursorUsage; transportFailure?: string } | { hostExited: true }): void
}

/** A line transport to a host: the real process, or a replay in tests. */
export interface CursorHostTransport {
  write(line: string): void
  onLine(listener: (line: string) => void): void
  onExit(listener: (detail?: string) => void): void
  kill(): void
}

export type CursorHostConnect = () => CursorHostTransport

const BUFFERED_EVENTS_PER_RUN = 2_000

/** The built host entry beside the bundle that runs this code (`out/main/cursorHost.js`). */
export function defaultCursorHostScript(): string | undefined {
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..')]) {
    const script = join(dir, 'cursorHost.js')
    // Packaged builds unpack the host, so the SDK finds its helpers (rg, the sandbox) on disk.
    const unpacked = script.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (unpacked !== script && existsSync(unpacked)) return unpacked
    if (existsSync(script)) return script
  }
  return undefined
}

/** The host's environment: the instance's, with no ambient Cursor key and Electron running as Node. */
export function cursorHostEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase()
    if (upper === 'CURSOR_API_KEY' || upper === 'MOUSSE_CURSOR_SDK_MODULE') continue
    env[key] = value
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1', MOUSSE_CURSOR_HOST: '1', ...extra }
}

/** Starts the host entry with this process's runtime (Electron as Node, or Node). */
export function spawnCursorHost(env: InstanceEnv, script: string, extra: NodeJS.ProcessEnv = {}): CursorHostTransport {
  const child = spawnHarness({ ...env, env: cursorHostEnv(env.env, extra) }, 'cursor-host', process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_000)
  })
  child.stdin.on('error', () => {
    // A host that died mid-write reports through `exit`.
  })
  const exitListeners: Array<(detail?: string) => void> = []
  let exited = false
  const exit = (detail?: string) => {
    if (exited) return
    exited = true
    if (stderrTail.trim()) console.warn('[harness] cursor host stderr', redactCursorText(stderrTail.trim().split('\n').slice(-5).join('\n')))
    for (const listener of exitListeners) listener(detail)
  }
  child.once('error', (error) => exit(error.message))
  child.once('exit', (code, signal) => exit(signal ? `signal ${signal}` : `exit code ${code}`))
  return {
    write: (line) => {
      if (!exited) child.stdin.write(line)
    },
    onLine: (listener) => void lines.on('line', listener),
    onExit: (listener) => void exitListeners.push(listener),
    kill: () => {
      child.stdin.end()
      killTree(child)
    }
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class CursorHostClient {
  private transport: CursorHostTransport | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly runs = new Map<string, CursorRunListener>()
  /** Events of runs nobody watches yet (the reply to `send` is read after its first updates). */
  private readonly early = new Map<string, Array<(listener: CursorRunListener) => void>>()
  private readonly loginUrls = new Map<string, (url: string) => void>()
  private readonly exitListeners = new Set<() => void>()
  /** Bumped when a host exits; a run started under an older one has ended with it. */
  private generation = 0
  private readonly runGenerations = new Map<string, number>()
  private stopped = false

  constructor(private readonly connect: CursorHostConnect) {}

  /** The host is running now. */
  get running(): boolean {
    return this.transport !== undefined
  }

  /** Called once each time the host exits (crash or kill). */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private start(): CursorHostTransport {
    if (this.stopped) throw new Error('The Cursor host is stopped.')
    if (this.transport) return this.transport
    const transport = this.connect()
    this.transport = transport
    transport.onLine((line) => this.receive(line))
    transport.onExit((detail) => {
      if (this.transport !== transport) return
      this.transport = undefined
      const error = new CursorHostExitedError(detail)
      this.generation += 1
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      // Every live run ends once, as interrupted; nothing is replayed. A run nobody watches yet
      // keeps its updates and ends when it is watched.
      const runs = [...this.runs.values()]
      this.runs.clear()
      for (const [runId, queued] of this.early) {
        // A run whose send was never answered has no turn to read it: its updates go.
        if (this.runGenerations.has(runId)) queued.push((listener) => listener.end({ hostExited: true }))
        else this.early.delete(runId)
      }
      this.loginUrls.clear()
      for (const run of runs) run.end({ hostExited: true })
      for (const listener of this.exitListeners) listener()
    })
    return transport
  }

  private receive(line: string): void {
    let message: CursorHostMessage
    try {
      message = JSON.parse(line) as CursorHostMessage
    } catch {
      return
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if ('error' in message) pending.reject(new CursorHostCallError(message.error))
      else pending.resolve(message.result)
      return
    }
    if (message.event === 'login_url') {
      this.loginUrls.get(message.loginId)?.(message.url)
      return
    }
    if (message.event === 'delta' || message.event === 'run_end') {
      const deliver = (listener: CursorRunListener) => {
        if (message.event === 'delta') listener.update(message.update)
        else {
          const { event: _event, runId: _runId, ...end } = message
          listener.end(end)
        }
      }
      const listener = this.runs.get(message.runId)
      if (message.event === 'run_end') this.runs.delete(message.runId)
      if (listener) return deliver(listener)
      const queued = this.early.get(message.runId) ?? []
      if (queued.length < BUFFERED_EVENTS_PER_RUN || message.event === 'run_end') queued.push(deliver)
      this.early.set(message.runId, queued)
    }
  }

  request<M extends CursorHostMethod>(method: M, params: CursorHostMethods[M]['params']): Promise<CursorHostMethods[M]['result']> {
    let transport: CursorHostTransport
    try {
      transport = this.start()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId++
    const generation = this.generation
    const reply = new Promise<CursorHostMethods[M]['result']>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      transport.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    if (method !== 'send') return reply
    return reply.then((result) => {
      this.runGenerations.set((result as CursorHostMethods['send']['result']).runId, generation)
      return result
    })
  }

  /** Routes `runId`'s updates and its end to `listener`, including those that arrived first. */
  watchRun(runId: string, listener: CursorRunListener): void {
    const queued = this.early.get(runId)
    this.early.delete(runId)
    let ended = false
    const once: CursorRunListener = {
      update: (update) => {
        if (!ended) listener.update(update)
      },
      end: (end) => {
        if (ended) return
        ended = true
        listener.end(end)
      }
    }
    const generation = this.runGenerations.get(runId)
    this.runGenerations.delete(runId)
    this.runs.set(runId, once)
    for (const deliver of queued ?? []) deliver(once)
    // Started under a host that has exited since: it ended with it.
    if (!ended && generation !== undefined && generation !== this.generation) once.end({ hostExited: true })
    if (ended) this.runs.delete(runId)
  }

  /** Receives the sign-in link of `loginId`. */
  watchLogin(loginId: string, listener: ((url: string) => void) | undefined): void {
    if (listener) this.loginUrls.set(loginId, listener)
    else this.loginUrls.delete(loginId)
  }

  /** Ends the host and everything it runs; the next request starts a new one. */
  kill(): void {
    this.transport?.kill()
  }

  stop(): void {
    this.stopped = true
    this.kill()
  }
}
