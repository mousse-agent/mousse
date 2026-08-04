export type RepositoryId = string
export type ConversationBranchId = string
export type TurnId = string
export type ActionId = string
export type OperationId = string

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
}

export interface WorkspaceExecutionContext {
  threadId: string
  workspacePath: string
  projectPath: string
  primaryPath: string
  branch?: string
  lifecycle: WorkspaceLifecycle
  capability: WorkspaceCapability
}
