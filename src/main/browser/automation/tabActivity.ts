import type { AttachedTabActivity } from '../../../shared/browser/attached'

/** How long a tab stays the person's after their last input. */
export const USER_ACTIVE_LEASE_MS = 3_000

/** The clock and timer a tab's activity runs on; tests pass fakes. */
export interface ActivityClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const SYSTEM_ACTIVITY_CLOCK: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export type ActivityPin = 'address' | 'picker'

/**
 * The page's input events, by kind: the agent's own input is told apart from the person's by kind alone. `wheel` is
 * scrolling (a mouse wheel or a touch scroll), `pointer` a press or touch, `key` a key.
 */
export type UserInputKind = 'pointer' | 'key' | 'wheel'

/**
 * Scrolling goes on after the agent's wheel command returns: Chromium sends the page more wheel events once the command
 * is done. Wheel events this soon after the agent's last wheel (each one moving the window on) are its own, up to
 * `AGENT_WHEEL_TAIL_MAX_MS` after it.
 */
export const AGENT_WHEEL_TAIL_MS = 300
export const AGENT_WHEEL_TAIL_MAX_MS = 1_000

/**
 * Who is using one in-app tab (`AttachedTabActivity`). The person's input gives them a rolling lease
 * (`USER_ACTIVE_LEASE_MS`), held for as long as the address bar or element picker is in use; input that arrives while
 * an agent step runs preempts that step. Agent input sent through the debugger reaches the guest as input events too:
 * the guest's events of one kind are ignored only while the agent sends input of that kind (`beginSynthetic`), and
 * wheel events for a short tail after it (`AGENT_WHEEL_TAIL_MS`), so the person's keys count while the agent clicks,
 * and their clicks while it types or scrolls. What is left: while one agent input command of a kind is in flight (a
 * few milliseconds each), or in the tail after an agent wheel, the person's input of that same kind in the page cannot
 * be told from the agent's and is not counted; their next input, or any input on the window around the page, is.
 *
 * One agent step runs in a tab at a time (`acquireStep`): a second step waits for the first to end.
 */
export class TabActivity {
  private lastInputAt = Number.NEGATIVE_INFINITY
  private readonly pins = new Set<ActivityPin>()
  private busy = 0
  private waiting = 0
  private readonly synthetic: Record<UserInputKind, number> = { pointer: 0, key: 0, wheel: 0 }
  private wheelTailUntil = Number.NEGATIVE_INFINITY
  private wheelTailLimit = Number.NEGATIVE_INFINITY
  private ownNavigation = 0
  private hold = false
  private timer: unknown
  private current: AttachedTabActivity = 'idle'
  private disposed = false
  private stepHeld = false
  private readonly stepWaiters: Array<() => void> = []
  private readonly changeListeners = new Set<(state: AttachedTabActivity) => void>()
  private readonly preemptListeners = new Set<() => void>()

  constructor(private readonly clock: ActivityClock = SYSTEM_ACTIVITY_CLOCK, private readonly leaseMs = USER_ACTIVE_LEASE_MS) {}

  state(): AttachedTabActivity { return this.current }

  /** The person is using the tab: input in the last few seconds, or the address bar or picker in use. A closed tab is nobody's. */
  userActive(): boolean {
    if (this.disposed) return false
    return this.pins.size > 0 || this.clock.now() - this.lastInputAt < this.leaseMs
  }

  /** The address bar or element picker is in use on this tab. */
  pinned(): boolean { return !this.disposed && this.pins.size > 0 }

  /**
   * A click, wheel or key from the person. `guest` input is the page's own input event of a kind, which the agent's
   * debugger input of that kind also raises; `window` input comes from the app's own surface around the page and is
   * always the person's.
   */
  noteUserInput(origin: 'window'): void
  noteUserInput(origin: 'guest', kind: UserInputKind): void
  noteUserInput(origin: 'guest' | 'window', kind?: UserInputKind): void {
    if (this.disposed) return
    if (origin === 'guest' && kind && this.agentInput(kind)) return
    this.lastInputAt = this.clock.now()
    this.preemptIfBusy()
    this.refresh()
  }

  /** A navigation nobody's page script started (the person's address bar, back or reload). The agent's own is ignored. */
  noteUserNavigation(): void {
    if (this.disposed || this.ownNavigation > 0) return
    this.lastInputAt = this.clock.now()
    this.preemptIfBusy()
    this.refresh()
  }

