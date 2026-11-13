/**
 * Notices a window whose shown turn looks active but has had no update for a while, so main can ask the service
 * whether that turn is really still running (#1042).
 *
 * The first check comes `quietMs` after the last update. A check that finds the turn really running and the window up
 * to date doubles the wait before the next one, up to `maxQuietMs`; any update about the thread, or a check that
 * changed something, starts again from `quietMs`. A model that thinks or runs a tool silently for ten minutes costs
 * four small status reads (30 s after its last update, then 1, 2 and 4 minutes after each check), never a stream.
 */
export const QUIET_TURN_MS = 30_000
export const QUIET_TURN_MAX_MS = 5 * 60_000

export interface QuietTurnWatchOptions {
  /** Called when a window's active-looking turn has been quiet for its current wait. */
  onQuiet: (windowId: number, threadId: string, quietForMs: number) => void
  quietMs?: number
  maxQuietMs?: number
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

interface Watched {
  threadId: string | null
  active: boolean
  lastUpdate: number
  wait: number
  timer: unknown
  checking: boolean
}

export class QuietTurnWatch {
  private readonly windows = new Map<number, Watched>()
  private readonly quietMs: number
  private readonly maxQuietMs: number
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly options: QuietTurnWatchOptions) {
    this.quietMs = options.quietMs ?? QUIET_TURN_MS
    this.maxQuietMs = Math.max(this.quietMs, options.maxQuietMs ?? QUIET_TURN_MAX_MS)
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      ;(timer as { unref?: () => void }).unref?.()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** The wait before the next check of a window, for tests and the log. */
  waitOf(windowId: number): number | undefined {
    return this.windows.get(windowId)?.wait
  }

  isArmed(windowId: number): boolean {
    const watched = this.windows.get(windowId)
    return Boolean(watched && watched.timer !== null && watched.timer !== undefined)
  }

  /**
   * What the window shows and whether its turn looks active there. A new thread starts its wait afresh; the same
   * thread keeps its last update time and its wait.
   */
  setShown(windowId: number, threadId: string | null, active: boolean): void {
    let watched = this.windows.get(windowId)
    if (!watched) {
      watched = { threadId, active: false, lastUpdate: this.now(), wait: this.quietMs, timer: null, checking: false }
      this.windows.set(windowId, watched)
    }
    if (watched.threadId !== threadId) {
      watched.threadId = threadId
      watched.lastUpdate = this.now()
      watched.wait = this.quietMs
      this.disarm(watched)
    }
    const looksActive = Boolean(threadId) && active
    if (looksActive && !watched.active) {
      // A turn that has just started counts from now, not from the last update of the turn before it.
      watched.lastUpdate = this.now()
      watched.wait = this.quietMs
    }
    watched.active = looksActive
    if (!looksActive) this.disarm(watched)
    else this.arm(windowId, watched)
  }

  /** An update about the window's shown thread arrived: the turn is not quiet. */
  touch(windowId: number, threadId: string | undefined): void {
    const watched = this.windows.get(windowId)
    if (!watched || !threadId || watched.threadId !== threadId) return
    watched.lastUpdate = this.now()
    watched.wait = this.quietMs
    if (watched.active && !watched.checking) {
      this.disarm(watched)
      this.arm(windowId, watched)
    }
  }

  /**
   * A check of the window ended. The wait doubles whatever it found: a turn still active after it is really running
   * (a catch-up applied what the service has), and only a real update brings the wait back to the shortest. So a
   * window that keeps disagreeing with the service for any reason is checked less and less often, never in a loop.
   */
  checked(windowId: number): void {
    const watched = this.windows.get(windowId)
    if (!watched) return
    watched.checking = false
    watched.wait = Math.min(this.maxQuietMs, watched.wait * 2)
    watched.lastUpdate = this.now()
    this.disarm(watched)
    if (watched.active) this.arm(windowId, watched)
  }

  forget(windowId: number): void {
    const watched = this.windows.get(windowId)
    if (watched) this.disarm(watched)
    this.windows.delete(windowId)
  }

  dispose(): void {
    for (const watched of this.windows.values()) this.disarm(watched)
    this.windows.clear()
  }

  private arm(windowId: number, watched: Watched): void {
    if (watched.checking || (watched.timer !== null && watched.timer !== undefined) || !watched.threadId) return
    const due = Math.max(0, watched.lastUpdate + watched.wait - this.now())
    watched.timer = this.setTimer(() => {
      watched.timer = null
      if (!watched.active || !watched.threadId || this.windows.get(windowId) !== watched) return
      watched.checking = true
      this.options.onQuiet(windowId, watched.threadId, this.now() - watched.lastUpdate)
    }, due)
  }

  private disarm(watched: Watched): void {
    if (watched.timer !== null && watched.timer !== undefined) this.clearTimer(watched.timer)
    watched.timer = null
  }
}
