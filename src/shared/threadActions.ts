import type { ActionId, ConversationBranchId, OperationId, TurnId } from './workspace'

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
  compactionGeneration: number
  fidelity: 'exact' | 'compacted' | 'legacy'
  safeBoundaryProof?: string
}

export interface ExternalEffect {
  kind: 'ignored-file' | 'outside-workspace' | 'mcp' | 'network' | 'process' | 'database' | 'unknown'
  description: string
  reversible: false
}

export interface ChildIntegrationRecord {
  agentId: string
  spawnBaseSha: string
  workerHeadSha: string
  integrationSha: string
  mainlineParent: number
  changedPaths: string[]
}

export interface ThreadAction {
  id: ActionId
  turnId: TurnId
  conversationBranchId: ConversationBranchId
  parentActionId?: ActionId
  presentationMessageStart: number
  presentationMessageEnd: number
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
