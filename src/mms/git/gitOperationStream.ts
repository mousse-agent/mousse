import { redactGitText } from '../../shared/gitText'
import type { GitOperationEvent, GitOperationKind } from '../../shared/types'
import type { GitLine } from './gitProcess'
import type { HookTraceEvent } from './gitTrace'

/** Output is sent at most this often, in one event; a chatty hook cannot flood the connection. */
const DEFAULT_INTERVAL_MS = 100
/** Lines one operation may send in all; past it a single notice says the rest is not shown. */
const DEFAULT_MAX_LINES = 5_000
/** Lines held between two sends; when more arrive, the oldest are dropped. */
const BATCH_LINES = 40
/**
 * UTF-8 bytes held between two sends. A connection event may not exceed 64 KiB in all, and a line of
 * 500 characters can take 1,500 bytes, so the count above is not a bound on its own.
 */
const BATCH_BYTES = 32 * 1024
/** Longest `failed` message; the request's own rejection still carries the full text. */
const MAX_MESSAGE = 4_000

/** Colour and cursor sequences, and the other control characters, which a log view cannot show. */
const TERMINAL_CONTROLS = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g

export interface OperationStreamOptions {
  operationId: string
  kind: GitOperationKind
  path: string
  onEvent?: (event: GitOperationEvent) => void
  intervalMs?: number
  maxLines?: number
}

/**
 * Turns one Git action's output and hook activity into events. Everything leaving here has
 * passed `redactGitText`, so a token in a remote URL never reaches a client; output is
 * batched and rate limited, and a progress line that the next one overwrites (Git ends it
 * with a carriage return) replaces it instead of piling up. A consumer that throws, or a
 * connection that is backed up, never reaches the Git command.
 */
export class OperationStream {
  private pending: string[] = []
  private pendingBytes = 0
  private pendingTransient = false
  /** Lines pushed out of the batch before it was sent. */
  private dropped = 0
  private sent = 0
  private noticed = false
  private lastSend = 0
  private timer: NodeJS.Timeout | undefined
  private ended = false

  constructor(private readonly options: OperationStreamOptions) {}

  private emit(event: Omit<GitOperationEvent, 'operationId' | 'kind' | 'path' | 'at'>): void {
    const { onEvent, operationId, kind, path } = this.options
    if (!onEvent) return
    try {
      onEvent({ operationId, kind, path, at: Date.now(), ...event })
    } catch {
      /* a consumer's failure must not stop the command */
    }
  }

  started(cancellable: boolean): void {
    this.emit({ phase: 'started', cancellable })
  }

  /** The step that changes the folder has begun and can no longer be stopped. */
  integrating(): void {
    if (this.ended) return
    this.flush()
    this.emit({ phase: 'integrating', cancellable: false })
  }

  line(line: GitLine): void {
    if (!this.options.onEvent || this.ended) return
    // `redactGitText` also caps each line at 500 characters, which is what the event type promises.
    const text = redactGitText(line.text.replace(TERMINAL_CONTROLS, '')).trim()
    if (text === '') return
    if (this.sent >= (this.options.maxLines ?? DEFAULT_MAX_LINES)) {
      if (!this.noticed) {
        this.noticed = true
        this.push('The rest of the output is not shown.', false)
        this.schedule()
      }
      return
    }
    // The previous progress line was overwritten by this one.
    if (this.pendingTransient && this.pending.length > 0) this.pendingBytes -= Buffer.byteLength(this.pending.pop()!)
    else this.sent += 1
    this.push(text, line.transient)
    this.schedule()
  }

  private push(text: string, transient: boolean): void {
    this.pending.push(text)
    this.pendingBytes += Buffer.byteLength(text)
    this.pendingTransient = transient
    while (this.pending.length > 1 && (this.pending.length > BATCH_LINES || this.pendingBytes > BATCH_BYTES)) {
      this.pendingBytes -= Buffer.byteLength(this.pending.shift()!)
      this.dropped += 1
    }
  }

  hook(event: HookTraceEvent): void {
    if (!this.options.onEvent || this.ended) return
    this.flush()
    this.emit({ phase: 'hook', hook: { name: event.name, ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }) } })
  }

  /** The last event: whatever output is still held goes first. */
  end(phase: 'done' | 'failed' | 'cancelled', failure?: { message: string; code?: string }): void {
    if (this.ended) return
    this.flush()
    this.ended = true
    this.emit({
      phase,
      ...(failure ? { message: redactGitText(failure.message).slice(0, MAX_MESSAGE), ...(failure.code ? { code: failure.code } : {}) } : {})
    })
  }

  private schedule(): void {
    if (this.timer) return
    const wait = Math.max(0, this.lastSend + (this.options.intervalMs ?? DEFAULT_INTERVAL_MS) - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, wait)
    this.timer.unref?.()
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.length === 0) return
    const lines = this.pending
    // Said once, in the batch that lost lines.
    if (this.dropped > 0) lines.unshift(`… ${this.dropped} ${this.dropped === 1 ? 'line' : 'lines'} not shown`)
    this.pending = []
    this.pendingBytes = 0
    this.pendingTransient = false
    this.dropped = 0
    this.lastSend = Date.now()
    this.emit({ phase: 'output', lines })
  }
}
