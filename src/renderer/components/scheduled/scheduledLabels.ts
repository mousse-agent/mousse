import { ipcErrorMessage } from '../../utils/voiceErrors'
import { describePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { clockText, dayOffset, parseSimpleCron, relativeWhen, WEEKDAY_NAMES } from '../../../shared/scheduleLabel'
import type {
  JobSchedule,
  ScheduledJob,
  ScheduledJobRunRecord,
  ScheduledJobWorkspace,
  ScheduledWebhookDelivery,
  ScheduledWebhookDeliveryOutcome
} from '../../../shared/types'

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'custom'

// Moved to `src/shared/scheduleLabel.ts` so bots word schedules the same way; re-exported here.
export { clockText, describeSchedule, describeScheduleLong, humanCron, parseSimpleCron, relativeWhen, type SimpleCron } from '../../../shared/scheduleLabel'

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

export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: WEEKDAY_NAMES[day] }))

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