  pin(kind: ActivityPin): void {
    if (this.disposed) return
    this.pins.add(kind)
    this.lastInputAt = this.clock.now()
    this.preemptIfBusy()
    this.refresh()
  }

  /** The lease runs on for its full length after the address bar or picker is left. */
  unpin(kind: ActivityPin): void {
    if (this.disposed || !this.pins.delete(kind)) return
    this.lastInputAt = this.clock.now()
    this.refresh()
  }

  /**
   * The one agent step in this tab: resolves with its release once no other step runs here (first come, first served).
   * Rejects with the signal's reason when it is aborted while waiting.
   */
  acquireStep(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return }
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        this.stepHeld = true
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.stepHeld = false
          this.stepWaiters.shift()?.()
        })
      }
      const onAbort = () => {
        const index = this.stepWaiters.indexOf(grant)
        if (index >= 0) this.stepWaiters.splice(index, 1)
        reject(signal!.reason)
      }
      if (!this.stepHeld && !this.stepWaiters.length) { grant(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.stepWaiters.push(grant)
    })
  }

  /** An agent step that changes the page runs: the tab shows it locked until the returned release. */
  beginAgent(): () => void { return this.counter(() => this.busy++, () => this.busy--) }

  /** An agent waits for the person to finish. */
  beginWaiting(): () => void { return this.counter(() => this.waiting++, () => this.waiting--) }

  /** The agent sends its own input of a kind through the debugger: the guest's events of that kind until release are its own. */
  beginSynthetic(kind: UserInputKind): () => void {
    return this.counter(() => this.synthetic[kind]++, () => {
      this.synthetic[kind]--
      if (kind === 'wheel') {
        const now = this.clock.now()
        this.wheelTailUntil = now + AGENT_WHEEL_TAIL_MS
        this.wheelTailLimit = now + AGENT_WHEEL_TAIL_MAX_MS
      }
    })
  }

  /** The agent's own navigation (a URL it loads, or its back, forward or reload) is under way until the release. */
  beginOwnNavigation(): () => void { return this.counter(() => this.ownNavigation++, () => this.ownNavigation--) }

  /** `browser_request_human`: the tab is the person's until they hand it back. */
  setHumanHold(hold: boolean): void {
    if (this.disposed || this.hold === hold) return
    this.hold = hold
    this.refresh()
  }

  onChange(listener: (state: AttachedTabActivity) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /** Called when the person's input arrives while an agent step runs. */
  onPreempt(listener: () => void): () => void {
    this.preemptListeners.add(listener)
    return () => { this.preemptListeners.delete(listener) }
  }

  /** The tab is gone: its pins and lease go with it. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pins.clear()
    this.lastInputAt = Number.NEGATIVE_INFINITY
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.changeListeners.clear()
    this.preemptListeners.clear()
  }

  /** Whether a page input event of this kind is the agent's own. */
  private agentInput(kind: UserInputKind): boolean {
    if (this.synthetic[kind] > 0) return true
    if (kind !== 'wheel') return false
    const now = this.clock.now()
    if (now >= this.wheelTailUntil) return false
    // The scroll is still settling: the next of its events may come a little later.
    this.wheelTailUntil = Math.min(now + AGENT_WHEEL_TAIL_MS, this.wheelTailLimit)
    return true
  }

  private counter(enter: () => void, leave: () => void): () => void {
    enter()
    this.refresh()
    let released = false
    return () => {
      if (released) return
      released = true
      leave()
      this.refresh()
    }
  }

  private preemptIfBusy(): void {
    if (this.busy === 0) return
    for (const listener of [...this.preemptListeners]) {
      try { listener() } catch { /* listener isolation */ }
    }
  }

  private compute(): AttachedTabActivity {
    if (this.hold) return 'waiting-human'
    if (this.busy > 0) return 'agent-busy'
    if (this.waiting > 0) return 'agent-waiting'
    return this.userActive() ? 'user-active' : 'idle'
  }

  private refresh(): void {
    if (this.disposed) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    // The lease ends on its own: the state is read again then.
    if (this.pins.size === 0 && this.userActive()) {
      const remaining = Math.max(1, this.lastInputAt + this.leaseMs - this.clock.now())
      this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.refresh() }, remaining)
    }
    const next = this.compute()
    if (next === this.current) return
    this.current = next
    for (const listener of [...this.changeListeners]) {
      try { listener(next) } catch { /* listener isolation */ }
    }
  }
}
