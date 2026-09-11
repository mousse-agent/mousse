/** Public workflow run DTOs. Execution actor, policy and source are server-owned. */
export const WORKFLOW_RUN_CAPABILITY = 'workflowRuns.v1'
export const WORKFLOW_RUN_METHODS = [
  'workflowRuns.start', 'workflowRuns.get', 'workflowRuns.list', 'workflowRuns.trace',
  'workflowRuns.pause', 'workflowRuns.resume', 'workflowRuns.cancel',
  'workflowRuns.approve', 'workflowRuns.answer', 'workflowRuns.reconcile'
] as const
export type WorkflowRunMethod = (typeof WORKFLOW_RUN_METHODS)[number]
export interface WorkflowRunRequester {
  request<T>(method: WorkflowRunMethod, params: unknown): Promise<T>
}

/**
 * UI-facing run states aligned with W02 `WorkflowRunState`.
 * Hyphenated values match the runtime branch; host adapters must not
 * silently translate these into a fake success.
 */
export type WorkflowRunState =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'waiting-condition'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown-effect'
  | 'recovery-required'

export type WorkflowNodeAttemptOutcome =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'unknown'
  | 'waiting'

export interface WorkflowNodeAttemptView {
  instanceKey: string
  nodeId: string
  type: string
  attempt: number
  path?: string
  outcome: WorkflowNodeAttemptOutcome
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
  effect?: string
  input?: unknown
  output?: unknown
  artifacts?: WorkflowArtifactView[]
  childRunId?: string
}

export interface WorkflowArtifactView {
  id: string
  displayName: string
  mediaType: string
  byteLength: number
  sha256?: string
}

export interface WorkflowRunEvent {
  seq: number
  at: string
  kind: string
  runId: string
  nodeId?: string
  instanceKey?: string
  message: string
  payload?: Record<string, unknown>
  payloadTruncated?: boolean
}

export interface WorkflowPendingApproval {
  approvalId: string
  runId: string
  nodeId: string
  instanceKey: string
  attempt: number
  description: string
  expiresAt?: string
  childRunId?: string
}

export interface WorkflowPendingInput {
  runId: string
  nodeId: string
  instanceKey: string
  prompt: string
  schema?: Record<string, unknown>
  childRunId?: string
}

export interface WorkflowPendingCondition {
  runId: string
  nodeId: string
  instanceKey: string
  wakeAt?: string
  childRunId?: string
  childState?: 'unknown-effect'
}

export interface WorkflowUnknownEffect {
  runId: string
  nodeId: string
  instanceKey: string
  attempt: number
  description: string
  childRunId?: string
}

export interface WorkflowRunView {
  runId: string
  profileId: string
  definitionId: string
  revisionId?: string
  semanticHash?: string
  slug?: string
  state: WorkflowRunState
  /** Honest origin. Fixture adapters must set this so UI never implies a live run. */
  origin: 'host' | 'fixture'
  startedAt?: string
  updatedAt?: string
  input?: unknown
  result?: unknown
  error?: string
  events: WorkflowRunEvent[]
  attempts: WorkflowNodeAttemptView[]
  artifacts: WorkflowArtifactView[]
  /** The desktop transfers bounded previews; persisted execution data stays exact. */
  truncated?: { events?: boolean; attempts?: boolean; artifacts?: boolean; waits?: boolean; result?: boolean }
  counts?: { events: number; attempts: number; artifacts: number; waits?: number }
  pendingApproval?: WorkflowPendingApproval
  pendingInput?: WorkflowPendingInput
  /** All independently actionable waits. Singleton fields remain compatibility projections. */
  pendingApprovals?: WorkflowPendingApproval[]
  pendingInputs?: WorkflowPendingInput[]
  pendingConditions?: WorkflowPendingCondition[]
  unknownEffect?: WorkflowUnknownEffect
  budgets?: {
    elapsedMs: number
    maxElapsedMs?: number
    toolCalls?: number
    tokens?: number
    cost?: number
    artifactBytes?: number
  }
  currentNodeId?: string
  journalSequence?: number
}

interface WorkflowStartRequestBase {
  /** Reuse after a transport failure until admission is acknowledged. */
  requestId: string
  profileId: string
  definitionId: string
  input: unknown
  threadId?: string
  projectId?: string
}

export type WorkflowStartRequest = WorkflowStartRequestBase &
  (
    | {
        /** The host snapshots and validates this exact saved draft. */
        draft: true
        expectedDraftSemanticHash: string
        revisionId?: never
      }
    | {
        draft?: false
        revisionId?: string
        expectedDraftSemanticHash?: never
      }
  )

export interface WorkflowApproveRequest {
  profileId: string
  runId: string
  approvalId: string
  nodeId: string
  instanceKey: string
  attempt: number
  approved: boolean
}

export interface WorkflowAnswerRequest {
  profileId: string
  runId: string
  nodeId: string
  instanceKey: string
  data: unknown
}

export interface WorkflowReconcileRequest {
  profileId: string
  runId: string
  nodeId: string
  instanceKey: string
  attempt: number
  decision: 'retry' | 'fail' | 'accept'
}

export interface WorkflowSubscribeHandle {
  unsubscribe(): void
}

/** Generated once by an interactive client; a retry reuses the same requestId. */
export type WorkflowRunStartParams = WorkflowStartRequest
export interface WorkflowRunListParams { profileId: string; definitionId?: string; threadId?: string; before?: string; limit?: number }
export interface WorkflowRunListPage { runs: WorkflowRunView[]; nextCursor?: string }
export interface WorkflowRunTraceParams { profileId: string; runId: string; afterSequence?: number; limit?: number }
export interface WorkflowRunTracePage { events: WorkflowRunEvent[]; afterSequence: number; hasMore: boolean }
