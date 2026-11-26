/**
 * A window shows a thread of another computer that cannot be reached (offline, not answering, refusing): reading it
 * again at once fails the same way. Main then waits before the next read of that thread: 2 s, doubling up to a minute,
 * or sooner when the computer may be back (a network change, an update from the thread itself), but never sooner than
 * `wakeMinMs` after the last try. Meanwhile a gap in the window's updates reads only every thread's status.
 */
export const COMPUTER_WAIT_FIRST_MS = 2_000
export const COMPUTER_WAIT_MAX_MS = 60_000
export const COMPUTER_WAKE_MIN_MS = 1_000

export interface ComputerWaitOptions {
  /** The wait for the window's read of `threadId` is over: read it once. */
  onRetry: (windowId: number, threadId: string) => void
  firstMs?: number
  maxMs?: number
  wakeMinMs?: number
  now?: () => number
}

interface Waiting {
  threadId: string
  attempts: number
  triedAt: number
  dueAt: number
  timer?: ReturnType<typeof setTimeout>
}

export class ComputerWait {
  private readonly windows = new Map<number, Waiting>()
  private readonly firstMs: number
  private readonly maxMs: number
  private readonly wakeMinMs: number
  private readonly now: () => number

  constructor(private readonly options: ComputerWaitOptions) {
    this.firstMs = options.firstMs ?? COMPUTER_WAIT_FIRST_MS
    this.maxMs = Math.max(this.firstMs, options.maxMs ?? COMPUTER_WAIT_MAX_MS)
    this.wakeMinMs = options.wakeMinMs ?? COMPUTER_WAKE_MIN_MS
    this.now = options.now ?? Date.now
  }

  /** The window's read of `threadId` just failed because its computer cannot be reached. Returns the wait before the next one. */
  failed(windowId: number, threadId: string): number {
    const previous = this.windows.get(windowId)
    if (previous?.timer) clearTimeout(previous.timer)
    const attempts = previous?.threadId === threadId ? previous.attempts + 1 : 1
    const delay = Math.min(this.maxMs, this.firstMs * 2 ** Math.min(attempts - 1, 30))
    const now = this.now()
    const waiting: Waiting = { threadId, attempts, triedAt: now, dueAt: now + delay }
    this.windows.set(windowId, waiting)
    this.schedule(windowId, waiting, delay)
    return delay
  }

  /** Whether the window's reads of `threadId` wait for its computer. */
  waiting(windowId: number, threadId: string | null | undefined): boolean {
    return Boolean(threadId) && this.windows.get(windowId)?.threadId === threadId
  }

  /** The computer may be back: read the thread now, or `wakeMinMs` after the last try if that is later. */
  wake(windowId: number): void {
    const waiting = this.windows.get(windowId)
    if (!waiting) return
    const at = Math.max(this.now(), waiting.triedAt + this.wakeMinMs)
    if (at >= waiting.dueAt) return
    if (waiting.timer) clearTimeout(waiting.timer)
    waiting.dueAt = at
    this.schedule(windowId, waiting, at - this.now())
  }

  /** The thread was read, the window shows another one, or it closed. */
  clear(windowId: number): void {
    const waiting = this.windows.get(windowId)
    if (waiting?.timer) clearTimeout(waiting.timer)
    this.windows.delete(windowId)
  }

  private schedule(windowId: number, waiting: Waiting, delay: number): void {
    const timer = setTimeout(() => {
      if (this.windows.get(windowId) !== waiting) return
      waiting.timer = undefined
      // Until the read answers, a wake has nothing to bring forward.
      waiting.dueAt = Number.POSITIVE_INFINITY
      waiting.triedAt = this.now()
      this.options.onRetry(windowId, waiting.threadId)
    }, Math.max(0, delay))
    ;(timer as { unref?: () => void }).unref?.()
    waiting.timer = timer
  }
}
