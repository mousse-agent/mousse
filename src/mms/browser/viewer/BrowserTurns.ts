import { BrowserAutomationError } from '../automation/BrowserSessionManager'

/** Calls that may wait their turn on one browser at once; one more is refused as busy. */
export const MAX_BROWSER_WAITERS = 24
/** The longest one call waits for its turn on a browser before it is refused as busy. */
export const BROWSER_TURN_WAIT_MS = 5 * 60_000
/**
 * The longest one call may hold a browser. The worker broker ends each request at 60 seconds, and the longest call
 * makes four (a new tab listed, opened and listed again, then observed): a little above that, a call that still has not
 * returned is abandoned with an error to its run, and the next one in line goes.
 */
export const BROWSER_TURN_HOLD_MS = 5 * 60_000
/**
 * How long the person's input waits for an agent's call under way before it stops that call and goes: a moment, so an
 * agent's action that Take over already ended can answer how far it got, and well under the half second after which
 * the person's view says "Sending…".
 */
export const OWNER_CUT_IN_MS = 150
/**
 * How long the browser stays the person's after each of their inputs: their next input goes at once, and the agents'
 * calls wait. So a person typing gets the page's pace (each key would otherwise wait out a cut-in), and the agents read
 * in their pauses.
 */
export const OWNER_KEEP_MS = 1_000
/** How long the person's input waits for the call under way before it is refused as busy. */
const PERSON_INPUT_WAIT_MS = 30_000

/** What a browser's turns say, in the words of the browser's user. */
export interface BrowserTurnsText {
  /** A call waited too long, or too many wait. */
  busy(): Error
  /** A waiting call's run ended. */
  ended(): Error
}

const GENERAL_TEXT: BrowserTurnsText = {
  busy: () => new BrowserAutomationError({ code: 'timeout', message: 'The browser is busy with other work right now. Try this again in a moment, or carry on without it.' }),
  ended: () => new BrowserAutomationError({ code: 'cancelled', message: 'This run has ended.' })
}

/**
 * The call that holds a browser now: its tab, whether it gives way to the person's input, and how to stop it.
 * `kept` is no call: the moment after a person's input, when only their next input may take the browser.
 */
interface TurnHolder {
  tab?: string
  yields?: boolean
  kept?: boolean
  stop?(reason: Error): void
}

/**
 * One call at a time on a browser without a window, in the order the calls came. Such a browser paints only its front
 * tab, and both an action and a picture bring their tab to the front; the session also takes one action at a time. So
 * when several agents (or several runs of one bot) browse at once, each call waits for the one before it to end instead
 * of failing or pulling the other's tab away mid-action. The queue is bounded (`MAX_BROWSER_WAITERS`), each wait too
 * (`BROWSER_TURN_WAIT_MS`), and a stopped turn leaves it at once. The holder is bounded as well (`BROWSER_TURN_HOLD_MS`):
 * `work` gets a signal that ends its call there, and the turn passes on even if it ignores it.
 */
export class BrowserTurns {
  private holder: TurnHolder | undefined
  private keptUntil: ReturnType<typeof setTimeout> | undefined
  private readonly waiting: Array<{ go(): void; holder: TurnHolder }> = []

  constructor(private readonly text: BrowserTurnsText = GENERAL_TEXT) {}

  /** The tab the call that holds the browser works on, when it named one. */
  get holderTab(): string | undefined {
    return this.holder?.tab
  }

  get busy(): boolean {
    return this.holder !== undefined
  }

