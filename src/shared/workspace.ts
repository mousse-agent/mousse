export type RepositoryId = string
export type ConversationBranchId = string
export type TurnId = string
export type ActionId = string
export type OperationId = string

export interface WorkspaceActor {
  kind: 'main' | 'agent' | 'workflow' | 'user' | 'scheduler'
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
  /** The branch Mousse created for the thread. The agent may switch away from it; nothing here follows it. */
  branch: string
  /** Points at the latest snapshot (see `snapshotSha`); at the base commit before the first one. */
  retainedRef: string
  worktreePath: string
  projectRelativeSubdirectory: string
  baseSha: string
  /** The last HEAD Mousse observed in the worktree. Informational: HEAD is the agent's to move. */
  headSha: string
  /** The latest recorded snapshot of the worktree's files; absent until the first one. */
  snapshotSha?: string
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
  /**
   * Not a worktree: the folder is the person's, and its snapshots live in a hidden store (a project without Git, a
   * thread with no project). Only the Undo, review and retention code sees this; it is never written to `workspace.json`.
   */
  snapshotOnly?: true
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

/**
 * What a thread is waiting on; `workspace.getStatus` returns it until it is settled.
 * - `paused`: an operation other than Publish did not finish, or Git cannot read the worktree. Every turn, Undo and
 *   Publish are refused until `operations.recover` settles it.
 * - `merge`: a merge an earlier version of Mousse started is still in progress in `folder`. Nothing is refused;
 *   `operations.abort` with `operationId` aborts it.
 * - `publish`: a Publish did not finish. Nothing is refused; `operations.recover` finds out whether it landed.
 */
export interface WorkspaceRecovery {
  kind: 'paused' | 'merge' | 'publish'
  /** One plain sentence. */
  reason: string
  /** The operation it concerns, when there is one. */
  operationId?: string
  operationType?: string
  /** The folder the merge is in, for `merge`: the worktree or the primary checkout. */
  folder?: string
}

/** The result of `operations.recover`: whether nothing waits any more, and otherwise what still does. */
export interface WorkspaceRecoverResult {
  ok: true
  /** True when nothing waits after recovery. */
  settled: boolean
  /** What still waits, as `workspace.getStatus` reports it, when not settled. */
  recovery?: WorkspaceRecovery
  /** Why it still waits, in plain words, to follow "Still waiting:". */
  stillWaiting?: string
}

export const PENDING_CHANGES_ERROR_CODES = ['workspace_not_clean', 'workspace_conflict'] as const

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
