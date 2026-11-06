import { ipcErrorMessage } from '../../utils/voiceErrors'
import { describePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type {
  JobSchedule,
  ScheduledJob,
  ScheduledJobRunRecord,
  ScheduledJobWorkspace,
  ScheduledWebhookDelivery,
  ScheduledWebhookDeliveryOutcome
} from '../../../shared/types'

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'custom'

/** A time of day in the person's own clock format: "9:00" or "9:00 AM". */
export function clockText(hour: number, minute: number): string {
  return new Date(2000, 0, 3, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const timeOf = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_MS = 24 * 3_600_000
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** Whole calendar days from `now` to `date`: 0 today, 1 tomorrow, -1 yesterday. */
const dayOffset = (date: Date, now: Date) => Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS)

/**
 * A saved time said the way a to-do list says it: "15:00" today, "tomorrow 9:00", "yesterday 9:01", "Mon 8:30"
 * within the week either side, else "12 Nov 10:00" (with the year when it is not this year).
 */
export function relativeWhen(iso: string | null | undefined, now: Date = new Date()): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const time = timeOf(date)
  const offset = dayOffset(date, now)
  if (offset === 0) return time
  if (offset === 1) return `tomorrow ${time}`
  if (offset === -1) return `yesterday ${time}`
  if (Math.abs(offset) < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
  return `${day} ${time}`
}

/** A day alone: "today", "yesterday", "Mon", "12 Nov". */
export function relativeDay(iso: string | null | undefined, now: Date = new Date()): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const offset = dayOffset(date, now)
  if (offset === 0) return 'today'
  if (offset === -1) return 'yesterday'
  if (offset === 1) return 'tomorrow'
  if (Math.abs(offset) < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** The time is on the person's own calendar day. */
export function isToday(iso: string | null | undefined, now: Date = new Date()): boolean {
  const date = iso ? new Date(iso) : null
  return Boolean(date && !Number.isNaN(date.getTime()) && dayOffset(date, now) === 0)
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAY_NAMES[day] }))

/** A cron expression that a person can read as a sentence: a fixed time on every day, on weekdays, on some days of the week, or every N hours. */
export type SimpleCron =
  | { kind: 'days'; minute: number; hour: number; days: number[] | 'all' }
  | { kind: 'hours'; minute: number; every: number }
  | { kind: 'minutes'; every: number }

const INT = /^\d{1,2}$/

/** Reads the simple cron forms; anything else (day of month, month, ranges of hours) is null. */
export function parseSimpleCron(expr: string | undefined): SimpleCron | null {
  const fields = expr?.trim().split(/\s+/) ?? []
  if (fields.length !== 5) return null
  const [m, h, dom, mon, dow] = fields
  if (dom !== '*' || mon !== '*') return null
  const step = (field: string) => (field === '*' ? 1 : /^\*\/\d{1,2}$/.test(field) ? Number(field.slice(2)) : null)
  if (/^\*\/\d{1,2}$/.test(m) && h === '*' && dow === '*') {
    const every = Number(m.slice(2))
    return every >= 1 && every < 60 ? { kind: 'minutes', every } : null
  }
  if (!INT.test(m) || Number(m) > 59) return null
  const minute = Number(m)
  const hourStep = step(h)
  if (hourStep !== null) return dow === '*' && hourStep >= 1 && hourStep < 24 ? { kind: 'hours', minute, every: hourStep } : null
  if (!INT.test(h) || Number(h) > 23) return null
  const hour = Number(h)
  if (dow === '*') return { kind: 'days', minute, hour, days: 'all' }
  const days = new Set<number>()
  for (const part of dow.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (from > to || to > 7) return null
      for (let day = from; day <= to; day += 1) days.add(day % 7)
    } else if (/^\d$/.test(part) && Number(part) <= 7) days.add(Number(part) % 7)
    else return null
  }
  return { kind: 'days', minute, hour, days: [...days].sort((a, b) => a - b) }
}

