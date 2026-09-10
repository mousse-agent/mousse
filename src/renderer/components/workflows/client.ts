import type { AgentDefinitionsClient } from '../agentDefinitions/client'
import type {
  CompiledWorkflow,
  WorkflowBundle,
  WorkflowDiagnostic,
  WorkflowDraftRecord,
  WorkflowHeadManifest,
  WorkflowListItem,
  WorkflowLockDocument,
  WorkflowRecordSource,
  WorkflowRevisionRecord
} from '../../../shared/workflows'

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

export interface WorkflowClientErrorShape {
  code: string
  message: string
  retryable?: boolean
  details?: Record<string, unknown>
}

export class WorkflowUiClientError extends Error implements WorkflowClientErrorShape {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  constructor(code: string, message: string, options?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message)
    this.name = 'WorkflowUiClientError'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.details = options?.details
  }
}

export function isWorkflowClientError(error: unknown): error is WorkflowClientErrorShape {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error)
}

export function isRevisionConflict(error: unknown): boolean {
  if (!isWorkflowClientError(error)) return false
  return error.code === 'REVISION_CONFLICT' || error.code === 'WORKFLOW_CONCURRENCY_CONFLICT'
}

/** Host-enriched library row. Diagnostics and last-run are optional; the daemon is authoritative. */
export interface WorkflowLibraryItem extends WorkflowListItem {
  tags?: string[]
  updatedAt?: string
  lastRunAt?: string
  lastRunStatus?: WorkflowRunState
  lastRunId?: string
  issues?: WorkflowDiagnostic[]
  runnable?: boolean
}

export interface WorkflowDocument {
  profileId: string
  id: string
  slug: string
  name: string
  description?: string
  source: WorkflowRecordSource
  archived?: boolean
  tags?: string[]
  bundle: WorkflowBundle
  compiled: CompiledWorkflow
  semanticHash: string
  visualHash: string
  draft?: WorkflowDraftRecord
  head?: WorkflowHeadManifest | null
  savedAt?: string
}

export interface WorkflowRevisionSummary {
  revisionId: string
  semanticHash: string
  visualHash: string
  publishedAt: string
  slug: string
  name: string
  lock?: WorkflowLockDocument
}

export interface WorkflowValidateRequest {
  profileId: string
  id?: string
  bundle: WorkflowBundle
  mode?: 'draft' | 'publish'
}

export interface WorkflowValidateResult {
  compiled: CompiledWorkflow
  diagnostics: WorkflowDiagnostic[]
  runnable: boolean
}

export interface WorkflowSaveDraftRequest {
  profileId: string
  id: string
  expectedDraftSemanticHash: string | null
  expectedHeadRevisionId?: string | null
  bundle: WorkflowBundle
  visualOnly?: boolean
}

export interface WorkflowPublishRequest {
  profileId: string
  id: string
  expectedDraftSemanticHash: string
  expectedHeadRevisionId?: string | null
}

/**
 * Typed definitions port. Root binds this to `workflows.*` protocol methods after
 * profile binding. Production UI never constructs a success-faking adapter.
 *
 * Host adaptation to W02 `WorkflowRegistry` happens at root. This port includes
 * `profileId` on every call so a late reply from another profile cannot be applied.
 */
export interface WorkflowDefinitionsClient {
  list(query: { profileId: string; archived?: boolean }): Promise<WorkflowLibraryItem[]>
  get(query: { profileId: string; id: string }): Promise<WorkflowDocument>
  getRevision?(query: { profileId: string; id: string; revisionId: string }): Promise<WorkflowDocument>
  create(query: {
    profileId: string
    name?: string
    slug?: string
    templateId?: string
    bundle?: WorkflowBundle
  }): Promise<WorkflowDocument>
  saveDraft(query: WorkflowSaveDraftRequest): Promise<WorkflowDocument>
  publish(query: WorkflowPublishRequest): Promise<WorkflowDocument>
  archive?(query: { profileId: string; id: string }): Promise<void>
  duplicate?(query: { profileId: string; id: string }): Promise<WorkflowDocument>
  importBundle(query: {
    profileId: string
    bundle: WorkflowBundle
    conflict?: 'fail' | 'rename'
  }): Promise<WorkflowDocument>
  exportBundle(query: { profileId: string; id: string; revision?: string }): Promise<WorkflowBundle>
  validate(query: WorkflowValidateRequest): Promise<WorkflowValidateResult>
  listRevisions?(query: { profileId: string; id: string }): Promise<WorkflowRevisionSummary[]>
  restoreRevision?(query: {
    profileId: string
    id: string
    revisionId: string
    expectedDraftSemanticHash: string
  }): Promise<WorkflowDocument>
}

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
}