  /**
   * Runs `work` when its turn comes; a wait longer than `waitMs`, a full queue or `signal` refuses it. It holds the turn
   * at most `holdMs`: then its signal ends it and it fails with a timeout, and the next waiter goes.
   *
   * A call that `yields` (an agent's) gives way to one that cuts in (`cutIn`, the person's input): the person's input
   * waits for it `cutIn.afterMs` at most, then that call is stopped with `cutIn.reason()` and the input goes. A call
   * that `keeps` (the person's input) holds the browser that long after it ends, for the next call that goes `first`
   * alone.
   */
  async run<T>(work: (held: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; tab?: string; waitMs?: number; holdMs?: number; busy?: () => Error; first?: boolean; yields?: boolean; cutIn?: { afterMs: number; reason: () => Error }; keepMs?: number } = {}): Promise<T> {
    const holder: TurnHolder = { ...(options.tab ? { tab: options.tab } : {}), ...(options.yields ? { yields: true } : {}) }
    if (this.holder?.kept && options.first) {
      // The person's next input while the browser is still theirs: it goes at once.
      clearTimeout(this.keptUntil)
      this.keptUntil = undefined
      this.holder = undefined
    } else if (this.holder || this.waiting.length) {
      const busy = options.busy ?? this.text.busy
      if (this.waiting.length >= MAX_BROWSER_WAITERS) throw busy()
      await new Promise<void>((resolve, reject) => {
        const entry = { go: () => { cleanup(); resolve() }, holder }
        const leave = (error: Error): void => {
          const at = this.waiting.indexOf(entry)
          if (at < 0) return
          this.waiting.splice(at, 1)
          cleanup()
          reject(error)
        }
        const timer = setTimeout(() => leave(busy()), options.waitMs ?? BROWSER_TURN_WAIT_MS)
        timer.unref?.()
        let cut: ReturnType<typeof setTimeout> | undefined
        const onAbort = (): void => leave(this.text.ended())
        const cleanup = (): void => {
          clearTimeout(timer)
          clearTimeout(cut)
          options.signal?.removeEventListener('abort', onAbort)
        }
        if (options.signal?.aborted) return onAbort()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        // The person's input goes ahead of the calls that wait: it waits only for the one under way.
        if (options.first) this.waiting.unshift(entry)
        else this.waiting.push(entry)
        // And it cuts into an agent's call under way that has not ended after a moment.
        const under = this.holder
        if (options.cutIn && under?.yields) {
          const { afterMs, reason } = options.cutIn
          cut = setTimeout(() => { if (this.holder === under) under.stop?.(reason()) }, afterMs)
          cut.unref?.()
        }
      })
    }
    this.holder = holder
    const hold = new AbortController()
    holder.stop = (reason) => hold.abort(reason)
    const ceiling = setTimeout(() => hold.abort(new BrowserAutomationError({ code: 'timeout', message: 'The browser did not answer in time, so this call stopped. Try it again, or carry on without it.' })), options.holdMs ?? BROWSER_TURN_HOLD_MS)
    ceiling.unref?.()
    const abandoned = new Promise<never>((_resolve, reject) => hold.signal.addEventListener('abort', () => reject(hold.signal.reason), { once: true }))
    try {
      return await Promise.race([work(hold.signal), abandoned])
    } finally {
      clearTimeout(ceiling)
      if (options.keepMs && this.holder === holder) {
        // The person's: theirs a moment longer, for their next input; then the next in line goes.
        const kept: TurnHolder = { ...(options.tab ? { tab: options.tab } : {}), kept: true }
        this.holder = kept
        this.keptUntil = setTimeout(() => {
          if (this.holder !== kept) return
          this.keptUntil = undefined
          this.handOn()
        }, options.keepMs)
        this.keptUntil.unref?.()
      } else this.handOn()
    }
  }

  /**
   * One input of the person who holds the browser, in its turn, so it never lands beside an agent's call: ahead of the
   * calls that wait, and cutting into an agent's call under way once `OWNER_CUT_IN_MS` has passed (that call is refused
   * with `holds()`, as acting is during a hold), so it never waits out an agent's long call either. The browser stays
   * theirs `OWNER_KEEP_MS` after it, so typing goes at the page's pace and the agents read in the pauses. It resolves
   * once the worker applied it.
   */
  personInput<T>(work: (held: AbortSignal) => Promise<T>, options: { tab?: string; holds(): Error; busy(): Error }): Promise<T> {
    return this.run(work, {
      first: true,
      waitMs: PERSON_INPUT_WAIT_MS,
      busy: options.busy,
      cutIn: { afterMs: OWNER_CUT_IN_MS, reason: options.holds },
      keepMs: OWNER_KEEP_MS,
      ...(options.tab ? { tab: options.tab } : {})
    })
  }

  /** The browser is free: the next in line goes; it takes the browser before anything that comes later. */
  private handOn(): void {
    this.holder = undefined
    const next = this.waiting.shift()
    if (next) {
      this.holder = next.holder
      next.go()
    }
  }
}