const sameDays = (days: number[], wanted: number[]) => days.length === wanted.length && days.every((day, index) => day === wanted[index])

function daysText(days: number[] | 'all', long: boolean): string {
  if (days === 'all' || days.length === 7) return long ? 'Every day' : 'Daily'
  if (sameDays(days, [1, 2, 3, 4, 5])) return long ? 'Monday to Friday' : 'Weekdays'
  if (sameDays(days, [0, 6])) return long ? 'Saturday and Sunday' : 'Weekends'
  if (days.length === 1) return long ? `Every ${WEEKDAY_NAMES[days[0]]}` : `${WEEKDAY_NAMES[days[0]]}s`
  const order = [1, 2, 3, 4, 5, 6, 0].filter((day) => days.includes(day))
  return order.map((day) => WEEKDAY_NAMES[day].slice(0, 3)).join(', ')
}

/** "Weekdays at 9:00", "Every 2 hours", or null for a cron expression that is not one of the simple forms. */
export function humanCron(expr: string | undefined, long = false): string | null {
  const cron = parseSimpleCron(expr)
  if (!cron) return null
  if (cron.kind === 'minutes') return `Every ${cron.every} min`
  if (cron.kind === 'hours') {
    const base = cron.every === 1 ? 'Hourly' : `Every ${cron.every} hours`
    return cron.minute === 0 ? base : `${base} at :${String(cron.minute).padStart(2, '0')}`
  }
  return `${daysText(cron.days, long)} at ${clockText(cron.hour, cron.minute)}`
}

function intervalText(minutes: number | undefined): string {
  const value = minutes ?? 0
  if (value === 60) return 'Hourly'
  if (value > 60 && value % 1440 === 0) return value === 1440 ? 'Every day' : `Every ${value / 1440} days`
  if (value > 60 && value % 60 === 0) return `Every ${value / 60} hours`
  return `Every ${value} min`
}

/**
 * The common schedules, each kept in a representation the scheduler already has: an hourly interval, and cron
 * expressions the scheduler reads on this computer's clock (`computeNextRun` uses local time).
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{
  value: Exclude<SchedulePreset, 'custom'>
  label: string
  summary: string
  schedule: { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string }
}> = [
  { value: 'hourly', label: 'Hourly', summary: 'Every hour', schedule: { kind: 'interval', minutes: 60 } },
  { value: 'daily', label: `Daily ${clockText(9, 0)}`, summary: `Every day at ${clockText(9, 0)}`, schedule: { kind: 'cron', expr: '0 9 * * *' } },
  { value: 'weekdays', label: `Weekdays ${clockText(9, 0)}`, summary: `Monday to Friday at ${clockText(9, 0)}`, schedule: { kind: 'cron', expr: '0 9 * * 1-5' } }
]

/** The preset a schedule is, read from its saved form; anything else is custom. */
export function presetOf(schedule: Pick<JobSchedule, 'kind' | 'minutes' | 'expr'>): SchedulePreset {
  const expr = schedule.expr?.trim().split(/\s+/).join(' ')
  for (const preset of SCHEDULE_PRESETS) {
    const wanted = preset.schedule
    if (wanted.kind === 'interval' && schedule.kind === 'interval' && schedule.minutes === wanted.minutes) return preset.value
    if (wanted.kind === 'cron' && schedule.kind === 'cron' && expr === wanted.expr) return preset.value
  }
  return 'custom'
}

