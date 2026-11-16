import { canonicalJson, shortHash } from '../integrations/revision'
import { guardMemoryText } from '../bots/memory/guard'
import { randomUUID } from 'node:crypto'
import type { BotModelPick, BotSchedule } from '../../shared/bots/personal/definition'
import { MAX_BOT_SCHEDULES } from '../../shared/bots/personal/definition'
import { copyPick, isPinned, modelPickProblem } from '../../shared/bots/personal/modelSlots'
import { parseTellMe, tellMeOf, type JobSchedule, type ScheduledJob, type ScheduledJobPatch, type TellMe } from '../../shared/types'
import { computeNextRun, cronProblem } from './computeNextRun'

/**
 * Bots' schedules in the shared scheduled-job store (Path step 3, "One scheduler"). A bot's schedule is an automation
 * whose Who is the bot (`ScheduledJob.bot`): the one `ScheduledJobService` claims it, and the bot engine runs each
 * occurrence in the bot's run lane. What stays a bot's own: at most 8 schedules, at most once a minute, only a
 * repeating time (an interval or cron), and Who, Where and May are the bot's (its grant), never the job's fields.
 */

export { MAX_BOT_SCHEDULES }

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

/**
 * Why a bot can't keep this time and prompt, or undefined: the checks above. A schedule runs at most once a minute: an
 * interval is whole minutes, at least 1, and a cron expression's smallest step is a minute.
 */
export function botScheduleProblem(when: unknown, prompt: unknown): string | undefined {
  return scheduleProblem({ id: 'new', when, prompt } as BotSchedule)
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
  /** Digest of saved instructions and timing, independent of scheduler ticks. */
  revision: string
  botId: string
  scheduleId: string
  when: BotSchedule['when']
  prompt: string
  name: string
  /** "every weekday · 09:00". */
  label: string
  createdBy: 'owner' | 'bot'
  createdAt: string
  /** A model picked by hand for its runs, by name; absent: the bot's Work rows. */
  model?: string
  /** That model on the entry it was picked on (#673): its runs run there or not at all. Absent on one saved by name only. */
  pick?: BotModelPick
  nextAt?: string
  /** Paused from the Automations page (the bot's own pause is the bot's). */
  paused: boolean
  tellMe: TellMe
  canWakeMe?: boolean
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

/** A fixed line is the owner's words, so only the reminder text's hidden-character guard applies. */
export function schedulePrompt(input: { prompt?: string; say?: string }): string {
  if (input.say === undefined) return typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (input.prompt !== undefined) throw new BotScheduleError('schedule_invalid', 'Give either prompt or say, not both.')
  if (typeof input.say !== 'string' || !input.say.trim() || input.say.length > 500)
    throw new BotScheduleError('schedule_invalid', 'say needs 1 to 500 characters.')
  const guarded = guardMemoryText(input.say)
  if (!guarded.ok && guarded.reason === 'invisible') throw new BotScheduleError('schedule_invalid', guarded.message)
  return `Say exactly: ${input.say.trim()}`
}

/** A local date lasts through that day; a local date/time ends at that minute. */
export function scheduleUntil(value: string, now: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value)
  if (!match) throw new BotScheduleError('schedule_invalid', 'until needs a local date (2026-11-21) or date and time (2026-11-21T18:00) on this computer.')
  const [, y, m, d, h, min, sec] = match
  const date = new Date(+y, +m - 1, +d, h === undefined ? 23 : +h, min === undefined ? 59 : +min, sec === undefined ? (h === undefined ? 59 : 0) : +sec, h === undefined ? 999 : 0)
  if (date.getFullYear() !== +y || date.getMonth() !== +m - 1 || date.getDate() !== +d || (h !== undefined && (date.getHours() !== +h || date.getMinutes() !== +min || date.getSeconds() !== +(sec ?? 0))))
    throw new BotScheduleError('schedule_invalid', 'until is not a valid local date and time. Check the day and clock time.')
  if (h !== undefined) date.setSeconds(59, 999)
  if (date <= now) throw new BotScheduleError('schedule_invalid', 'until is in the past. Pick a future date or time.')
  return date.toISOString()
}

