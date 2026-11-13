/**
 * The window side's own log of its link to the service: `<home>/logs/gui-connection.log`, beside the service's
 * `daemon.log`. One JSON object a line: when the app connected, lost and regained the service, each window's
 * subscription, updates main could not hand to a window, and each catch-up it ran (which thread, why, what changed).
 *
 * Lines hold ids, counts, phases, reasons, and an error's class and code only: never an error's text (it can carry a
 * path or a line of the service's output), conversation text or thread names. Any text that still names the home
 * folder has it replaced by `<home>`. The file rotates at 1 MB and keeps two older files, so it never holds more than
 * about 3 MB.
 */
import { homedir } from 'os'
import { join } from 'path'
import { RotatingFileLog } from '../../mms/log/rotatingFileLog'

export const GUI_CONNECTION_LOG_RELATIVE_PATH = join('logs', 'gui-connection.log')
export const GUI_CONNECTION_LOG_MAX_BYTES = 1_000_000
export const GUI_CONNECTION_LOG_KEEP = 2
/** Updates main could not deliver are counted and written at most this often per window and reason. */
export const UNDELIVERED_SUMMARY_MS = 10_000

export type GuiConnectionLogValue = string | number | boolean | null | undefined | string[]
export type GuiConnectionLogFields = Record<string, GuiConnectionLogValue>

export interface GuiConnectionLogSink {
  write(event: string, fields?: GuiConnectionLogFields): void
}

const MAX_TEXT = 160

/** An error code worth keeping: a short identifier (`ECONNRESET`, `thread_not_found`), never a sentence. */
const CODE = /^[A-Za-z][\w.-]{0,63}$/

/**
 * An error as its class and code (`Error:ECONNRESET`, `MmsProtocolError:thread_not_found`). The message is left out:
 * a service that cannot start reports its home folder and the last lines of its output there.
 */
export function describeLinkError(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? 'string' : 'unknown'
  const name = (error as { name?: unknown }).name
  const kind = typeof name === 'string' && CODE.test(name) ? name : (error as object).constructor?.name ?? 'Error'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && CODE.test(code) ? `${kind}:${code}` : typeof code === 'number' ? `${kind}:${code}` : kind
}

/** The home folder, as it can appear in a path: either slash, and on Windows any case. */
function homePattern(home: string): RegExp | null {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed.length < 2) return null
  const escaped = trimmed.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]')
  return new RegExp(escaped, process.platform === 'win32' || process.platform === 'darwin' ? 'gi' : 'g')
}

let homeRegex: RegExp | null | undefined
function withoutHome(text: string): string {
  if (homeRegex === undefined) {
    try {
      homeRegex = homePattern(homedir())
    } catch {
      homeRegex = null
    }
  }
  return homeRegex ? text.replace(homeRegex, '<home>') : text
}

function clip(text: string): string {
  const scrubbed = withoutHome(text)
  return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}…` : scrubbed
}

function clean(fields: GuiConnectionLogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    out[key] = typeof value === 'string' ? clip(value) : Array.isArray(value) ? value.slice(0, 20).map(clip) : value
  }
  return out
}

export class GuiConnectionLog implements GuiConnectionLogSink {
  readonly path: string
  private readonly file: RotatingFileLog
  private readonly now: () => number
  /** Undelivered updates waiting for their summary line, by window and reason. */
  private readonly undelivered = new Map<string, { window: number; reason: string; count: number; types: Set<string>; threads: Set<string>; first: number }>()
  private summaryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(homeDir: string, options: { maxBytes?: number; keep?: number; now?: () => number; file?: RotatingFileLog } = {}) {
    this.path = join(homeDir, GUI_CONNECTION_LOG_RELATIVE_PATH)
    this.now = options.now ?? Date.now
    this.file = options.file ?? new RotatingFileLog({
      path: this.path,
      maxBytes: options.maxBytes ?? GUI_CONNECTION_LOG_MAX_BYTES,
      keep: options.keep ?? GUI_CONNECTION_LOG_KEEP,
      flushIntervalMs: 500
    })
  }

  write(event: string, fields: GuiConnectionLogFields = {}): void {
    try {
      this.file.write(JSON.stringify({ t: new Date(this.now()).toISOString(), event, ...clean(fields) }))
    } catch {
      // Diagnostics never take main down.
    }
  }

  /**
   * An update main could not hand to a window. A burst (a streaming reply while the window's connection is being
   * replaced) becomes one line per window and reason, with how many, of which types, for which threads.
   */
  undeliverable(window: number, reason: string, type: string, threadId?: string): void {
    const key = `${window}\u0000${reason}`
    let entry = this.undelivered.get(key)
    if (!entry) {
      entry = { window, reason, count: 0, types: new Set(), threads: new Set(), first: this.now() }
      this.undelivered.set(key, entry)
    }
    entry.count += 1
    if (entry.types.size < 20) entry.types.add(type)
    if (threadId && entry.threads.size < 20) entry.threads.add(threadId)
    if (!this.summaryTimer) {
      this.summaryTimer = setTimeout(() => this.flushUndelivered(), UNDELIVERED_SUMMARY_MS)
      this.summaryTimer.unref?.()
    }
  }

  /** Writes the waiting summary lines now. */
  flushUndelivered(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer)
    this.summaryTimer = null
    for (const entry of this.undelivered.values()) {
      this.write('update.undelivered', {
        window: entry.window,
        reason: entry.reason,
        count: entry.count,
        types: [...entry.types],
        threads: [...entry.threads],
        sinceMs: this.now() - entry.first
      })
    }
    this.undelivered.clear()
  }

  flush(): Promise<void> {
    this.flushUndelivered()
    return this.file.flush()
  }

  flushSync(): void {
    this.flushUndelivered()
    this.file.flushSync()
  }
}
