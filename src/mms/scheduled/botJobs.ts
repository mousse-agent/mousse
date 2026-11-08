import { randomUUID } from 'node:crypto'
import type { BotSchedule } from '../../shared/bots/personal/definition'
import { MAX_BOT_SCHEDULES } from '../../shared/bots/personal/definition'
import { isTellMe, tellMeOf, type JobSchedule, type ScheduledJob, type ScheduledJobPatch, type TellMe } from '../../shared/types'
import { computeNextRun, cronProblem, minCronGapMinutes } from './computeNextRun'

/**
 * Bots' schedules in the shared scheduled-job store (Path step 3, "One scheduler"). A bot's schedule is an automation
 * whose Who is the bot (`ScheduledJob.bot`): the one `ScheduledJobService` claims it, and the bot engine runs each
 * occurrence in the bot's run lane. What stays a bot's own: at most 8 schedules, at most every 5 minutes, only a
 * repeating time (an interval or cron), and Who, Where and May are the bot's (its grant), never the job's fields.
 */

export { MAX_BOT_SCHEDULES }
/** The shortest time between two runs of one bot schedule. */
export const MIN_BOT_SCHEDULE_MINUTES = 5

const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** A bot schedule's job id: stable for the bot and its schedule id, safe in file names, so moving one twice finds it. */
export function botJobId(botId: string, scheduleId: string): string {
  return `${botId}--${scheduleId}`
}

/**
 * The thread a bot's job names, which no thread ever has. This build never reads it: a bot's occurrence goes to the
 * bot before any thread is looked at. A build from before the move, which knows no `bot` field, finds the thread gone
 * and pauses the job with "Its thread was deleted" instead of running the bot's prompt outside the bot and its grant.
 */
export function botJobThreadGuard(botId: string): string {
  return `bot-schedule:${botId}`
}

export function jobScheduleOf(when: BotSchedule['when']): JobSchedule {
  return when.kind === 'interval' ? { kind: 'interval', minutes: when.minutes } : { kind: 'cron', expr: when.expr }
}

/** A job schedule as a bot's time; undefined for a time a bot cannot repeat on (once, on demand). */
export function botWhenOf(schedule: JobSchedule): BotSchedule['when'] | undefined {
  if (schedule.kind === 'interval' && typeof schedule.minutes === 'number') return { kind: 'interval', minutes: schedule.minutes }
  if (schedule.kind === 'cron' && typeof schedule.expr === 'string') return { kind: 'cron', expr: schedule.expr }
  return undefined
}

/** Why a bot schedule cannot be kept, or undefined when it can: the shape, the cron fields, and that it runs at all. */
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
    // Every field is checked before any time is searched: a malformed one is refused, never run.
    const problem = cronProblem(when.expr)
    if (problem) return problem
    if (!computeNextRun({ kind: 'cron', expr: when.expr }, null, new Date(0))) return 'This cron schedule never runs.'
    return undefined
  }
  return 'A schedule runs every few minutes or on a cron expression.'
}

/** Why a bot can't keep this time and prompt, or undefined: the checks above, plus at most every 5 minutes. */
export function botScheduleProblem(when: unknown, prompt: unknown): string | undefined {
  const problem = scheduleProblem({ id: 'new', when, prompt } as BotSchedule)
  if (problem) return problem
  const schedule = when as BotSchedule['when']
  const tooOften = `A schedule runs at most every ${MIN_BOT_SCHEDULE_MINUTES} minutes.`
  if (schedule.kind === 'interval') return schedule.minutes < MIN_BOT_SCHEDULE_MINUTES ? tooOften : undefined
  // Over a whole leap year, so a rule on the day of the month or week is counted; once a year or rarer is never too often.
  const gap = minCronGapMinutes(schedule.expr)
  return gap !== null && gap < MIN_BOT_SCHEDULE_MINUTES ? tooOften : undefined
}

/** A short name from a prompt: its first line, cut. */
export function botJobName(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/).find((part) => part.trim())?.trim() ?? ''
  const name = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
  return name || 'Bot schedule'
}

