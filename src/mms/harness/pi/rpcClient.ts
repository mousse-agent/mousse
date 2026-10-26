import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from '@earendil-works/pi-coding-agent'

/**
 * The client side of Pi's RPC mode (`pi --mode rpc`, pinned 0.85.1): commands go to the child's
 * stdin as JSON lines with an `id`, and its stdout carries the matching responses and every event.
 *
 * It owns framing and correlation only. It has no timers: deadlines, Stop and the tree kill belong
 * to the gateway (`supervise.ts`), which passes an abort signal per command.
 */

export type PiRpcCommandType = RpcCommand['type']
/** A command without its `id`; the client assigns one. */
export type PiRpcRequest = RpcCommand extends infer Command ? Command extends unknown ? Omit<Command, 'id'> : never : never
/** What a successful response to `T` carries (`undefined` for commands that answer with no data). */
export type PiRpcResult<T extends PiRpcCommandType> =
  Extract<RpcResponse, { command: T; success: true }> extends { data: infer Data } ? Data : undefined

/** Any line on stdout that is not a response: agent and session events, `extension_ui_request`, `extension_error`. */
export interface PiRpcEvent {
  type: string
  [key: string]: unknown
}

export interface PiRpcExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** The process could not start or its pipes failed (`spawn ENOENT`, `EPIPE`). */
  error?: string
}

export type PiRpcErrorCode =
  /** The caller's signal aborted the command; nothing more was sent. */
  | 'aborted'
  /** Pi answered `success: false`; the message is Pi's. */
  | 'rejected'
  /** The process exited before answering, or had already exited. */
  | 'exited'

export class PiRpcError extends Error {
  constructor(readonly code: PiRpcErrorCode, readonly command: string, message: string) {
    super(message)
    this.name = 'PiRpcError'
  }
}

/** The child as the client needs it: `ChildProcess` satisfies it, and so does a test double. */
export interface PiRpcChild extends EventEmitter {
  stdin: Writable | null
  stdout: Readable | null
}

export interface PiRpcHandlers {
  event?(event: PiRpcEvent): void
  /** A line that is not a JSON object, or a response Pi could not attach to a command (`parse`). */
  protocol?(text: string): void
  /** Called exactly once, after every response already on stdout has been read. */
  exit?(exit: PiRpcExit): void
}

interface Pending {
  command: string
  resolve(data: unknown): void
  reject(error: PiRpcError): void
}

/**
 * Splits a byte stream into records on LF only. JSON strings may hold U+2028 and U+2029, which
 * readline treats as line ends, so it is not used. A CR before the LF is dropped.
 */
export function readJsonLines(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const emit = (line: string) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      emit(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    buffer += decoder.end()
    if (buffer) emit(buffer)
    buffer = ''
  })
}

export class PiRpcClient {
  /** Settles once, with the same value `handlers.exit` receives. */
  readonly exited: Promise<PiRpcExit>
  private readonly pending = new Map<string, Pending>()
  private sequence = 0
  private exitInfo: PiRpcExit | undefined
  private resolveExited!: (exit: PiRpcExit) => void
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private ended = false

  constructor(private readonly child: PiRpcChild, private readonly handlers: PiRpcHandlers = {}) {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })
    if (!child.stdin || !child.stdout) throw new Error('Pi RPC needs piped stdin and stdout')
    // A write after the child died fails asynchronously (EPIPE); the exit settles the commands.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    readJsonLines(child.stdout, (line) => this.line(line))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitCode = code
      this.exitSignal = signal
    })
    // `close` follows `exit` once stdout has ended, so every response already written is read first.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      this.finish({ code: this.exitCode ?? code, signal: this.exitSignal ?? signal }))
    child.on('error', (error: Error) => this.finish({ code: null, signal: null, error: error.message }))
  }

  /** Whether the process has exited (every later command rejects as `exited`). */
  get closed(): boolean {
    return this.exitInfo !== undefined
  }

  /**
   * Sends one command and resolves with its response data. An abort rejects this command as
   * `aborted` and does nothing more: a response that arrives later is dropped.
   */
  send<C extends PiRpcRequest>(command: C, options: { signal?: AbortSignal } = {}): Promise<PiRpcResult<C['type']>> {
    const type = command.type
    if (this.exitInfo || this.ended) return Promise.reject(new PiRpcError('exited', type, `Pi exited before ${type}`))
    if (options.signal?.aborted) return Promise.reject(new PiRpcError('aborted', type, `${type} was aborted`))
    this.sequence += 1
    const id = `mousse-${this.sequence}`
    return new Promise<PiRpcResult<C['type']>>((resolve, reject) => {
      const signal = options.signal
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        reject(new PiRpcError('aborted', type, `${type} was aborted`))
      }
      this.pending.set(id, {
        command: type,
        resolve: (data) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(data as PiRpcResult<C['type']>)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.write({ ...command, id })
    })
  }

  /** Answers an `extension_ui_request` (no response follows). */
  respond(response: RpcExtensionUIResponse): void {
    if (!this.exitInfo && !this.ended) this.write(response)
  }

  /** Ends stdin; Pi shuts down when its input ends. Killing the tree is the caller's. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.child.stdin?.end()
  }

  private write(value: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(value)}\n`)
  }

  private line(line: string): void {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.handlers.protocol?.(line)
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { type?: unknown }).type !== 'string') {
      this.handlers.protocol?.(line)
      return
    }
    const record = value as PiRpcEvent
    if (record.type !== 'response') {
      this.handlers.event?.(record)
      return
    }
    const id = typeof record.id === 'string' ? record.id : undefined
    const pending = id ? this.pending.get(id) : undefined
    if (!pending) {
      // A response to an aborted command is dropped; one Pi could not attach to a command is reported.
      if (!id) this.handlers.protocol?.(line)
      return
    }
    this.pending.delete(id!)
    if (record.success === true) pending.resolve(record.data)
    else pending.reject(new PiRpcError('rejected', pending.command, typeof record.error === 'string' ? record.error : `${pending.command} failed`))
  }

  private finish(exit: PiRpcExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new PiRpcError('exited', entry.command, `Pi exited before answering ${entry.command}`))
    this.resolveExited(exit)
    this.handlers.exit?.(exit)
  }
}
