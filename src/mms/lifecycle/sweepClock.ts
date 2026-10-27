import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath } from './ResourceLifecycleStore'

/** A wall clock that reads this much earlier than at the last run was set backwards. */
export const STORAGE_CLOCK_BACKWARD_TOLERANCE_MS = 5 * 60_000

export const STORAGE_CLOCK_SUSPENDED_REASON = 'Paused after the system clock moved backwards; save the storage policy to resume.'

export interface StorageClockCheck {
  suspended: boolean
  reason?: string
  /** How far the wall clock moved since the previous sample; only meaningful when not suspended. */
  forwardJumpMs?: number
}

/**
 * Clock guard for the time-based storage rules. It suspends only on a backward jump: a rule that
 * reads an age from a clock set backwards would act on the wrong data. Forward movement (sleep,
 * hibernation, a clock set forward) is reported, not blocked, because every time-based storage
 * rule acts on reversible data or scratch behind the unpublished-commit and content checks.
 *
 * A monotonic comparison is not used: `performance.now()` does not advance during system suspend
 * on Linux, so it would pause cleanup after every nap. Only the suspension is persisted
 * (`storage-clock.json`), so it survives a restart until the policy is saved. Trash purging keeps
 * its own, stricter `trash-clock.json`.
 */
export class StorageSweepClock {
  private lastWall?: number
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private get path(): string { return join(this.root, 'storage-clock.json') }

  /** Takes the first sample. A daemon that was off for days is not a jump. */
  start(): void { this.lastWall = this.now() }

  check(): StorageClockCheck {
    const now = this.now()
    if (this.persistedSuspension()) { this.lastWall = now; return { suspended: true, reason: STORAGE_CLOCK_SUSPENDED_REASON } }
    const previous = this.lastWall ?? now
    // The sample moves to the new reading either way, so a sustained backward set stops
    // suspending once the user resumes: the next run compares with the corrected clock.
    this.lastWall = now
    if (now < previous - STORAGE_CLOCK_BACKWARD_TOLERANCE_MS) {
      assertLifecyclePath(this.root, this.path)
      atomicWriteJsonSync(this.path, { suspended: true, reason: STORAGE_CLOCK_SUSPENDED_REASON })
      return { suspended: true, reason: STORAGE_CLOCK_SUSPENDED_REASON }
    }
    return { suspended: false, forwardJumpMs: Math.max(0, now - previous) }
  }

  /**
   * What `check()` would answer now, without persisting a suspension or moving the sample. A dry run
   * uses it so that it decides like the run that follows and still writes nothing.
   */
  peek(): StorageClockCheck {
    if (this.persistedSuspension()) return { suspended: true, reason: STORAGE_CLOCK_SUSPENDED_REASON }
    const now = this.now(), previous = this.lastWall ?? now
    if (now < previous - STORAGE_CLOCK_BACKWARD_TOLERANCE_MS) return { suspended: true, reason: STORAGE_CLOCK_SUSPENDED_REASON }
    return { suspended: false, forwardJumpMs: Math.max(0, now - previous) }
  }

  /** Clears the suspension and re-samples the clock. Called when the storage policy is saved. */
  resume(): void {
    assertLifecyclePath(this.root, this.path)
    if (existsSync(this.path)) unlinkSync(this.path)
    this.lastWall = this.now()
  }

  suspended(): boolean { return this.persistedSuspension() }

  private persistedSuspension(): boolean {
    if (!existsSync(this.path)) return false
    assertLifecyclePath(this.root, this.path)
    try { return (JSON.parse(readFileSync(this.path, 'utf8')) as { suspended?: boolean }).suspended === true }
    catch { return true } // An unreadable guard file fails closed.
  }
}