/** One of a bot's schedules, as the bot, its chat and its About read it. */
export interface BotScheduleEntry {
  jobId: string
  botId: string
  scheduleId: string
  when: BotSchedule['when']
  prompt: string
  name: string
  /** "every weekday · 09:00". */
  label: string
  createdBy: 'owner' | 'bot'
  createdAt: string
  nextAt?: string
  /** Paused from the Automations page (the bot's own pause is the bot's). */
  paused: boolean
  tellMe: TellMe
  /** The last occurrence that did not start, and why. */
  skip?: { at: string; reason: string }
}

/** What the book needs from the shared scheduler (`ScheduledJobService`). */
export interface BotScheduleJobs {
  listJobs(): ScheduledJob[]
  createJob(input: Parameters<import('./ScheduledJobStore').ScheduledJobStore['createJob']>[0], options?: Parameters<import('./ScheduledJobStore').ScheduledJobStore['createJob']>[1]): ScheduledJob
  updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null
  deleteJob(id: string): boolean
  wake(): void
}

/** A bot schedule's edit was refused; the message is shown to the person or the bot. */
export class BotScheduleError extends Error {
  constructor(readonly code: 'schedule_limit' | 'schedule_invalid' | 'schedule_not_found' | 'schedule_locked', message: string) {
    super(message)
    this.name = 'BotScheduleError'
  }
}

/** The fields a bot automation can change from the Automations page: When, Do, its name and Tell me. Who, Where and May stay the bot's. */
const BOT_PATCH_KEYS = new Set(['name', 'prompt', 'schedule', 'tellMe'])

/**
 * Bots' schedules over the shared store: the bot's tools (`bot_schedule_*`), `bots.schedules.*`, the bot's About and the
 * Automations page all read and write these same records.
 */
export class BotScheduleBook {
  constructor(private readonly options: {
    jobs: BotScheduleJobs
    /** A schedule in plain words ("every weekday · 09:00"). */
    label(when: BotSchedule['when']): string
    now?(): Date
  }) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private entryOf(job: ScheduledJob): BotScheduleEntry | undefined {
    const when = job.bot ? botWhenOf(job.schedule) : undefined
    if (!job.bot || !when) return undefined
    return {
      jobId: job.id,
      botId: job.bot.botId,
      scheduleId: job.bot.scheduleId,
      when,
      prompt: job.prompt,
      name: job.name,
      label: this.labelOf(when),
      createdBy: job.bot.createdBy,
      createdAt: job.createdAt,
      ...(job.nextRunAt && job.state !== 'paused' && job.enabled ? { nextAt: job.nextRunAt } : {}),
      paused: job.state === 'paused' || !job.enabled,
      tellMe: tellMeOf(job),
      ...(job.botSkip ? { skip: job.botSkip } : {})
    }
  }

  labelOf(when: BotSchedule['when']): string {
    try {
      const label = this.options.label(when)
      if (label) return label
    } catch {
      // Below.
    }
    if (when.kind === 'interval') return when.minutes % 60 === 0 ? `every ${when.minutes === 60 ? 'hour' : `${when.minutes / 60} hours`}` : `every ${when.minutes} minutes`
    return when.expr
  }

