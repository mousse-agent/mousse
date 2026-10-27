import type { BotSchedule } from '../../../shared/bots/personal/definition'
import { computeNextRun } from '../../scheduled/computeNextRun'

/**
 * Bot schedules (PR 6 §6). No second `ScheduledJobService`: the times come from `computeNextRun`,
 * and the state lives in `bots.db` (`bot_schedule_state`). The tick only inserts activations, one
 * per occurrence under the key `sched:<botId>:<scheduleId>:<occurrenceAt>`, in the same transaction
 * that moves the schedule on; the bot engine's queue runs them.
 */

const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
/** How often the tick runs; it also runs on wake. */
export const BOT_SCHEDULE_TICK_MS = 30_000

/** Why a schedule cannot be published, or undefined when it can. */
export function scheduleProblem(schedule: BotSchedule): string | undefined {
  if (!schedule || typeof schedule !== 'object') return 'A schedule is invalid.'
  if (typeof schedule.id !== 'string' || !SCHEDULE_ID.test(schedule.id)) return 'A schedule id is invalid.'
  if (typeof schedule.prompt !== 'string' || !schedule.prompt.trim() || schedule.prompt.length > 64 * 1024) return 'Each schedule needs something to do.'
  const when = schedule.when as { kind?: unknown; minutes?: unknown; expr?: unknown } | undefined
  if (!when || typeof when !== 'object') return 'Each schedule needs a time.'
  if (when.kind === 'interval') {
    if (Object.keys(when).some((key) => key !== 'kind' && key !== 'minutes')) return 'A schedule time is invalid.'
    if (typeof when.minutes !== 'number' || !Number.isInteger(when.minutes) || when.minutes < 1 || when.minutes > 366 * 24 * 60) return 'An interval is a whole number of minutes, at least 1.'
    return undefined
  }
  if (when.kind === 'cron') {
    if (Object.keys(when).some((key) => key !== 'kind' && key !== 'expr')) return 'A schedule time is invalid.'
    if (typeof when.expr !== 'string' || when.expr.trim().split(/\s+/).length !== 5 || when.expr.length > 200) return 'A cron schedule needs five fields.'
    if (!computeNextRun({ kind: 'cron', expr: when.expr }, null, new Date(0))) return 'This cron schedule never runs.'
    return undefined
  }
  return 'A schedule runs every few minutes or on a cron expression.'
}

/** What `bot_schedule_state.spec_json` records: an edit of the time restarts the schedule. */
export function scheduleSpec(schedule: BotSchedule): string {
  return schedule.when.kind === 'interval' ? JSON.stringify({ kind: 'interval', minutes: schedule.when.minutes }) : JSON.stringify({ kind: 'cron', expr: schedule.when.expr })
}

/** The first occurrence after `after`, or null when the schedule never runs again. */
export function firstOccurrence(schedule: BotSchedule, after: Date): string | null {
  return computeNextRun(schedule.when.kind === 'interval' ? { kind: 'interval', minutes: schedule.when.minutes } : { kind: 'cron', expr: schedule.when.expr }, null, after)
}

/**
 * The occurrence after `occurrenceAt`. When that one has passed too (Mousse was closed), every
 * missed occurrence collapses into the one that just ran: the next is the first after `now`.
 */
export function nextOccurrence(schedule: BotSchedule, occurrenceAt: string, now: Date): string | null {
  const when = schedule.when.kind === 'interval' ? { kind: 'interval' as const, minutes: schedule.when.minutes } : { kind: 'cron' as const, expr: schedule.when.expr }
  const next = computeNextRun(when, occurrenceAt, now)
  if (next && Date.parse(next) > now.getTime()) return next
  return computeNextRun(when, null, now)
}

/**
 * Runs `tick` every 30 s and on `wake`, once `start` was called (after the bot startup pass). A
 * tick never overlaps the previous one; a failed tick is logged and the next one tries again.
 */
export class BotScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly options: {
    tick(now: Date): Promise<unknown>
    clock?: () => number
    intervalMs?: number
  }) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.wake() }, this.options.intervalMs ?? BOT_SCHEDULE_TICK_MS)
    this.timer.unref?.()
    void this.wake()
  }

  get started(): boolean {
    return this.timer !== null
  }

  /** Ticks now (after a sleep, or when a bot's schedules changed); a tick in progress runs once more. */
  wake(): Promise<void> {
    if (!this.timer) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        try {
          await this.options.tick(new Date(this.options.clock?.() ?? Date.now()))
        } catch (error) {
          console.warn('bot schedules could not be checked', { error: error instanceof Error ? error.message : String(error) })
        }
      } while (this.again && this.timer)
    })().finally(() => { this.running = null })
    return this.running
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
