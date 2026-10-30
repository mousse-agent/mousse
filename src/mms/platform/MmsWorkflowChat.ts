import { v5 as uuidv5 } from 'uuid'
import type { ModelOverride } from '../../shared/providerInstances'
import type { ScheduledJobWorkspace } from '../../shared/types'
import type { AgentAccessLevel } from '../../shared/settings'
import type { PermissionMode } from '../../shared/permissionMode'
import type { WorkflowChatRun } from '../../shared/workflowChat'
import type { WorkflowRunState } from '../../shared/workflowRunPlatform'
import type { WorkflowRunSnapshot } from '../../shared/workflows'

/** Where a slash workflow came from; `remote` is a turn sent through the remote bridge (`runRemoteTurn`). */
export type WorkflowChatSource = 'gui' | 'cli' | 'remote' | 'schedule'
export const WORKFLOW_CHAT_SOURCES: readonly WorkflowChatSource[] = ['gui', 'cli', 'remote', 'schedule']

export interface ScheduledJobIngress {
  jobId: string
  occurrenceAt: string
  threadId?: string
  projectId?: string
  createThread?: boolean
  jobName?: string
  resumeWaiting?: boolean
  onWorkflowPrepared?: (invocationId: string) => void
  /** The provider instance and model the run uses; absent = the thread's model, else the profile default. */
  selection?: ModelOverride
  mode?: 'agent' | 'plan'
  workspace?: ScheduledJobWorkspace
  /** The job's permission mode and ceiling (`ScheduledJob`); the run is the stricter of the two and its thread's mode. */
  permissionMode?: PermissionMode
  permissionCeiling?: PermissionMode
  /** The most agent access the run may be granted (`ScheduledJob.accessCap`); absent reads as `lineage`. */
  accessCap?: AgentAccessLevel
  /** Names the occurrence; the deterministic send receipt is `schedule:<jobId>:<occurrenceKey>`. Defaults to `occurrenceAt`. */
  occurrenceKey?: string
  /** What the claim already recorded, so a retry reuses its thread. */
  claim?: { threadId?: string; runId?: string }
  /** The occurrence chose its thread (a per-run thread was created, or the bound thread was found). */
  onThreadChosen?: (threadId: string) => void
  /** The run was admitted (accepted and new), before anything is queued or started. */
  onAdmitted?: (runId: string) => void
}

export interface BackgroundWorkflowTurnResult {
  text: string
  silent: boolean
  error?: string
  aborted?: boolean
  waiting?: boolean
  transcriptWritten?: boolean
  /** `queued`: the occurrence waits behind a busy thread. `replayed`: the occurrence was already admitted; its run is observed. */
  status?: 'queued' | 'replayed'
  threadId?: string
  runId?: string
  queueItemId?: string
  /** The model the run's binding used, when it was bound by the time the call returned. */
  selection?: ModelOverride
  /** The permission mode the run's binding enforced, when it was bound by the time the call returned. */
  permissionMode?: PermissionMode
}

const WAITING = new Set<WorkflowRunState>(['waiting-approval', 'waiting-input', 'waiting-condition'])
const SETTLED = new Set<WorkflowRunState>([
  'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown-effect',
  'waiting-approval', 'waiting-input', 'waiting-condition'
])

export function isBackgroundWorkflowWaiting(state: WorkflowRunState): boolean {
  return WAITING.has(state)
}

export function isBackgroundWorkflowObserved(state: WorkflowRunState): boolean {
  return SETTLED.has(state)
}

export function isBackgroundWorkflowTerminal(state: WorkflowRunState): boolean {
  return SETTLED.has(state) && !WAITING.has(state)
}

export function assertWorkflowHostToken(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw new Error('Invalid ' + label)
  }
}

/** Host-owned scheduled occurrence identity. Caller request IDs are ignored. */
export function scheduleWorkflowInvocationId(identity: Pick<ScheduledJobIngress, 'jobId' | 'occurrenceAt'>): string {
  assertWorkflowHostToken(identity.jobId, 'schedule job')
  if (typeof identity.occurrenceAt !== 'string' || !identity.occurrenceAt.trim() || identity.occurrenceAt.length > 64 || identity.occurrenceAt.includes('\0')) {
    throw new Error('Untrusted schedule occurrence cannot authorize a workflow invocation')
  }
  return uuidv5(`mousse-schedule-workflow:${identity.jobId}:${identity.occurrenceAt}`, uuidv5.URL)
}

export function formatBackgroundWorkflowDelivery(run: WorkflowChatRun, snapshot: WorkflowRunSnapshot): string {
  const state = snapshot.manifest.state
  const title = run.title
  const header = `Workflow ${title}\nRun: ${run.runId}\nRevision: ${run.revisionId}\nState: ${state}`
  if (state === 'waiting-approval') return header + '\nWaiting for approval; the run remains durable.'
  if (state === 'waiting-input') return header + '\nWaiting for input; the run remains durable.'
  if (state === 'waiting-condition') return header + '\nWaiting; the run remains durable.'
  if (state === 'succeeded') {
    return snapshot.result === undefined ? header : header + '\nResult: ' + JSON.stringify(snapshot.result)
  }
  if (state === 'cancelled') return header + '\nThe workflow was cancelled.'
  if (state === 'failed') return header + (snapshot.manifest.terminalError ? '\n' + snapshot.manifest.terminalError : '')
  if (state === 'interrupted' || state === 'unknown-effect') {
    return header + (snapshot.manifest.terminalError ? '\n' + snapshot.manifest.terminalError : '')
  }
  return header
}