export interface WorkflowPendingApproval {
  approvalId: string
  runId: string
  nodeId: string
  instanceKey: string
  attempt: number
  description: string
  expiresAt?: string
}

export interface WorkflowPendingInput {
  runId: string
  nodeId: string
  instanceKey: string
  prompt: string
  schema?: Record<string, unknown>
}

export interface WorkflowUnknownEffect {
  runId: string
  nodeId: string
  instanceKey: string
  attempt: number
  description: string
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
  pendingApproval?: WorkflowPendingApproval
  pendingInput?: WorkflowPendingInput
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
}

export interface WorkflowStartRequest {
  profileId: string
  definitionId: string
  revisionId?: string
  /** When true, host snapshots and validates the draft first. */
  draft?: boolean
  input: unknown
  threadId?: string
  projectId?: string
}

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

/**
 * Typed execution port aligned with W02 `WorkflowRuntimePort`.
 * Optional methods are capability-gated in the UI: missing means disabled
 * with a reason, never a fake success.
 */
export interface WorkflowExecutionClient {
  start(query: WorkflowStartRequest): Promise<WorkflowRunView>
  get(query: { profileId: string; runId: string }): Promise<WorkflowRunView>
  list?(query: { profileId: string; definitionId?: string }): Promise<WorkflowRunView[]>
  pause?(query: { profileId: string; runId: string }): Promise<WorkflowRunView>
  resume?(query: { profileId: string; runId: string }): Promise<WorkflowRunView>
  cancel(query: { profileId: string; runId: string; reason?: string }): Promise<WorkflowRunView>
  approve?(query: WorkflowApproveRequest): Promise<WorkflowRunView>
  answer?(query: WorkflowAnswerRequest): Promise<WorkflowRunView>
  reconcile?(query: WorkflowReconcileRequest): Promise<WorkflowRunView>
  subscribe(
    query: { profileId: string; runId: string },
    listener: (snapshot: WorkflowRunView) => void
  ): WorkflowSubscribeHandle
  dryRun?(query: WorkflowStartRequest): Promise<WorkflowRunView>
  setBreakpoint?(query: { profileId: string; runId?: string; nodeId: string; enabled: boolean }): Promise<void>
}

export interface WorkflowEditorSkillOption {
  id: string
  name: string
  revision?: string
  available: boolean
}

export interface WorkflowEditorMcpToolOption {
  toolName: string
  available: boolean
}

export interface WorkflowEditorMcpServerOption {
  serverId: string
  name: string
  tools: WorkflowEditorMcpToolOption[]
}

export interface WorkflowEditorCatalogs {
  skills: WorkflowEditorSkillOption[]
  mcpServers: WorkflowEditorMcpServerOption[]
  builtinTools: Array<{ id: string; label: string }>
  subworkflows: Array<{ id: string; name: string; slug: string; revision?: string }>
  browserWorkspaces: Array<{ id: string; name: string }>
  models?: Array<{ providerId: string; modelId: string; label: string; available: boolean }>
}

export type WorkflowLeaveReason = 'navigate' | 'profile' | 'unmount'
export type WorkflowLeaveGuard = (reason: WorkflowLeaveReason) => Promise<boolean>

export interface WorkflowEditorHostPorts {
  definitions: WorkflowDefinitionsClient
  execution?: WorkflowExecutionClient
  agentDefinitions?: AgentDefinitionsClient
  catalogs: WorkflowEditorCatalogs
}

export const EMPTY_WORKFLOW_CATALOGS: WorkflowEditorCatalogs = {
  skills: [],
  mcpServers: [],
  builtinTools: [],
  subworkflows: [],
  browserWorkspaces: []
}

export const WORKFLOW_RUN_STATE_LABELS: Record<WorkflowRunState, string> = {
  queued: 'Queued',
  running: 'Running',
  'waiting-approval': 'Waiting for approval',
  'waiting-input': 'Waiting for input',
  'waiting-condition': 'Waiting for condition',
  cancelling: 'Cancelling',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  'unknown-effect': 'Unknown effect',
  'recovery-required': 'Recovery required'
}
