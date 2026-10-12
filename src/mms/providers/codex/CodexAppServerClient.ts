import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import {
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  type CodexMethod,
  type CodexNotification,
  type CodexRequestMap,
  type CodexServerRequest,
  type RequestId,
  type RpcError
} from './protocol'

/**
 * JSON-RPC client for `codex app-server` over stdio (see `protocol.ts` for the wire format).
 *
 * One client owns one process. Requests time out (default 60 s) without killing the process; a
 * process exit, a closed stdout or an oversized line rejects every pending request and aborts
 * `signal`. Lines that are not JSON objects are skipped and counted: a stray log line on stdout
 * must not end a session. Server requests go to one handler whose result (or thrown error) is
 * sent back; with no handler, or for a method it does not know, the server gets "method not
 * found" so it can fail the item instead of waiting.
 */

/** The process boundary the client drives; `spawnCodexAppServer` provides the real one. */
export interface CodexProcess {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface CodexLaunch {
  binary: string
  /** Extra arguments after `app-server`, such as `-c key=value` overrides. */
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

/** A request failed on the server (`error` response). */
export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/** The process ended (or its stdout closed) before the request settled. */
export class CodexAppServerExitedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
    readonly exitSignal: NodeJS.Signals | null = null
  ) {
    super(message)
    this.name = 'CodexAppServerExitedError'
  }
}

/** No response within the request's timeout; the process keeps running. */
export class CodexRpcTimeoutError extends Error {
  constructor(readonly method: string, timeoutMs: number) {
    super(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'CodexRpcTimeoutError'
  }
}

export interface RequestOptions {
  /** Default `CodexAppServerClient.defaultTimeoutMs`; 0 waits indefinitely. */
  timeoutMs?: number
  signal?: AbortSignal
}

export type ServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>

/** The surface the provider service uses; tests substitute it only through `CodexProcess`. */
export interface CodexConnection {
  request<M extends CodexMethod>(
    method: M,
    params: CodexRequestMap[M]['params'],
    options?: RequestOptions
  ): Promise<CodexRequestMap[M]['result']>
  notify(method: string, params?: unknown): void
  onNotification(listener: (notification: CodexNotification) => void): () => void
  setServerRequestHandler(handler: ServerRequestHandler | null): void
  /** Aborted when the process is gone; `reason` is a `CodexAppServerExitedError`. */
  readonly signal: AbortSignal
  close(): void
}

const MAX_LINE_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_BYTES = 4096
const KILL_GRACE_MS = 3_000

export class CodexAppServerClient implements CodexConnection {
  private nextId = 1
  private readonly pending = new Map<
    RequestId,
    { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; cleanup: () => void }
  >()
  private readonly listeners = new Set<(notification: CodexNotification) => void>()
  private serverRequests: ServerRequestHandler | null = null
  private readonly abort = new AbortController()
  private buffer = Buffer.alloc(0)
  private stderrTail = ''
  /** Lines that were not JSON-RPC messages (skipped). */
  malformedLines = 0
  readonly defaultTimeoutMs: number

  constructor(
    private readonly process: CodexProcess,
    options: { defaultTimeoutMs?: number } = {}
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000
    process.stdout.on('data', (chunk: Buffer | string) => this.read(chunk))
    process.stdout.once('end', () => this.terminate('Codex app-server closed its output'))
    process.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    process.stdin.on('error', (error: Error) => this.terminate(`Codex app-server input failed: ${error.message}`))
    process.once('error', (error) => this.terminate(`Codex app-server failed to start: ${error.message}`))
    process.once('exit', (code, signal) =>
      this.terminate(
        `Codex app-server exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ''}`,
        code,
        signal
      )
    )
  }

  get signal(): AbortSignal {
    return this.abort.signal
  }

  /** The last few KiB of stderr, for error reports. */
  get stderr(): string {
    return this.stderrTail
  }

