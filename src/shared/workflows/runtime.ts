import type {
  ArtifactReference,
  EffectClass,
  ExecutionActor,
  ExecutionContext,
  ExecutionPolicyLayer,
  ExecutionPolicySnapshot,
  ExecutionSource
} from '../execution/types'
import type { BoundedJsonSchema } from './schema'
import type { WorkflowBundle } from './bundle'
import type { CompiledWorkflow } from './compiled'
import type { WorkflowLimits } from './manifest'

export type WorkflowRunState =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'waiting-condition'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown-effect'

export type WorkflowNodeAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'unknown'

export interface WorkflowTriggerPayload {
  kind: 'gui' | 'cli' | 'schedule' | 'channel' | 'control'
  triggerId?: string
  projectId?: string
  threadId: string
  capturedAt: string
}

export interface WorkflowBudgetSnapshot {
  elapsedMs: number
  toolCalls: number
  tokens: number
  cost: number
  artifactBytes: number
  maxElapsedMs: number
  maxToolCalls: number
  maxArtifactBytes: number
}

export interface WorkflowNodeAttempt {
  instanceKey: string
  nodeId: string
  type: string
  attempt: number
  path: string
  inputHash: string
  outputHash?: string
  effect: EffectClass
  idempotencyKey: string
  outcome: WorkflowNodeAttemptOutcome
  startedAt: string
  completedAt?: string
  error?: string
  pid?: number
  childIds?: string[]
}

export interface WorkflowJournalEvent {
  seq: number
  at: string
  kind:
    | 'run-accepted'
    | 'run-started'
    | 'attempt-prepared'
    | 'attempt-dispatched'
    | 'attempt-completed'
    | 'attempt-unknown'
    | 'node-skipped'
    | 'wait-checkpoint'
    | 'state-changed'
    | 'lease-heartbeat'
  runId: string
  instanceKey?: string
  payload: Record<string, unknown>
}

export interface WorkflowRunManifest {
  schemaVersion: 1
  runId: string
  profileId: string
  threadId: string
  projectId?: string
  definitionId: string
  revisionId: string
  semanticHash: string
  slug: string
  inputArtifactId?: string
  policySnapshotId: string
  cancellationId: string
  actor: ExecutionActor
  source: ExecutionSource
  trigger?: WorkflowTriggerPayload
  state: WorkflowRunState
  journalSeq: number
  limits: WorkflowLimits
  budgets: WorkflowBudgetSnapshot
  parentRunId?: string
  depth: number
  createdAt: string
  updatedAt: string
  terminalError?: string
}

export interface WorkflowRunSnapshot {
  manifest: WorkflowRunManifest
  compiled: CompiledWorkflow
  attempts: WorkflowNodeAttempt[]
  artifacts: ArtifactReference[]
  outputs: Record<string, unknown>
  result?: unknown
  pendingApprovalId?: string
  pendingInput?: { instanceKey: string; schema?: BoundedJsonSchema; prompt: string }
  wakeAt?: string
}

export interface WorkflowTrace {
  runId: string
  state: WorkflowRunState
  events: WorkflowJournalEvent[]
  attempts: WorkflowNodeAttempt[]
  nodeOutputs: Record<string, unknown>
}

export interface StartWorkflowRequest {
  profileId: string
  threadId: string
  projectId?: string
  actor: ExecutionActor
  source: ExecutionSource
  definitionId?: string
  slug?: string
  revisionId?: string
  input: unknown
  trigger?: WorkflowTriggerPayload
  installationPolicy: ExecutionPolicyLayer
  runPolicy?: ExecutionPolicyLayer
  parentRunId?: string
  depth?: number
}

export interface WorkflowRuntimePort {
  start(request: StartWorkflowRequest): Promise<WorkflowRunSnapshot>
  list(query: { profileId: string; threadId?: string }): Promise<WorkflowRunManifest[]>
  get(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot>
  trace(runId: string, owner: { profileId: string }): Promise<WorkflowTrace>
  pause(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot>
  resume(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot>
  approve(
    runId: string,
    owner: { profileId: string },
    decision: { approvalId: string; approved: boolean; actorId: string }
  ): Promise<WorkflowRunSnapshot>
  answer(
    runId: string,
    owner: { profileId: string },
    answer: { instanceKey: string; data: unknown }
  ): Promise<WorkflowRunSnapshot>
  cancel(runId: string, owner: { profileId: string }, reason?: string): Promise<WorkflowRunSnapshot>
  tick(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot>
  subscribe(
    runId: string,
    owner: { profileId: string },
    listener: (snapshot: WorkflowRunSnapshot) => void
  ): { close(): void }
}

export interface WorkflowClock {
  now(): Date
  wait(ms: number, signal?: AbortSignal): Promise<void>
}

export interface WorkflowFaultHooks {
  afterIntent?(instanceKey: string): void
  afterDispatch?(instanceKey: string): void
  afterResult?(instanceKey: string): void
  afterCheckpoint?(runId: string): void
}

export interface DurableApprovalRecord {
  approvalId: string
  profileId: string
  runId: string
  actor: ExecutionActor
  nodeId: string
  instanceKey: string
  attempt: number
  definitionId: string
  revisionId: string
  policySnapshotId: string
  requestDigest: string
  description: string
  createdAt: string
  expiresAt: string
  consumedAt?: string
  revokedAt?: string
  decision?: 'approved' | 'denied'
  decidedBy?: string
}

export type { ArtifactReference, ExecutionContext, ExecutionPolicySnapshot, WorkflowBundle }
