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
 * occurrence in the bot's run lane. What stays a bot's own: at most once a minute (and `MAX_BOT_SCHEDULES`, a ceiling
 * only a runaway reaches), only a repeating time (an interval or cron) for a schedule the bot adds, and Who, Where and
 * May are the bot's (its grant), never the job's fields. One the owner turns on from the Automations page may also run
 * once, or only when started (Run now, `mousse automation run`, a request URL).
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

/**
 * When a bot's automation runs: a repeating time (a bot's own schedules are only these), or, for one the owner turned on
 * from the Automations page, once at a time or only when started (Run now, the CLI, a request URL).
 */
export type BotJobWhen = BotSchedule['when'] | { kind: 'once'; runAt: string } | { kind: 'manual' }

/** A job schedule as a bot's automation time, any kind; undefined for a malformed one. */
export function botJobWhenOf(schedule: JobSchedule): BotJobWhen | undefined {
  if (schedule.kind === 'once' && typeof schedule.runAt === 'string') return { kind: 'once', runAt: schedule.runAt }
  if (schedule.kind === 'manual') return { kind: 'manual' }
  return botWhenOf(schedule)
}

function jobScheduleOfAny(when: BotJobWhen): JobSchedule {
  if (when.kind === 'once') return { kind: 'once', runAt: when.runAt }
  if (when.kind === 'manual') return { kind: 'manual' }
  return jobScheduleOf(when)
}

/** Why the owner can't give a bot's automation this time and prompt, or undefined. A repeating time is checked as a bot schedule. */
export function botJobWhenProblem(when: BotJobWhen, prompt: unknown, now: Date): string | undefined {
  if (when.kind !== 'once' && when.kind !== 'manual') return botScheduleProblem(when, prompt)
  if (typeof prompt !== 'string' || !prompt.trim()) return 'Each schedule needs something to do.'
  if (when.kind === 'manual') return undefined
  const at = Date.parse(when.runAt)
  if (!Number.isFinite(at)) return 'The time to run once is invalid.'
  if (at <= now.getTime()) return 'The time to run once is in the past.'
  return undefined
}