  request<M extends CodexMethod>(
    method: M,
    params: CodexRequestMap[M]['params'],
    options: RequestOptions = {}
  ): Promise<CodexRequestMap[M]['result']> {
    if (this.abort.signal.aborted) return Promise.reject(this.abort.signal.reason)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              cleanup()
              reject(new CodexRpcTimeoutError(method, timeoutMs))
            }, timeoutMs)
          : undefined
      timer?.unref?.()
      const onAbort = (): void => {
        this.pending.delete(id)
        cleanup()
        reject(options.signal!.reason)
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, cleanup })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.abort.signal.aborted) return
    this.write(params === undefined ? { method } : { method, params })
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequests = handler
  }

  /** Ends the process: SIGTERM, then SIGKILL after a grace period. */
  close(): void {
    this.terminate('Codex app-server was closed')
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill()
      const timer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL')
      }, KILL_GRACE_MS)
      timer.unref?.()
    }
  }

  private write(message: unknown): void {
    if (this.abort.signal.aborted) throw this.abort.signal.reason
    this.process.stdin.write(JSON.stringify(message) + '\n')
  }

  private read(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    let end: number
    while ((end = this.buffer.indexOf(10)) !== -1) {
      const line = this.buffer.subarray(0, end).toString('utf8').trim()
      this.buffer = this.buffer.subarray(end + 1)
      if (line) this.dispatch(line)
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = Buffer.alloc(0)
      this.terminate('Codex app-server sent an oversized message')
      this.close()
    }
  }

  private dispatch(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      this.malformedLines += 1
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.malformedLines += 1
      return
    }
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (typeof message.method === 'string') {
      if (hasId) void this.answer({ id: message.id as RequestId, method: message.method, params: message.params })
      else for (const listener of [...this.listeners]) listener({ method: message.method, params: message.params })
      return
    }
    if (!hasId) {
      this.malformedLines += 1
      return
    }
    const pending = this.pending.get(message.id as RequestId)
    if (!pending) return
    this.pending.delete(message.id as RequestId)
    pending.cleanup()
    if (message.error && typeof message.error === 'object') {
      const error = message.error as RpcError
      pending.reject(
        new CodexRpcError(pending.method, Number(error.code), String(error.message ?? 'Codex request failed'), error.data)
      )
    } else pending.resolve(message.result)
  }

  private async answer(request: CodexServerRequest): Promise<void> {
    let reply: { id: RequestId; result?: unknown; error?: RpcError }
    const handler = this.serverRequests
    if (!handler) reply = { id: request.id, error: { code: RPC_METHOD_NOT_FOUND, message: `Unsupported request ${request.method}` } }
    else {
      try {
        reply = { id: request.id, result: await handler(request) }
      } catch (error) {
        reply = {
          id: request.id,
          error: {
            code: error instanceof CodexRpcError ? error.code : RPC_INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
    }
    try {
      this.write(reply)
    } catch {
      /* the process is gone; nothing waits for the answer */
    }
  }

  private terminate(message: string, code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.abort.signal.aborted) return
    const detail = this.stderrTail.trim().split('\n').at(-1)
    const error = new CodexAppServerExitedError(detail && code ? `${message}: ${detail}` : message, code, signal)
    this.abort.abort(error)
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
  }
}

/** Spawns `<binary> app-server [args]` with piped stdio. */
export function spawnCodexAppServer(launch: CodexLaunch): CodexProcess {
  return spawn(launch.binary, ['app-server', ...launch.args], {
    env: launch.env,
    cwd: launch.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

/** TOML literal for a `-c key=value` override (strings, numbers, booleans, arrays and tables). */
export function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(entry)}`)
      .join(', ')} }`
  throw new Error(`Cannot express ${String(value)} as a Codex config value`)
}

/** `-c key=value` arguments for config overrides. */
export function codexConfigArgs(overrides: Record<string, unknown>): string[] {
  return Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`])
}