/** The schedule in a few words for a row: "Weekdays at 9:00", "Every 30 min", "Once, tomorrow 10:00", "Only when run". */
export function describeSchedule(schedule: JobSchedule, now: Date = new Date()): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${relativeWhen(schedule.runAt, now)}` : 'Once'
    case 'interval':
      return intervalText(schedule.minutes)
    case 'cron':
      return humanCron(schedule.expr) ?? 'Custom schedule'
    case 'manual':
      return 'Only when run'
  }
}

/** The schedule as a sentence for the details: "Monday to Friday at 9:00, this computer's time". */
export function describeScheduleLong(schedule: JobSchedule, now: Date = new Date()): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${relativeWhen(schedule.runAt, now)}` : 'Once'
    case 'interval':
      return schedule.minutes === 60 ? 'Every hour' : schedule.minutes === 1 ? 'Every minute' : `Every ${schedule.minutes} minutes`
    case 'cron': {
      const text = humanCron(schedule.expr, true)
      return text ? `${text}, this computer's time` : "A custom schedule, this computer's time"
    }
    case 'manual':
      return 'Only when you run it'
  }
}

/** The schedule as saved, for the details and tooltips: the cron expression or the interval. */
export function scheduleCode(schedule: JobSchedule): string | null {
  if (schedule.kind === 'cron') return schedule.expr?.trim() ?? null
  if (schedule.kind === 'interval') return `${schedule.minutes} min`
  return null
}

/**
 * When a new task would first run, for the quick-add preview only. Intervals count from now; the simple cron forms
 * are read on this computer's clock as the scheduler reads them. Anything else is null (the row shows the stored next run once saved).
 */
export function firstRunOf(schedule: JobSchedule, now: Date = new Date()): Date | null {
  if (schedule.kind === 'interval') return schedule.minutes ? new Date(now.getTime() + schedule.minutes * 60_000) : null
  if (schedule.kind === 'once') return schedule.runAt ? new Date(schedule.runAt) : null
  if (schedule.kind !== 'cron') return null
  const cron = parseSimpleCron(schedule.expr)
  if (!cron) return null
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1)
  for (let step = 0; step < 8 * 24 * 60; step += 1) {
    const at = new Date(candidate.getTime() + step * 60_000)
    const minuteOk = cron.kind === 'minutes' ? at.getMinutes() % cron.every === 0 : at.getMinutes() === cron.minute
    const hourOk = cron.kind === 'days' ? at.getHours() === cron.hour : cron.kind === 'hours' ? at.getHours() % cron.every === 0 : true
    const dayOk = cron.kind !== 'days' || cron.days === 'all' || cron.days.includes(at.getDay())
    if (minuteOk && hourOk && dayOk) return at
  }
  return null
}

/** A task's name from what the person typed: its first sentence, cut to about 70 characters. */
export function nameFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine
  const name = sentence.replace(/[.!]$/, '')
  return name.length > 70 ? `${name.slice(0, 69).trimEnd()}…` : name
}

export type StatusTone = 'ok' | 'bad' | 'warn' | 'strong' | 'muted'
export type StatusGlyphKind = 'scheduled' | 'ok' | 'bad' | 'needs' | 'running' | 'paused'

export interface TaskStatus {
  /** The status part of the second line; empty when the task has not run yet. */
  text: string
  tone: StatusTone
  glyph: StatusGlyphKind
  /** The exact words, for the glyph's tooltip. */
  title: string
}

/** The daemon's reason for a job it paused because "Agents may create jobs" was turned off. */
const AGENTS_OFF_PREFIX = 'Agents may create jobs is off'

/** The newest run record, which says how the last occurrence ended (or that it waits). */
export const newestRecord = (job: ScheduledJob): ScheduledJobRunRecord | undefined => job.runHistory?.[job.runHistory.length - 1]

/**
 * What the task is doing, as the status part of its second line: "Done 9:02", "Running since 14:30",
 * "Failed 14:00 · Timed out", "Needs your answer", "Paused yesterday". `starting` is a Run now press whose run has not shown yet.
 */
