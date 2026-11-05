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
  { value: 'hourly', label: 'Hourly', summary: 'Every 60 minutes.', schedule: { kind: 'interval', minutes: 60 } },
  { value: 'daily', label: 'Daily at 09:00', summary: "Every day at 09:00, this computer's time.", schedule: { kind: 'cron', expr: '0 9 * * *' } },
  { value: 'weekdays', label: 'Weekdays at 09:00', summary: "Monday to Friday at 09:00, this computer's time.", schedule: { kind: 'cron', expr: '0 9 * * 1-5' } }
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

export function describeSchedule(schedule: JobSchedule): string {
  const preset = presetOf(schedule)
  if (preset !== 'custom') return SCHEDULE_PRESETS.find((item) => item.value === preset)!.label
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${formatWhen(schedule.runAt)}` : 'Once'
    case 'interval':
      return `Every ${schedule.minutes} min`
    case 'cron':
      return `Cron ${schedule.expr}`
    case 'manual':
      return 'Manual'
  }
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
