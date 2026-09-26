export type RepositoryId = string
export type ConversationBranchId = string
export type TurnId = string
export type ActionId = string
export type OperationId = string

export interface WorkspaceActor {
  kind: 'main' | 'agent' | 'workflow' | 'user' | 'scheduler' | 'channel'
  id?: string
  definitionId?: string
}

/** Immutable attribution; execution runs reference a workspace, never own its identity. */
export interface WorkspaceProvenance {
  ownerThreadId: string
  parentWorkspaceId?: string
  actor?: WorkspaceActor
  runId?: string
}

export type WorkspaceLifecycle =
  | 'unprovisioned'
  | 'provisioning'
  | 'ready'
  | 'missing'
  | 'conflicted'
  | 'tombstoned'
  | 'recovery_required'

export interface WorkspaceCapability {
  gitBacked: boolean
  checkpointable: boolean
  publishable: boolean
  undoable: boolean
  unavailableReason?: string
}

export interface RepositoryContextData {
  repositoryId: RepositoryId
  gitTopLevel: string
  gitCommonDirectory: string
  primaryCheckoutPath: string
  projectRelativeSubdirectory: string
  worktreeBase: string
  capability: WorkspaceCapability
}

export interface ThreadWorkspaceMetadata {
  schemaVersion: 1
  threadId: string
  repositoryId: RepositoryId
  conversationBranchId: ConversationBranchId
  branch: string
  retainedRef: string
  worktreePath: string
  projectRelativeSubdirectory: string
  baseSha: string
  headSha: string
  lifecycle: WorkspaceLifecycle
  lastVerifiedAt: string
  workspaceId?: string
  generation?: number
  provenance?: WorkspaceProvenance
  integrationTarget?: { checkoutPath: string; baseSha: string }
}

export interface WorkspaceExecutionContext {
  threadId: string
  workspacePath: string
  projectPath: string
  primaryPath: string
  branch?: string
  lifecycle: WorkspaceLifecycle
  capability: WorkspaceCapability
  workspaceId?: string
  generation?: number
  baseSha?: string
  headSha?: string
  provenance?: WorkspaceProvenance
}
