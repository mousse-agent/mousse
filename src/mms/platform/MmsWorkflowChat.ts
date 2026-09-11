import { v5 as uuidv5 } from 'uuid'
import type { WorkflowChatRun } from '../../shared/workflowChat'
import type { WorkflowRunState } from '../../shared/workflowRunPlatform'
import type { WorkflowRunSnapshot } from '../../shared/workflows'

export type WorkflowChatSource = 'gui' | 'cli' | 'channel' | 'schedule'
export const WORKFLOW_CHAT_SOURCES: readonly WorkflowChatSource[] = ['gui', 'cli', 'channel', 'schedule']

export interface ChannelWorkflowHostIngress {
  platform: string
  chatId: string
  messageId: string
}

export interface ScheduledJobIngress {
  jobId: string
  occurrenceAt: string
  threadId?: string
  projectId?: string
  createThread?: boolean
  jobName?: string
}

export interface BackgroundWorkflowTurnResult {
  text: string
  silent: boolean
  error?: string
  aborted?: boolean
  waiting?: boolean
  transcriptWritten?: boolean
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

export function assertWorkflowHostToken(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw new Error('Invalid ' + label)
  }
}

/** Host-owned channel message identity. Caller request IDs are ignored. */
export function channelWorkflowInvocationId(identity: ChannelWorkflowHostIngress): string {
  assertWorkflowHostToken(identity.platform, 'channel platform')
  assertWorkflowHostToken(identity.chatId, 'channel chat')
  assertWorkflowHostToken(identity.messageId, 'channel message')
  return uuidv5(`mousse-channel-workflow:${identity.platform}:${identity.chatId}:${identity.messageId}`, uuidv5.URL)
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