export function statusOf(job: ScheduledJob, now: Date = new Date(), starting = false): TaskStatus {
  if (job.liveStatus === 'needs_answer') return { text: 'Needs your answer', tone: 'warn', glyph: 'needs', title: 'A run is waiting for your answer' }
  if (job.liveStatus === 'running' || job.state === 'running') {
    const since = job.runClaim?.claimedAt ? relativeWhen(job.runClaim.claimedAt, now) : ''
    return { text: since ? `Running since ${since}` : 'Running', tone: 'strong', glyph: 'running', title: 'Running' }
  }
  if (job.pendingOccurrence?.state === 'queued' && job.state !== 'paused') {
    return { text: 'Queued', tone: 'muted', glyph: 'running', title: 'Queued behind another run on its thread' }
  }
  if (starting) return { text: 'Starting…', tone: 'strong', glyph: 'running', title: 'Starting' }
  if (job.state === 'paused') {
    const agentsOff = job.pausedReason?.startsWith(AGENTS_OFF_PREFIX)
    const day = relativeDay(job.pausedAt, now)
    return {
      text: agentsOff ? 'Paused · agents were turned off' : day ? `Paused ${day}` : 'Paused',
      tone: 'muted',
      glyph: 'paused',
      title: job.pausedReason ?? 'Paused'
    }
  }
  const record = newestRecord(job)
  const status = record?.status ?? job.lastStatus
  const at = relativeWhen(record?.runAt ?? job.lastRunAt, now)
  const error = (record ? record.error : job.lastError)?.trim()
  const withAt = (word: string) => (at ? `${word} ${at}` : word)
  switch (status) {
    case 'ok':
      return { text: withAt('Done'), tone: 'ok', glyph: 'ok', title: 'The last run finished' }
    case 'error':
      return { text: error ? `${withAt('Failed')} · ${error}` : withAt('Failed'), tone: 'bad', glyph: 'bad', title: error ? `The last run failed: ${error}` : 'The last run failed' }
    case 'interrupted':
      return { text: error ? `${withAt('Interrupted')} · ${error}` : withAt('Interrupted'), tone: 'bad', glyph: 'bad', title: 'The last run was interrupted' }
    case 'uncertain':
      return { text: `${withAt('Stopped')} · may have made changes`, tone: 'warn', glyph: 'needs', title: 'The last run stopped. It may have made changes.' }
    case 'waiting':
      return record?.usageLimitUntil
        ? { text: `Waiting for a usage limit, ${relativeWhen(record.usageLimitUntil, now)}`, tone: 'muted', glyph: 'scheduled', title: 'Waiting for a usage limit to reset' }
        : { text: 'Waiting to run', tone: 'muted', glyph: 'scheduled', title: 'Waiting to run' }
    case 'queued':
      return { text: 'Queued', tone: 'muted', glyph: 'running', title: 'Queued behind another run on its thread' }
  }
  if (job.state === 'error') return { text: error ? `Failed · ${error}` : 'Failed', tone: 'bad', glyph: 'bad', title: error ?? 'The scheduler could not run it' }
  return { text: '', tone: 'muted', glyph: 'scheduled', title: 'Scheduled' }
}

/** A saved time, short: "5 Nov 2026, 14:00" in the person's locale. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'none'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'none'
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function describeWorkspace(workspace: ScheduledJobWorkspace | undefined, job: Pick<ScheduledJob, 'threadId' | 'projectId'>): string | null {
  if (workspace?.kind === 'worktree') return `Worktree ${workspace.path}`
  if (workspace?.kind === 'newWorktree') return 'New worktree per run'
  if (job.threadId) return "The thread's own workspace"
  return workspace?.kind === 'project' || job.projectId ? 'Project checkout' : null
}

/** An error from the main process without the prefix Electron adds. */
export function errorText(error: unknown): string {
  return ipcErrorMessage(error) || String(error)
}

export function describeModel(selection: { model: string } | undefined): string {
  return selection?.model || 'Default model'
}

export function describeMode(mode: 'agent' | 'plan' | undefined): string {
  return mode === 'plan' ? 'Plan' : mode === 'agent' ? 'Agent' : 'Default mode'
}

/** The permission mode a job was set to, or what an unset one follows. */
export function describePermission(mode: PermissionMode | undefined): string {
  return mode ? describePermissionMode(mode) : 'Thread permissions'
}

