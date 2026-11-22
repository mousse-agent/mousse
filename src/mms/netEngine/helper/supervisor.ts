import { engineLimits } from '../limits'
import { helperCode } from './appChannel'
import { helperBuildMatches } from './process'
import type { EngineHelper } from './connections'
import type { LaunchedHelper } from './process'

/** Where a profile's helper is (design §1); `text` is what the networking switch shows. */
export type HelperStatus =
  | { state: 'off' }
  | { state: 'not_in_build'; text: string }
  /** `step`: `launch` while the process starts, `hello` while it says who it is. */
  | { state: 'starting'; step?: 'launch' | 'hello' }
  | { state: 'running'; generation: number; paused?: string; text?: string }
  | { state: 'restarting'; inMs: number; text?: string; reason?: string }
  | { state: 'mismatch'; text: string }

export const HELPER_TEXT = {
  notInBuild: 'Not in this build',
  anotherRunning: 'Another helper is still running',
  keepsStopping: 'Networking helper keeps stopping (retrying)',
  mismatch: "Networking helper doesn't match this app",
  paused: 'Paused until a removal is saved'
} as const

/** A launch that found no helper binary. */
export class HelperNotInBuild extends Error {
  constructor() {
    super(HELPER_TEXT.notInBuild)
  }
}

const LOCK_HELD = /another process is already running this endpoint/i

/**
 * Runs one profile's helper: starts it, says hello through `use`, starts it again when it exits without being
 * asked (0.5 s doubling to 5 min, then every 5 min; from the first again after a minute up), and shuts it down
 * (`shutdown`, then a kill after 3 s). Each start is a new generation with its own channel, so nothing from an
 * earlier one reaches the current one.
 */
export class HelperSupervisor {
  private generation = 0
  private current?: { generation: number; launched: LaunchedHelper; helper?: EngineHelper }
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  /** Exits in a row without a good minute up between them. */
  private failures = 0
  private fastExits = 0
  /** When a start first found the endpoint held by another helper, while it still is. */
  private lockedSince?: number
  private statusNow: HelperStatus = { state: 'off' }
  private readonly listeners: Array<(status: HelperStatus) => void> = []

  constructor(
    private readonly deps: {
      launch(): Promise<LaunchedHelper>
      /** Says hello over the new helper's pipe; answers the app's view of it. */
      use(pipe: LaunchedHelper['pipe']): Promise<EngineHelper>
      /**
       * The helper speaks another major version, or is not the build this app was packaged with: a packaging error,
       * and the switch turns off.
       */
      mismatch(): void
      /** The engine commit the helper must say it was built from (`build` in hello), when the app pins one. */
      expectedBuild?(): string | undefined
      /** The endpoint belongs to another profile (`wrong_profile`): it is set aside, and the next start makes one. */
      wrongProfile(): void
      now?(): number
      log?(message: string): void
    }
  ) {}

  status(): HelperStatus {
    return this.statusNow
  }
  onStatus(listener: (status: HelperStatus) => void): void {
    this.listeners.push(listener)
  }
  /** The app's view of the helper running now. */
  helper(): EngineHelper | undefined {
    return this.current?.helper
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.failures = 0
    this.fastExits = 0
    this.lockedSince = undefined
    void this.cycle()
  }

