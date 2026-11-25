/**
 * Gives the service's spare heap back to the system once no turn has run for a while.
 *
 * While a reply streams, V8 grows the young generation of the heap to its largest size (64 MB) and keeps it there: an
 * ordinary collection never shrinks it, and the service, which always does a little (timers, polls, sync), rarely looks
 * idle enough for V8's own memory reducer. A service that had run for 8 hours sat at about 400 MB with its heap 179 MB
 * large and 112 MB used; one memory-reducing collection took the heap to 114 MB and the process down by 77 MB.
 *
 * So, once the service has had no turn for `IDLE_TRIM_AFTER_MS` and the heap holds at least `IDLE_TRIM_MIN_SLACK_BYTES`
 * more than it uses, it runs that collection, at most once per `IDLE_TRIM_MIN_GAP_MS`. It is the one the DevTools
 * "Collect garbage" button runs, asked for through an in-process inspector session (no port is opened). It pauses the
 * service for a few tens of milliseconds and drops nothing that is still in use.
 */
import { Session } from 'node:inspector'
import { getHeapStatistics } from 'node:v8'

/** How long no turn must have run before the heap is trimmed. */
export const IDLE_TRIM_AFTER_MS = 3 * 60_000
/** How often idleness is checked. */
export const IDLE_TRIM_CHECK_MS = 60_000
/** The least time between two trims, however long the service stays idle. */
export const IDLE_TRIM_MIN_GAP_MS = 15 * 60_000
/** A heap with less room than this between its size and its use is left alone: a trim would give back too little. */
export const IDLE_TRIM_MIN_SLACK_BYTES = 32 * 1024 * 1024

export interface IdleMemoryTrimOptions {
  /** Turns running now, across every profile the service holds. */
  activeTurns: () => number
  /** The heap's size and use; V8's by default. */
  heap?: () => { totalBytes: number; usedBytes: number }
  /** The memory-reducing collection; an inspector session's `HeapProfiler.collectGarbage` by default. */
  reduce?: () => Promise<void>
  now?: () => number
  afterMs?: number
  checkMs?: number
  minGapMs?: number
  minSlackBytes?: number
}

function v8Heap(): { totalBytes: number; usedBytes: number } {
  const stats = getHeapStatistics()
  return { totalBytes: stats.total_heap_size, usedBytes: stats.used_heap_size }
}

/** Runs V8's memory-reducing collection, which also shrinks the young generation and frees empty pages. */
export function reduceHeap(): Promise<void> {
  return new Promise((resolve, reject) => {
    const session = new Session()
    session.connect()
    session.post('HeapProfiler.collectGarbage', (error) => {
      // Not from inside the callback: a disconnect there waits on the dispatch that is running it, and the thread
      // never returns (seen with Node 24).
      setImmediate(() => {
        session.disconnect()
        if (error) reject(error)
        else resolve()
      })
    })
  })
}

export class IdleMemoryTrim {
  private readonly activeTurns: () => number
  private readonly heap: () => { totalBytes: number; usedBytes: number }
  private readonly reduce: () => Promise<void>
  private readonly now: () => number
  private readonly afterMs: number
  private readonly checkMs: number
  private readonly minGapMs: number
  private readonly minSlackBytes: number
  private idleSince: number | null = null
  private lastTrim = Number.NEGATIVE_INFINITY
  private running = false
  /** Set after a trim fails (no inspector in this build): the service does not try again. */
  private broken = false
  private timer: ReturnType<typeof setInterval> | null = null
  readonly counters = { trims: 0, failures: 0 }

  constructor(options: IdleMemoryTrimOptions) {
    this.activeTurns = options.activeTurns
    this.heap = options.heap ?? v8Heap
    this.reduce = options.reduce ?? reduceHeap
    this.now = options.now ?? Date.now
    this.afterMs = options.afterMs ?? IDLE_TRIM_AFTER_MS
    this.checkMs = options.checkMs ?? IDLE_TRIM_CHECK_MS
    this.minGapMs = options.minGapMs ?? IDLE_TRIM_MIN_GAP_MS
    this.minSlackBytes = options.minSlackBytes ?? IDLE_TRIM_MIN_SLACK_BYTES
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.check() }, this.checkMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Trims the heap when the service has been idle long enough and has enough to give back. True when it trimmed. */
  async check(): Promise<boolean> {
    const now = this.now()
    if (this.activeTurns() > 0) {
      this.idleSince = null
      return false
    }
    this.idleSince ??= now
    if (this.broken || this.running || now - this.idleSince < this.afterMs || now - this.lastTrim < this.minGapMs) return false
    const { totalBytes, usedBytes } = this.heap()
    if (totalBytes - usedBytes < this.minSlackBytes) return false
    this.running = true
    this.lastTrim = now
    try {
      await this.reduce()
      this.counters.trims += 1
      return true
    } catch {
      this.counters.failures += 1
      this.broken = true
      return false
    } finally {
      this.running = false
    }
  }
}
