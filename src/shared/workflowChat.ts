import type { WorkflowRunState } from './workflowRunPlatform'

/** Durable chat reference. Authority and the pinned input remain in MMS. */
export interface WorkflowChatRun {
  invocationId: string
  profileId: string
  threadId: string
  definitionId: string
  revisionId: string
  runId: string
  title: string
  state: WorkflowRunState
}