/** A job schedule as a bot's repeating time; undefined for a time a bot cannot repeat on (once, on demand). */
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
  /** A bot's own schedules repeat; one the owner turned on may run once or only when started. */
  when: BotJobWhen
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

  /** Raw saved jobs: an unsupported When is still present, and a read failure must propagate. */
  pageCheckExists(botId: string, scheduleId: string): boolean {
    const job = this.options.jobs.listJobs().find(job => job.bot?.botId === botId && job.bot.scheduleId === scheduleId)
    return Boolean(job && job.state !== 'completed')
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private entryOf(job: ScheduledJob): BotScheduleEntry | undefined {
    const when = job.bot ? botJobWhenOf(job.schedule) : undefined
    if (!job.bot || !when) return undefined
    return {
      jobId: job.id,
      revision: shortHash(canonicalJson({ prompt: job.prompt, schedule: job.schedule, expiresAt: job.expiresAt, model: job.bot.model, pick: job.bot.pick, say: job.bot.say, enabled: job.enabled, paused: job.state === 'paused' }), 64),
      botId: job.bot.botId,
      scheduleId: job.bot.scheduleId,
      when,
      prompt: job.prompt,
      name: job.name,
      label: `${job.bot.say !== undefined ? `Says “${job.bot.say}” · ` : ''}${this.jobLabelOf(when, job)}${scheduleEndLabel(job.expiresAt)}`,
      createdBy: job.bot.createdBy,
      createdAt: job.createdAt,
      ...(job.bot.model ? { model: job.bot.model } : {}),
      ...(job.bot.model && job.bot.pick && !modelPickProblem(job.bot.pick) && job.bot.pick.model === job.bot.model ? { pick: copyPick(job.bot.pick) } : {}),
      ...(job.nextRunAt && job.state !== 'paused' && job.enabled ? { nextAt: job.nextRunAt } : {}),
      paused: job.state === 'paused' || !job.enabled,
      tellMe: tellMeOf(job),
      ...(job.botSkip ? { skip: job.botSkip } : {})
    }
  }

  /** Any automation time in plain words: a repeating one as `labelOf`, "once · 21 Nov, 18:00", "when you run it". */
  private jobLabelOf(when: BotJobWhen, job: ScheduledJob): string {
    if (when.kind === 'once') return `once · ${new Date(when.runAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    if (when.kind === 'manual') return job.trigger?.webhook ? 'on a request, or when you run it' : 'when you run it'
    return this.labelOf(when)
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
  ended(botId?: string): Array<{ botId: string; jobId: string; scheduleId: string; name: string; tellMe: TellMe }> {
    return this.options.jobs.listJobs().filter((job) => job.bot && (botId === undefined || job.bot.botId === botId) && job.state === 'completed' && Boolean(job.expiresAt)).map((job) => ({ botId: job.bot!.botId, jobId: job.id, scheduleId: job.bot!.scheduleId, name: job.name, tellMe: tellMeOf(job) }))
  }

  /**
   * Every bot's schedules, oldest first. One that ran its one time stays: its run, handed over as the job completed,
   * still belongs to it (a schedule that is gone cancels its runs), and Run now can start it again.
   */
  all(): BotScheduleEntry[] {
    return this.options.jobs.listJobs()
      .flatMap((job) => job.state === 'completed' && job.schedule.kind !== 'once' ? [] : this.entryOf(job) ?? [])
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
   * An occurrence the bot took but never ran (a full queue refused it): the automation shows why, as for an occurrence
   * skipped when it was due (`botSkip`), until the next one is handed over.
   */
  skipped(botId: string, scheduleId: string, skip: { at: string; reason: string }): void {
    const entry = this.get(botId, scheduleId)
    if (entry) this.options.jobs.updateJob(entry.jobId, { botSkip: { at: skip.at, reason: skip.reason } })
  }

  /**
   * Adds a schedule: at least a minute apart, and at most `MAX_BOT_SCHEDULES` per bot (only a runaway reaches it). It needs no approval (a schedule is not a permission)
   * and starts from now, so it never runs for times before it existed.
   */
  add(botId: string, input: { when: BotJobWhen; prompt?: string; say?: string; until?: string; model?: string; pick?: BotModelPick; name?: string; tellMe?: TellMe; cliName?: string }, createdBy: 'owner' | 'bot', options: { scheduleId?: string; ownerAsked?: boolean } = {}): BotScheduleEntry {
    if (this.list(botId).length >= MAX_BOT_SCHEDULES) throw new BotScheduleError('schedule_limit', `A bot can have at most ${MAX_BOT_SCHEDULES} schedules, a ceiling only a runaway reaches. Remove some first.`)
    const ownerAsked = options.ownerAsked === true || (input.say !== undefined && createdBy === 'owner')
    if (input.say !== undefined && !ownerAsked) throw new BotScheduleError('schedule_invalid', 'Only the owner’s message or tap can set a fixed line. Use prompt instead of say.')
    const prompt = schedulePrompt(input)
    // A bot's own schedules repeat; once or on demand is the owner's (the Automations page), and has no end.
    const repeating = input.when.kind === 'interval' || input.when.kind === 'cron'
    if (!repeating && createdBy !== 'owner') throw new BotScheduleError('schedule_invalid', 'A bot repeats: every few minutes or on a cron time. For one run, ask it in its chat.')
    if (!repeating && input.until !== undefined) throw new BotScheduleError('schedule_invalid', 'Only a repeating time can have an end.')
    const problem = botJobWhenProblem(input.when, prompt, this.now())
    if (problem) throw new BotScheduleError('schedule_invalid', problem)
    const expiresAt = input.until === undefined ? undefined : scheduleUntil(input.until, this.now())
    const scheduleId = options.scheduleId ?? `s-${randomUUID().slice(0, 8)}`
    const when: BotJobWhen = input.when.kind === 'interval' ? { kind: 'interval', minutes: input.when.minutes }
      : input.when.kind === 'cron' ? { kind: 'cron', expr: input.when.expr.trim() }
        : input.when.kind === 'once' ? { kind: 'once', runAt: new Date(input.when.runAt).toISOString() }
          : { kind: 'manual' }
    const job = this.options.jobs.createJob({
      // A draft turned on keeps its name and Tell me, in the same write.
      name: input.name?.trim() || botJobName(input.say ?? prompt),
      ...(input.tellMe ? { tellMe: input.tellMe } : {}),
      prompt,
      ...(expiresAt ? { expiresAt } : {}),
      // A draft turned on with a CLI trigger keeps the name `mousse automation run` takes.
      ...(input.cliName ? { cliName: input.cliName } : {}),
      schedule: jobScheduleOfAny(when),
      threadId: botJobThreadGuard(botId),
      // Only the owner picks a model by hand; a bot's own schedule runs on its own rows. The name stays beside the pick,
      // for builds that read only the name.
      bot: { botId, scheduleId, createdBy, ...(ownerAsked ? { ownerAsked: true } : {}), ...(input.say !== undefined ? { say: input.say.trim() } : {}), ...(createdBy === 'owner' && input.model?.trim() ? { model: input.model.trim(), ...(isPinned(input.pick) ? { pick: { ...copyPick(input.pick), instanceId: input.pick.instanceId } } : {}) } : {}) }
    }, { id: botJobId(botId, scheduleId), nextRunAt: computeNextRun(jobScheduleOfAny(when), null, this.now()) })
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
   * An edit from the Automations page. Only When, Do, the name and Tell me change. A bot's own schedule repeats, at most
   * once a minute; one the owner added may also run once or only when started. A new time starts from now, as a new
   * schedule does.
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
      const when = botJobWhenOf(patch.schedule)
      const repeating = when?.kind === 'interval' || when?.kind === 'cron'
      if (!when || (!repeating && job.bot.createdBy !== 'owner')) throw new BotScheduleError('schedule_invalid', 'A bot repeats: every few minutes or on a cron time. For one run, ask it in its chat.')
      if (!repeating && job.expiresAt) throw new BotScheduleError('schedule_invalid', 'It has an end, so it repeats.')
      if (when.kind === 'once' && job.trigger?.webhook) throw new BotScheduleError('schedule_invalid', 'A one-time automation runs once. Turn off its request URL first, or keep When on demand.')
      const problem = botJobWhenProblem(when, changes.prompt ?? job.prompt, this.now())
      if (problem) throw new BotScheduleError('schedule_invalid', problem)
      changes.schedule = jobScheduleOfAny(when)
      changes.nextRunAt = computeNextRun(changes.schedule, null, this.now())
      changes.botSkip = undefined
      // A spent one-time automation given a new time runs again.
      if (job.state !== 'paused' && job.state !== 'running') changes.state = changes.nextRunAt || changes.schedule.kind === 'manual' ? 'scheduled' : 'completed'
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
