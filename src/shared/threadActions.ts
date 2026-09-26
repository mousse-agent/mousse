import type { ActionId, ConversationBranchId, OperationId, TurnId, WorkspaceActor } from './workspace'

/** Persisted once in the operation journal; actions and workflow results reference this ID. */
export interface ChangeReceipt {
  id: string
  operationId: string
  workspaceId: string
  generation: number
  kind: 'checkpoint' | 'integration' | 'undo' | 'redo' | 'revert' | 'publish'
  actor: WorkspaceActor
  turnId?: string
  runId?: string
  actionId?: string
  beforeSha: string
  afterSha: string
  introducedCommits: string[]
  contributions: Array<{ receiptId?: string; actorId?: string; baseSha: string; resultSha: string }>
  retainedRefs: string[]
  externalEffects: ExternalEffect[]
  reversesReceiptId?: string
  publishedReceiptIds?: string[]
  createdAt: string
}

export type ThreadActionState =
  | 'planned'
  | 'running'
  | 'checkpointing'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'undoing'
  | 'undo_conflict'
  | 'undone'

export interface NativeContextBoundary {
  messageIndex: number
  activeStartIndex?: number
  compactionGeneration: number
  fidelity: 'exact' | 'compacted' | 'legacy'
  compaction?: import('./types').NativeCompactionCheckpoint
  acceptedQueueItemIds?: string[]
  acceptedSteerItemIds?: string[]
  safeBoundaryProof?: string
}

export interface ExternalEffect {
  kind: 'ignored-file' | 'outside-workspace' | 'mcp' | 'network' | 'process' | 'database' | 'unknown'
  description: string
  reversible: false
}

export interface ChildIntegrationRecord {
  receiptId?: string
  operationId?: string
  preMergeSha?: string
  agentId: string
  spawnBaseSha: string
  workerHeadSha: string
  integrationSha: string
  mainlineParent: number
  changedPaths: string[]
}

export interface ThreadAction {
  /** Live projection only; the retention journal remains authoritative. */
  retention?: import('./undoRetention').UndoRetentionEligibility
  receiptId?: string
  actor?: WorkspaceActor
  runId?: string
  id: ActionId
  turnId: TurnId
  conversationBranchId: ConversationBranchId
  parentActionId?: ActionId
  presentationMessageStart: number
  presentationMessageEnd: number
  /** Context position before the turn was admitted; conversation undo restores here. */
  nativeContextStartBoundary?: NativeContextBoundary
  /** Context position after the turn settled; forks restore this point. */
  nativeContextBoundary: NativeContextBoundary
  startSha: string
  endSha: string
  commits: string[]
  childIntegrations: ChildIntegrationRecord[]
  changedPaths: Array<{ path: string; beforeHash?: string; afterHash?: string }>
  externalEffects: ExternalEffect[]
  reversible: boolean
  state: ThreadActionState
  compensationActionId?: ActionId
  createdAt: string
  completedAt?: string
}

export interface ConversationBranch {
  id: ConversationBranchId
  name: string
  parentBranchId?: ConversationBranchId
  parentTurnId?: TurnId
  gitBranch: string
  retainedRef: string
  activeActionId?: ActionId
  contextBoundary: NativeContextBoundary
  lifecycle: 'active' | 'inactive' | 'tombstoned'
  creationReason: 'initial' | 'fork' | 'undo' | 'recovery'
  createdAt: string
}

export interface ThreadOperation {
  id: OperationId
  type: 'checkpoint' | 'integrate' | 'publish' | 'undo' | 'revert' | 'fork' | 'redo' | 'trash' | 'restore'
  actionId?: ActionId
  conversationBranchId: ConversationBranchId
  state: string
  owner: string
  expectedGitState?: unknown
  conflictFiles?: string[]
  error?: string
  recoveryDecision?: string
  createdAt: string
  updatedAt: string
}
