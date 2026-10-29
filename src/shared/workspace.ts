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

/**
 * What the user can do about pending changes that block a workspace operation. `save` records them as
 * their own checkpoint (in the primary checkout, a commit); `discard` drops them after keeping a copy
 * under `refs/mousse/discarded/`. Discard always needs the user's confirmation.
 */
export type PendingChangesAction = 'save' | 'discard'
/** The folder that has the changes: the thread's own worktree, or the project's primary checkout. */
export type PendingChangesFolder = 'thread' | 'primary'
export const PENDING_CHANGES_ERROR_CODES = ['workspace_not_clean', 'workspace_conflict'] as const

/** `details` of a `workspace_not_clean` or `workspace_conflict` error. */
export interface PendingChangesDetails {
  label: string
  /** The folder, as an absolute path on the computer that runs the thread. */
  path: string
  /** Set when the folder is one the user can act on through `workspace.resolvePendingChanges`. */
  folder?: PendingChangesFolder
  /** The first few changed (or conflicted) files, relative to the folder. */
  files: string[]
  count: number
  conflict: boolean
  actions: PendingChangesAction[]
}

/** The pending-changes details of a failure, when it is one and offers at least one action. */
export function pendingChangesDetails(error: unknown): PendingChangesDetails | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, details } = error as { code?: unknown; details?: unknown }
  if (!PENDING_CHANGES_ERROR_CODES.includes(code as (typeof PENDING_CHANGES_ERROR_CODES)[number])) return undefined
  if (!details || typeof details !== 'object') return undefined
  const value = details as Record<string, unknown>
  const actions = Array.isArray(value.actions) ? value.actions.filter((item): item is PendingChangesAction => item === 'save' || item === 'discard') : []
  if (typeof value.path !== 'string' || (value.folder !== 'thread' && value.folder !== 'primary') || actions.length === 0) return undefined
  return {
    label: typeof value.label === 'string' ? value.label : 'Workspace',
    path: value.path,
    folder: value.folder,
    files: Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === 'string') : [],
    count: typeof value.count === 'number' ? value.count : 0,
    conflict: value.conflict === true,
    actions
  }
}