export const RUN_STATUS_LABEL: Record<ScheduledJobRunRecord['status'], string> = {
  ok: 'Succeeded',
  error: 'Failed',
  interrupted: 'Interrupted',
  waiting: 'Waiting',
  queued: 'Queued behind another run',
  uncertain: 'Uncertain (it may have made changes)'
}

export function describeLastStatus(status: NonNullable<ScheduledJob['lastStatus']>): string {
  return status === 'ok' ? 'Succeeded' : status === 'error' ? 'Failed' : status === 'uncertain' ? 'Uncertain' : status === 'waiting' ? 'Waiting' : 'Interrupted'
}

/** How a run that Run now started is going, in one line, from the record it left (or none yet). */
export function describeRunProgress(name: string, record: ScheduledJobRunRecord | undefined, live: ScheduledJob['liveStatus']): { text: string; failed: boolean } {
  switch (record?.status) {
    case 'ok':
      return { text: `${name} finished.`, failed: false }
    case 'error':
      return { text: record.error ? `${name} failed: ${record.error}` : `${name} failed.`, failed: true }
    case 'interrupted':
      return { text: record.error ? `${name} was interrupted: ${record.error}` : `${name} was interrupted.`, failed: true }
    case 'uncertain':
      return { text: `${name} stopped. It may have made changes.`, failed: true }
    case 'queued':
      return { text: `${name} is queued behind another run.`, failed: false }
    case 'waiting':
      return { text: record.usageLimitUntil ? `${name} waits for a usage limit to reset, ${formatWhen(record.usageLimitUntil)}.` : `${name} is waiting to run.`, failed: false }
  }
  if (live === 'needs_answer') return { text: `${name} needs your answer.`, failed: false }
  if (live) return { text: `${name} is running.`, failed: false }
  return { text: `Starting ${name}.`, failed: false }
}

interface OutcomeText {
  label: string
  /** Shown when the log has no reason of its own for the row. */
  reason: string
  refused: boolean
}

/** How each request ended, in words. A refused request started nothing. */
export const DELIVERY_OUTCOME: Record<ScheduledWebhookDeliveryOutcome, OutcomeText> = {
  accepted: { label: 'Accepted', reason: 'Waiting for the scheduler to start it.', refused: false },
  queued: { label: 'Accepted', reason: 'Waiting in the queue behind another run.', refused: false },
  completed: { label: 'Accepted', reason: 'The run finished.', refused: false },
  failed: { label: 'Accepted', reason: 'The run failed or was interrupted.', refused: false },
  dispatch_failed: { label: 'Accepted', reason: 'The run could not be started.', refused: false },
  uncertain: { label: 'Accepted', reason: 'The run may have made changes before it stopped.', refused: false },
  running: { label: 'Refused', reason: 'The job was already running.', refused: true },
  pending: { label: 'Refused', reason: 'An earlier request is still waiting to start.', refused: true },
  paused: { label: 'Refused', reason: 'The job is paused.', refused: true },
  replay: { label: 'Refused', reason: 'The same signed request was sent again.', refused: true },
  rejected_signature: { label: 'Refused', reason: 'The signature did not match.', refused: true },
  rate_limited: { label: 'Refused', reason: 'Too many requests in a minute.', refused: true },
  too_large: { label: 'Refused', reason: 'The request body was too large.', refused: true }
}

export function describeDelivery(delivery: ScheduledWebhookDelivery): OutcomeText & { detail: string; bytes: string; missing: string | null } {
  const outcome = DELIVERY_OUTCOME[delivery.outcome] ?? { label: delivery.outcome, reason: '', refused: false }
  return {
    ...outcome,
    detail: delivery.error?.trim() || outcome.reason,
    bytes: `${delivery.bodyBytes} ${delivery.bodyBytes === 1 ? 'byte' : 'bytes'}`,
    missing: delivery.missingPlaceholders?.length ? delivery.missingPlaceholders.join(', ') : null
  }
}