  /** Every bot's schedules, oldest first. */
  all(): BotScheduleEntry[] {
    return this.options.jobs.listJobs()
      .flatMap((job) => this.entryOf(job) ?? [])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.scheduleId.localeCompare(b.scheduleId))
  }

  /** One bot's schedules, oldest first. */
  list(botId: string): BotScheduleEntry[] {
    return this.all().filter((entry) => entry.botId === botId)
  }

  get(botId: string, scheduleId: string): BotScheduleEntry | undefined {
    return this.list(botId).find((entry) => entry.scheduleId === scheduleId)
  }

  /**
   * Adds a schedule: at most 8 per bot, at least 5 minutes apart. It needs no approval (a schedule is not a permission)
   * and starts from now, so it never runs for times before it existed.
   */
  add(botId: string, input: { when: BotSchedule['when']; prompt: string }, createdBy: 'owner' | 'bot', options: { scheduleId?: string } = {}): BotScheduleEntry {
    if (this.list(botId).length >= MAX_BOT_SCHEDULES) throw new BotScheduleError('schedule_limit', `A bot can have at most ${MAX_BOT_SCHEDULES} schedules. Remove one first.`)
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const problem = botScheduleProblem(input.when, prompt)
    if (problem) throw new BotScheduleError('schedule_invalid', problem)
    const scheduleId = options.scheduleId ?? `s-${randomUUID().slice(0, 8)}`
    const when: BotSchedule['when'] = input.when.kind === 'interval' ? { kind: 'interval', minutes: input.when.minutes } : { kind: 'cron', expr: input.when.expr.trim() }
    const job = this.options.jobs.createJob({
      name: botJobName(prompt),
      prompt,
      schedule: jobScheduleOf(when),
      threadId: botJobThreadGuard(botId),
      bot: { botId, scheduleId, createdBy }
    }, { id: botJobId(botId, scheduleId), nextRunAt: computeNextRun(jobScheduleOf(when), null, this.now()) })
    this.options.jobs.wake()
    return this.entryOf(job)!
  }

  /** Removes one schedule; false when the bot has none with that id. */
  remove(botId: string, scheduleId: string): boolean {
    const entry = this.get(botId, scheduleId)
    if (!entry) return false
    const removed = this.options.jobs.deleteJob(entry.jobId)
    if (removed) this.options.jobs.wake()
    return removed
  }

  /** Every schedule of a bot goes (its purge). */
  removeAll(botId: string): number {
    let removed = 0
    for (const entry of this.list(botId)) if (this.options.jobs.deleteJob(entry.jobId)) removed += 1
    return removed
  }

  /**
   * An edit from the Automations page. Only When, Do, the name and Tell me change; a bot repeats, at most every 5 minutes.
   * A new time starts from now, as a new schedule does.
   */
  update(job: ScheduledJob, patch: ScheduledJobPatch & { enabled?: boolean }): ScheduledJob | null {
    if (!job.bot) throw new BotScheduleError('schedule_not_found', 'This is not a bot\'s automation.')
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || BOT_PATCH_KEYS.has(key)) continue
      throw new BotScheduleError('schedule_locked', 'A bot\'s automation runs as the bot: who does it, where and what it may do stay the bot\'s.')
    }
    const changes: Partial<ScheduledJob> = {}
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim()
      if (!prompt || prompt.length > 64 * 1024) throw new BotScheduleError('schedule_invalid', 'Each schedule needs something to do.')
      if (prompt.startsWith('/')) throw new BotScheduleError('schedule_locked', 'A bot does the work itself; a workflow can\'t be its Do.')
      changes.prompt = prompt
    }
    if (patch.schedule !== undefined) {
      const when = botWhenOf(patch.schedule)
      if (!when) throw new BotScheduleError('schedule_invalid', 'A bot repeats: every few minutes or on a cron time. For one run, ask it in its chat.')
      const problem = botScheduleProblem(when, changes.prompt ?? job.prompt)
      if (problem) throw new BotScheduleError('schedule_invalid', problem)
      changes.schedule = jobScheduleOf(when)
      changes.nextRunAt = computeNextRun(changes.schedule, null, this.now())
      changes.botSkip = undefined
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name || name.length > 256) throw new BotScheduleError('schedule_invalid', 'A name is 1 to 256 characters.')
      changes.name = name
    }
    if (patch.tellMe !== undefined) {
      if (!isTellMe(patch.tellMe)) throw new BotScheduleError('schedule_invalid', 'Tell me is every, news or problems.')
      changes.tellMe = patch.tellMe
    }
    const updated = this.options.jobs.updateJob(job.id, changes)
    this.options.jobs.wake()
    return updated
  }
}
