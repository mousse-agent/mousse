/**
 * Keeping the computer awake while runs work. The background service counts the runs that are working (in profiles
 * that keep the computer awake) and sends the count to the app as the installation event `power.activeRuns`. The
 * app's main process holds the sleep blocker; while no app is attached, the service holds it itself.
 */

/** The app asks for `power.activeRuns` events and holds the blocker itself while it is attached. */
export const KEEP_AWAKE_CAPABILITY = 'power.keep-awake.v1'

/** The installation event that carries `{ active }`: how many runs are working now. */
export const ACTIVE_RUNS_EVENT = 'power.activeRuns'

/** How long the blocker is kept after the last run ends, so back-to-back turns do not release and take it again. */
export const KEEP_AWAKE_GRACE_MS = 90_000

/** What holds the computer awake: Electron's power save blocker, or a fake in tests. */
export interface SleepBlocker {
  start(): void
  stop(): void
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Holds `blocker` while runs work, and for `graceMs` after the last one ends. Work that starts again inside the grace
 * keeps the same hold.
 */
export class SleepHold {
  private held = false
  private grace: unknown = null

  constructor(
    private readonly blocker: SleepBlocker,
    private readonly graceMs = KEEP_AWAKE_GRACE_MS,
    private readonly timers: Timers = realTimers
  ) {}

  get holding(): boolean {
    return this.held
  }

  /** Runs are working (`true`) or none is (`false`). */
  update(working: boolean): void {
    if (working) {
      this.cancelGrace()
      if (!this.held) {
        this.held = true
        this.blocker.start()
      }
      return
    }
    if (!this.held || this.grace !== null) return
    this.grace = this.timers.setTimeout(() => {
      this.grace = null
      this.release()
    }, this.graceMs)
  }

  /** Lets the computer sleep now, without the grace: the app took over, or the setting was turned off. */
  release(): void {
    this.cancelGrace()
    if (!this.held) return
    this.held = false
    this.blocker.stop()
  }

  private cancelGrace(): void {
    if (this.grace === null) return
    this.timers.clearTimeout(this.grace)
    this.grace = null
  }
}

/** Electron's `powerSaveBlocker`, kept to one blocker id. `prevent-app-suspension` blocks system sleep, not the screen. */
export function electronSleepBlocker(power: {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}): SleepBlocker {
  let id: number | null = null
  return {
    start() {
      if (id === null) id = power.start('prevent-app-suspension')
    },
    stop() {
      if (id === null) return
      power.stop(id)
      id = null
    }
  }
}

/** The run count an `power.activeRuns` event carries, or undefined when it is not one. */
export function activeRunsOf(data: unknown): number | undefined {
  const active = (data as { active?: unknown } | null)?.active
  return typeof active === 'number' && Number.isFinite(active) && active >= 0 ? active : undefined
}
