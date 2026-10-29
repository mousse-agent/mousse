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
  /**
   * The worktree holds commits from someone else (a pull request's head). It is made and kept with hooks,
   * filter and smudge drivers switched off in its own configuration, so no Git command run in it executes
   * anything the commits carry.
   */
  untrusted?: true
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

/** Why a thread is refused every turn, Undo and Publish; `workspace.getStatus` returns it while recovery is needed. */
export interface WorkspaceRecovery {
  /** One plain sentence. */
  reason: string
  /** The unfinished operation that needs recovery, when there is one. */
  operationId?: string
  operationType?: string
  /** Set when the worktree is on another branch than the thread's (an agent checked out its own). */
  branch?: { expected: string; actual: string }
}

/** The result of `operations.recover`; `switchBack` puts the worktree back on the thread's branch first. */
export interface WorkspaceRecoverResult {
  ok: true
  /** Set when the worktree was switched back; the branch it left, which keeps the agent's commits. */
  switchedFrom?: string
  message?: string
}

export const PENDING_CHANGES_ERROR_CODES =['workspace_not_clean', 'workspace_conflict'] as const

/**
 * `details` of a `workspace_conflict` (or `workspace_not_clean`) error. Mousse sets aside or saves ordinary
 * uncommitted changes itself; only a conflict or a Git operation in progress stops it.
 */
export interface PendingChangesDetails {
  label: string
  /** The folder, as an absolute path on the computer that runs the thread. */
  path: string
  /** The first few changed (or conflicted) files, relative to the folder. */
  files: string[]
  count: number
  conflict: boolean
  operation?: 'merge' | 'revert' | 'cherry-pick' | 'rebase'
  /** The thread worktree's changes can be dropped with `workspace.discardPendingChanges` (never during a rebase). */
  discard: boolean
}

/** The details of a refusal that offers Discard, when `error` is one. */
export function pendingChangesDetails(error: unknown): PendingChangesDetails | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, details } = error as { code?: unknown; details?: unknown }
  if (!PENDING_CHANGES_ERROR_CODES.includes(code as (typeof PENDING_CHANGES_ERROR_CODES)[number])) return undefined
  if (!details || typeof details !== 'object') return undefined
  const value = details as Record<string, unknown>
  if (typeof value.path !== 'string' || value.discard !== true) return undefined
  const operation = value.operation === 'merge' || value.operation === 'revert' || value.operation === 'cherry-pick' ? value.operation : undefined
  return {
    label: typeof value.label === 'string' ? value.label : 'Workspace',
    path: value.path,
    files: Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === 'string') : [],
    count: typeof value.count === 'number' ? value.count : 0,
    conflict: value.conflict === true,
    ...(operation ? { operation } : {}),
    discard: true
  }
}