export function scheduleEndLabel(expiresAt?: string): string {
  return expiresAt ? ` · until ${new Date(expiresAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')}` : ''
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

  setTelling(botId: string, change: { tellMe?: TellMe; canWakeMe?: boolean; scheduleId?: string }): void {
    const jobs = this.options.jobs.listJobs().filter(job => job.bot?.botId === botId && (!change.scheduleId || job.bot.scheduleId === change.scheduleId))
    if (change.scheduleId && !jobs.length) throw new BotScheduleError('schedule_not_found', 'No automation of yours has that id. Use bot_schedule_list first.')
    for (const job of jobs) this.options.jobs.updateJob(job.id, {
      ...(change.tellMe ? { tellMe: change.tellMe } : {}),
      ...(change.canWakeMe !== undefined ? { bot: { ...job.bot!, canWakeMe: change.canWakeMe } } : {})
    })
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private entryOf(job: ScheduledJob): BotScheduleEntry | undefined {
    const when = job.bot ? botWhenOf(job.schedule) : undefined
    if (!job.bot || !when) return undefined
    return {
      jobId: job.id,
      revision: shortHash(canonicalJson({ prompt: job.prompt, schedule: job.schedule, expiresAt: job.expiresAt, bot: job.bot, enabled: job.enabled, name: job.name, tellMe: tellMeOf(job) }), 64),
      botId: job.bot.botId,
      scheduleId: job.bot.scheduleId,
      when,
      prompt: job.prompt,
      name: job.name,
      label: `${job.bot.say !== undefined ? `Says “${job.bot.say}” · ` : ''}${this.labelOf(when)}${scheduleEndLabel(job.expiresAt)}`,
      createdBy: job.bot.createdBy,
      createdAt: job.createdAt,
      ...(job.bot.model ? { model: job.bot.model } : {}),
      ...(job.bot.model && job.bot.pick && !modelPickProblem(job.bot.pick) && job.bot.pick.model === job.bot.model ? { pick: copyPick(job.bot.pick) } : {}),
      ...(job.nextRunAt && job.state !== 'paused' && job.enabled ? { nextAt: job.nextRunAt } : {}),
      paused: job.state === 'paused' || !job.enabled,
      tellMe: tellMeOf(job),
      ...(job.bot.canWakeMe !== undefined ? { canWakeMe: job.bot.canWakeMe } : {}),
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

  /** Completed schedules stay in Automations; upkeep writes their quiet end line once. */
  ended(botId?: string): Array<{ botId: string; jobId: string; scheduleId: string; name: string; tellMe: TellMe; canWakeMe?: boolean }> {
    return this.options.jobs.listJobs().filter((job) => job.bot && (botId === undefined || job.bot.botId === botId) && job.state === 'completed' && Boolean(job.expiresAt)).map((job) => ({ botId: job.bot!.botId, jobId: job.id, scheduleId: job.bot!.scheduleId, name: job.name, tellMe: tellMeOf(job), ...(job.bot!.canWakeMe !== undefined ? { canWakeMe: job.bot!.canWakeMe } : {}) }))
  }

  /** Every bot's schedules, oldest first. */
  all(): BotScheduleEntry[] {
    return this.options.jobs.listJobs()
      .flatMap((job) => job.state === 'completed' ? [] : this.entryOf(job) ?? [])
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
   * An occurrence the bot took but never ran (a full queue dropped it): the automation shows why, as for an occurrence
   * skipped when it was due (`botSkip`), until the next one is handed over.
   */
  skipped(botId: string, scheduleId: string, skip: { at: string; reason: string }): void {
    const entry = this.get(botId, scheduleId)
    if (entry) this.options.jobs.updateJob(entry.jobId, { botSkip: { at: skip.at, reason: skip.reason } })
  }

  /**
   * Adds a schedule: at most 8 per bot, at least a minute apart. It needs no approval (a schedule is not a permission)
   * and starts from now, so it never runs for times before it existed.
   */
  add(botId: string, input: { when: BotSchedule['when']; prompt?: string; say?: string; until?: string; model?: string; pick?: BotModelPick; name?: string; tellMe?: TellMe }, createdBy: 'owner' | 'bot', options: { scheduleId?: string; ownerAsked?: boolean } = {}): BotScheduleEntry {
    if (this.list(botId).length >= MAX_BOT_SCHEDULES) throw new BotScheduleError('schedule_limit', `A bot can have at most ${MAX_BOT_SCHEDULES} schedules. Remove one first.`)
    const ownerAsked = options.ownerAsked === true || (input.say !== undefined && createdBy === 'owner')
    if (input.say !== undefined && !ownerAsked) throw new BotScheduleError('schedule_invalid', 'Only the owner’s message or tap can set a fixed line. Use prompt instead of say.')
    const prompt = schedulePrompt(input)
    const problem = botScheduleProblem(input.when, prompt)
    if (problem) throw new BotScheduleError('schedule_invalid', problem)
    const expiresAt = input.until === undefined ? undefined : scheduleUntil(input.until, this.now())
    const scheduleId = options.scheduleId ?? `s-${randomUUID().slice(0, 8)}`
    const when: BotSchedule['when'] = input.when.kind === 'interval' ? { kind: 'interval', minutes: input.when.minutes } : { kind: 'cron', expr: input.when.expr.trim() }
    const job = this.options.jobs.createJob({
      // A draft turned on keeps its name and Tell me, in the same write.
      name: input.name?.trim() || botJobName(input.say ?? prompt),
      ...(input.tellMe ? { tellMe: input.tellMe } : {}),
      prompt,
      ...(expiresAt ? { expiresAt } : {}),
      schedule: jobScheduleOf(when),
      threadId: botJobThreadGuard(botId),
      // Only the owner picks a model by hand; a bot's own schedule runs on its own rows. The name stays beside the pick,
      // for builds that read only the name.
      bot: { botId, scheduleId, createdBy, ...(ownerAsked ? { ownerAsked: true } : {}), ...(input.say !== undefined ? { say: input.say.trim() } : {}), ...(createdBy === 'owner' && input.model?.trim() ? { model: input.model.trim(), ...(isPinned(input.pick) ? { pick: { ...copyPick(input.pick), instanceId: input.pick.instanceId } } : {}) } : {}) }
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
    for (const job of this.options.jobs.listJobs()) if (job.bot?.botId === botId && this.options.jobs.deleteJob(job.id)) removed += 1
    return removed
  }

  /**
   * An edit from the Automations page. Only When, Do, the name and Tell me change; a bot repeats, at most once a minute.
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
      if (job.bot.say !== undefined) {
        const say = prompt.startsWith('Say exactly:') ? prompt.slice('Say exactly:'.length).trim() : undefined
        changes.bot = { ...job.bot, say }
        if (say !== undefined) {
          changes.prompt = schedulePrompt({ say })
          changes.bot.ownerAsked = true
        }
      }
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
      const level = parseTellMe(patch.tellMe)
      if (!level) throw new BotScheduleError('schedule_invalid', 'Tell me is needs_you, look, fyi or every.')
      changes.tellMe = level
    }
    const updated = this.options.jobs.updateJob(job.id, changes)
    this.options.jobs.wake()
    return updated
  }
}
