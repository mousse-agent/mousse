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

/** The page's input events, by kind: the agent's own input is told apart from the person's by kind alone. */
export type UserInputKind = 'pointer' | 'key'

/**
 * Who is using one in-app tab (`AttachedTabActivity`). The person's input gives them a rolling lease
 * (`USER_ACTIVE_LEASE_MS`), held for as long as the address bar or element picker is in use; input that arrives while
 * an agent step runs preempts that step. Agent input sent through the debugger reaches the guest as input events too:
 * the guest's events of one kind are ignored only while the agent sends input of that kind (`beginSynthetic`), so the
 * person's keys count while the agent clicks, and their clicks while it types. What is left: while one agent input
 * command of a kind is in flight (a few milliseconds each), the person's input of that same kind in the page cannot be
 * told from the agent's and is not counted; their next input, or any input on the window around the page, is.
 */
export class TabActivity {
  private lastInputAt = Number.NEGATIVE_INFINITY
  private readonly pins = new Set<ActivityPin>()
  private busy = 0
  private waiting = 0
  private syntheticPointer = 0
  private syntheticKey = 0
  private hold = false
  private timer: unknown
  private current: AttachedTabActivity = 'idle'
  private disposed = false
  private readonly changeListeners = new Set<(state: AttachedTabActivity) => void>()
  private readonly preemptListeners = new Set<() => void>()

  constructor(private readonly clock: ActivityClock = SYSTEM_ACTIVITY_CLOCK, private readonly leaseMs = USER_ACTIVE_LEASE_MS) {}

  state(): AttachedTabActivity { return this.current }

  /** The person is using the tab: input in the last few seconds, or the address bar or picker in use. */
  userActive(): boolean {
    return this.pins.size > 0 || this.clock.now() - this.lastInputAt < this.leaseMs
  }

  /**
   * A click, wheel or key from the person. `guest` input is the page's own input event of a kind, which the agent's
   * debugger input of that kind also raises; `window` input comes from the app's own surface around the page and is
   * always the person's.
   */
  noteUserInput(origin: 'window'): void
  noteUserInput(origin: 'guest', kind: UserInputKind): void
  noteUserInput(origin: 'guest' | 'window', kind?: UserInputKind): void {
    if (this.disposed) return
    if (origin === 'guest' && (kind === 'key' ? this.syntheticKey : this.syntheticPointer) > 0) return
    this.lastInputAt = this.clock.now()
    this.preemptIfBusy()
    this.refresh()
  }

  /** A navigation nobody's page script started (the person's address bar, back or reload). An agent's own is ignored. */
  noteUserNavigation(): void {
    if (this.disposed || this.busy > 0) return
    this.lastInputAt = this.clock.now()
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

  /** An agent step that changes the page runs: the tab is locked until the returned release. */
  beginAgent(): () => void { return this.counter('busy') }

  /** An agent waits for the person to finish. */
  beginWaiting(): () => void { return this.counter('waiting') }

  /** The agent sends its own input of a kind through the debugger: the guest's events of that kind until release are its own. */
  beginSynthetic(kind: UserInputKind): () => void { return this.counter(kind === 'key' ? 'syntheticKey' : 'syntheticPointer') }

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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.changeListeners.clear()
    this.preemptListeners.clear()
  }

  private counter(kind: 'busy' | 'waiting' | 'syntheticPointer' | 'syntheticKey'): () => void {
    this[kind] += 1
    this.refresh()
    let released = false
    return () => {
      if (released) return
      released = true
      this[kind] -= 1
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
