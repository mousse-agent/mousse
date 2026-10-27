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

export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt ? `Once, ${new Date(schedule.runAt).toLocaleString()}` : 'Once'
    case 'interval':
      return schedule.minutes === 60 ? 'Hourly' : `Every ${schedule.minutes} min`
    case 'cron':
      return `Cron ${schedule.expr}`
    case 'manual':
      return 'Manual'
  }
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