  /** Asks the helper to shut down and kills it after the grace; no restart follows. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.generation += 1
    const current = this.current
    this.current = undefined
    this.set({ state: 'off' })
    if (!current) return
    const grace = engineLimits().helperShutdownGraceMs
    const killer = setTimeout(() => current.launched.kill(), grace)
    try {
      if (current.helper) await current.helper.request('shutdown', {}, grace).catch(() => undefined)
      current.launched.pipe.close()
      await current.launched.exited
    } finally {
      clearTimeout(killer)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private set(status: HelperStatus): void {
    this.statusNow = status
    for (const listener of this.listeners) listener(status)
  }

  private async cycle(): Promise<void> {
    const generation = ++this.generation
    this.timer = undefined
    this.set({ state: 'starting', step: 'launch' })
    let launched: LaunchedHelper
    try {
      launched = await this.deps.launch()
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof HelperNotInBuild) {
        this.running = false
        this.set({ state: 'not_in_build', text: HELPER_TEXT.notInBuild })
        return
      }
      this.exited(generation, this.now(), error instanceof Error ? error.message : String(error))
      return
    }
    if (generation !== this.generation || !this.running) {
      launched.kill()
      return
    }
    const startedAt = this.now()
    const current = { generation, launched } as NonNullable<typeof this.current>
    this.current = current
    this.set({ state: 'starting', step: 'hello' })
    void launched.exited.then(({ code, signal, stderr }) =>
      this.exited(generation, startedAt, lastWords(stderr) || `exited ${code ?? signal}`)
    )
    let helper: EngineHelper
    try {
      helper = await this.deps.use(launched.pipe)
    } catch (error) {
      if (generation !== this.generation) return
      const code = helperCode(error)
      if (code === 'unsupported_proto') return this.mismatched(launched)
      // The exit that follows starts it again.
      launched.kill()
      if (code === 'wrong_profile') {
        // Once it let go of the endpoint, the endpoint goes aside and the next start makes a new one.
        await launched.exited
        try {
          this.deps.wrongProfile()
        } catch (error) {
          this.deps.log?.(`could not set the endpoint aside: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }
    if (generation !== this.generation) return
    if (!Array.isArray(helper.info.proto) || helper.info.proto[0] !== 1) return this.mismatched(launched)
    const expected = this.deps.expectedBuild?.()
    if (expected && !helperBuildMatches(helper.info.build, expected)) return this.mismatched(launched)
    current.helper = helper
    this.lockedSince = undefined
    const show = (paused: string | undefined) => {
      if (this.current !== current) return
      this.set({ state: 'running', generation, ...(paused ? { paused, text: HELPER_TEXT.paused } : {}) })
    }
    helper.onPaused(show)
    show(helper.paused)
  }

  private mismatched(launched: LaunchedHelper): void {
    this.running = false
    this.generation += 1
    this.current = undefined
    launched.kill()
    this.set({ state: 'mismatch', text: HELPER_TEXT.mismatch })
    this.deps.mismatch()
  }

  /** A start failed or the helper exited: unless it was asked to stop, it starts again after the backoff. */
  private exited(generation: number, startedAt: number, reason: string): void {
    if (generation !== this.generation || !this.running) return
    this.current = undefined
    const limits = engineLimits()
    const now = this.now()
    this.deps.log?.(`network helper stopped: ${reason}`)
    let text: string | undefined
    if (LOCK_HELD.test(reason)) {
      // The last helper may still be letting go of the endpoint: try again soon, for a while.
      this.lockedSince ??= now
      if (now - this.lockedSince < limits.helperLockWaitMs) {
        const inMs = limits.helperRestartFirstMs
        this.set({ state: 'restarting', inMs, reason })
        this.timer = setTimeout(() => void this.cycle(), inMs)
        this.timer.unref?.()
        return
      }
      text = HELPER_TEXT.anotherRunning
    } else this.lockedSince = undefined
    if (now - startedAt >= limits.helperUpResetMs) {
      this.failures = 0
      this.fastExits = 0
    } else this.fastExits += 1
    const inMs = Math.min(limits.helperRestartFirstMs * 2 ** Math.min(this.failures, 30), limits.helperRestartMaxMs)
    this.failures += 1
    if (!text && this.fastExits >= limits.helperFastExits) text = HELPER_TEXT.keepsStopping
    this.set({ state: 'restarting', inMs, reason, ...(text ? { text } : {}) })
    this.timer = setTimeout(() => void this.cycle(), inMs)
    this.timer.unref?.()
  }
}

function lastWords(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] ?? '').replace(/^error:\s*/i, '')
}
