import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { killTree, spawnHarness } from '../spawn'
import type { InstanceEnv } from '../env'
import { OpencodeClient, type OpencodeEndpoint } from './client'

/**
 * One `opencode serve` per entry, started on first use and closed after it has been idle a while.
 *
 * It runs as `serve --stdio --port 0`: OpenCode still serves HTTP on loopback, prints `{"url": ...}` as its first line,
 * and exits when its stdin closes (`cli/src/server-process.ts`). Mousse holds that pipe, so the server ends with the
 * daemon, a crash included, on every OS; `stop` also ends its process tree. The password is random per start and
 * passed as `OPENCODE_PASSWORD`, which `--stdio` removes from its own environment so its tools never see it.
 */

/** What starts the server: the executable and its arguments before `serve`, and variables on top of the entry's. */
export interface OpencodeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Marks a managed copy as running while the server lives; the returned function marks it ended. */
  track?: () => () => void
}

/** A started server, as `start` hands it over. */
export interface StartedServer {
  endpoint: OpencodeEndpoint
  /** Ends the server (closes its pipe, then its process tree). */
  close(): void
  /** Settles when the server exited. */
  exited: Promise<void>
  /** The server's process id, when Mousse spawned it. */
  pid?: number
}

export interface OpencodeServerOptions {
  label: string
  env: () => InstanceEnv
  launch: () => OpencodeLaunch
  /** Test seam: starts a server instead of spawning OpenCode. */
  start?: (launch: OpencodeLaunch, signal: AbortSignal) => Promise<StartedServer>
  /** How long an unused server stays up (default 10 minutes). */
  idleMs?: number
  /** Every event the server streams, while it runs. */
  onEvent(event: Record<string, unknown>): void
  /** The server ended (stopped, idle, or it exited on its own). */
  onExit?(): void
  fetchImpl?: typeof fetch
}

const READY_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_MS = 10 * 60_000

/** Spawns `opencode serve --stdio --port 0` and waits for its ready line. */
export function spawnOpencodeServer(env: InstanceEnv, launch: OpencodeLaunch, signal: AbortSignal): Promise<StartedServer> {
  const password = randomBytes(24).toString('base64url')
  const child: ChildProcess = spawnHarness(env, 'opencode-serve', launch.command, [...launch.args, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: launch.cwd,
    extraEnv: { ...launch.env, OPENCODE_PASSWORD: password }
  })
  const untrack = launch.track?.()
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  void exited.then(() => untrack?.())
  const close = () => {
    try { child.stdin?.end() } catch { /* already closed */ }
    // A polite end through the pipe first; the tree goes if it is still there shortly after.
    const timer = setTimeout(() => killTree(child), 3_000)
    timer.unref?.()
    void exited.then(() => clearTimeout(timer))
  }
  return readServerUrl(child, signal).then(
    (url) => ({ endpoint: { url, password }, close, exited, ...(child.pid !== undefined ? { pid: child.pid } : {}) }),
    (error: unknown) => {
      killTree(child)
      throw error
    }
  )
}

/**
 * The address a started `opencode serve --stdio` gives as its first line (`{"url": ...}`), on loopback only. Rejects
 * when the server exits, fails to start, says something else, `signal` aborts, or `timeoutMs` passes; the caller ends
 * the process.
 */
export function readServerUrl(child: Pick<ChildProcess, 'stdout' | 'stderr' | 'once' | 'off'>, signal: AbortSignal, timeoutMs = READY_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = () => {
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
    }
    const fail = (error: Error) => {
      if (settled) return
      finish()
      reject(error)
    }
    const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4_000) }
    const onStdout = (chunk: Buffer) => {
      if (settled) return
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      let url: unknown
      try {
        url = (JSON.parse(stdout.slice(0, newline)) as { url?: unknown }).url
      } catch {
        url = undefined
      }
      if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+\/?$/.test(url)) {
        fail(new Error(`OpenCode's server started without saying where it listens (${stdout.slice(0, newline).slice(0, 200)}).`))
        return
      }
      finish()
      resolve(url.replace(/\/$/, ''))
    }
    const timer = setTimeout(() => fail(new Error(`OpenCode's server did not start within ${timeoutMs / 1000} seconds.`)), timeoutMs)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', onStderr)
    child.stdout?.on('data', onStdout)
    child.once('error', (error) => fail(error))
    child.once('exit', (code) => fail(new Error(`OpenCode's server exited (${code ?? 'signal'}) before it was ready.${stderr.trim() ? ` ${stderr.trim().split('\n').at(-1)}` : ''}`)))
  })
}

export class OpencodeServer {
  private current?: { started: StartedServer; client: OpencodeClient; events: AbortController }
  private starting?: Promise<OpencodeClient>
  private users = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private generation = 0

  constructor(private readonly options: OpencodeServerOptions) {}

  /** Whether a server runs now. */
  running(): boolean {
    return Boolean(this.current)
  }

  /**
   * The running server's client, starting the server when none runs. A caller that uses it for longer than one request
   * holds it (`hold`) so it is not closed as idle meanwhile.
   */
  async client(signal?: AbortSignal): Promise<OpencodeClient> {
    if (this.current) {
      this.touch()
      return this.current.client
    }
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    const client = await (signal ? raceAbort(this.starting, signal) : this.starting)
    this.touch()
    return client
  }

  /** Keeps the server up until the returned function is called. */
  hold(): () => void {
    this.users += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    let released = false
    return () => {
      if (released) return
      released = true
      this.users = Math.max(0, this.users - 1)
      this.touch()
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.users > 0 || !this.current) return
    this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs ?? DEFAULT_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private async start(): Promise<OpencodeClient> {
    const generation = ++this.generation
    const launch = this.options.launch()
    const abort = new AbortController()
    const started = this.options.start
      ? await this.options.start(launch, abort.signal)
      : await spawnOpencodeServer(this.options.env(), launch, abort.signal)
    if (generation !== this.generation) {
      started.close()
      throw new Error(`${this.options.label}'s server was stopped while it started.`)
    }
    const client = new OpencodeClient(started.endpoint, this.options.fetchImpl)
    const events = new AbortController()
    this.current = { started, client, events }
    // The event stream is open before the first request is sent, so no event of a turn is missed.
    await new Promise<void>((resolve, reject) => {
      client.events((event) => this.options.onEvent(event), { signal: events.signal, onOpen: resolve })
        .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          // The stream ended: the server is gone or no longer usable.
          if (this.current?.started === started) this.stop()
        })
    }).catch((error: unknown) => {
      this.stop()
      throw error
    })
    void started.exited.then(() => {
      if (this.current?.started === started) this.stop()
    })
    // Every caller may have left while it started (a turn stopped before the server was ready): with nobody holding
    // it, it closes once idle like any other.
    this.touch()
    return client
  }

  /** Ends the server, if one runs. */
  stop(): void {
    this.generation += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const current = this.current
    this.current = undefined
    if (!current) return
    current.events.abort()
    current.started.close()
    this.options.onExit?.()
  }

  /** Settles once the server that runs now has exited (immediately when none runs). */
  async stopped(): Promise<void> {
    const current = this.current
    this.stop()
    if (current) await current.started.exited
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
