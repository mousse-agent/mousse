/** Versioned lifecycle authority. Paths and inventories are never caller-issued capabilities. */
export const RESOURCE_LIFECYCLE_VERSION = 1 as const
export const RETENTION_CLAIM_KINDS = [
  'current-result', 'undo', 'redo', 'recall', 'conversation-attachment',
  'pending-integration', 'conflict', 'recovery', 'trash-restore', 'user-pin'
] as const
export type RetentionClaimKind = typeof RETENTION_CLAIM_KINDS[number]
export type LifecycleState = 'active' | 'draining' | 'trash-moving' | 'trashed' | 'restore-moving' | 'blocked' | 'purge-started' | 'purged'
export type LifecycleOperationKind = 'trash' | 'restore'
export type LifecycleOperationPhase = 'fenced' | 'drained' | 'move-prepared' | 'moved' | 'indexed' | 'completed' | 'rejected' | 'purge-started'
export interface LifecycleOperationResult {
  operationId: string
  kind: LifecycleOperationKind
  generation: number
  location: string
  state: 'active' | 'trashed'
  completedAt: string
}

export interface ResourceSource {
  /** Source record, not a cached inventory, authorizes this association. */
  id: string
  path: string
  digest: string
  status: 'verified' | 'unknown'
  reason?: string
}
export interface RetentionClaim {
  schemaVersion: 1
  kind: RetentionClaimKind
  sourceId: string
  ownerTaskId: string
  /** A source-record condition, not an arbitrary permanent system pin. */
  condition: string
}
export interface LifecycleResource {
  id: string
  kind: 'task-data' | 'worktree' | 'git-ref' | 'agent-session' | 'artifact' | 'workflow-record' | 'invocation-thread' | 'runtime' | 'unknown'
  identity: string
  ownerTaskId: string
  repositoryId?: string
  materialization: 'present' | 'absent' | 'unknown'
  /** Source associations alone do not prove that physical deletion is safe. */
  ownership?: 'source-associated' | 'verified' | 'unknown'
  sourceIds: string[]
  claims: RetentionClaim[]
}
export interface ResourceInventorySnapshot {
  schemaVersion: 1
  profileId: string
  taskId: string
  generation: number
  observedAt: string
  sources: ResourceSource[]
  resources: LifecycleResource[]
  /** Ambiguity blocks mutations; an empty list never authorizes physical cleanup. */
  blockers: string[]
}
export interface LifecycleOperation {
  id: string
  kind: LifecycleOperationKind
  expectedGeneration: number
  phase: LifecycleOperationPhase
  from: string
  to: string
  startedAt: string
  completedAt?: string
  error?: string
  inventory?: ResourceInventorySnapshot
  runner?: { pid: number; processInstanceId: string; token: string }
  result?: LifecycleOperationResult
}
export interface TaskLifecycleRecord {
  schemaVersion: 1
  minimumWriterVersion: 1
  profileId: string
  taskId: string
  generation: number
  state: LifecycleState
  originalLocation: string
  location: string
  parentTaskId?: string
  /** Independent retention severs execution ownership after the original parent is purged. */
  formerParentTaskId?: string
  /** Historical paths remain fenced after moves; IDs are never recycled. */
  locations: string[]
  operations: LifecycleOperation[]
  createdAt: string
  updatedAt: string
  trashedAt?: string
  blockedReason?: string
  purge?: LifecyclePurgeProgress
  cleanupOwner?: { pid: number; processInstanceId: string; token: string }
}

/** Where Mousse keeps files a restore or an abort set aside before writing over them. */
export const PRESERVED_REFS = 'refs/mousse/preserved/'

/** The thread journal's operation type for an expiry of those files (`expirePreservedFiles`). */
export const PRESERVED_EXPIRY_OPERATION = 'preserved-files-expired'

/** Journal operation types of a copy kept before an action removed files (`keepCopy`): Discard, worktree cleanup, and Abort. */
export const KEEP_COPY_OPERATIONS = ['git-discard', 'worktree-cleanup', 'git-abort'] as const
export type KeepCopyOperation = (typeof KEEP_COPY_OPERATIONS)[number]

/**
 * Operations that settle themselves and change no file before they are settled: an expiry of kept files only records
 * which refs went, and a keep removes nothing before its copy is recorded. One left unfinished pauses nothing.
 */
export function settlesItself(operationType: string): boolean {
  return operationType === PRESERVED_EXPIRY_OPERATION || (KEEP_COPY_OPERATIONS as readonly string[]).includes(operationType)
}

/** Whether a purge item is files a restore or an abort kept (a `refs/mousse/preserved/` ref), which may be the only copy of a file. */
export function isKeptFilesItem(item: Pick<LifecyclePurgeItem, 'kind' | 'identity'>): boolean {
  return item.kind === 'ref' && item.identity.startsWith(PRESERVED_REFS)
}

export interface LifecyclePurgeItem {
  id: string
  kind: 'worktree' | 'ref' | 'path' | 'scheduled-row'
  identity: string
  ownerTaskId: string
  commonDir?: string
  expectedValue?: string
  manifestPath?: string
  content?: Array<{ path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }>
  rootIdentity?: { dev: number; ino: number; birthtimeMs: number }
  discardRequired?: boolean
  discardState?: 'pending' | 'cleared'
  branch?: string
  sourcePath?: string
  rowId?: string
  indexDigest?: string
  status: 'pending' | 'removed' | 'retained'
  reason?: string
}
export interface LifecyclePurgePreview {
  schemaVersion: 1
  taskId: string
  generation: number
  digest: string
  items: LifecyclePurgeItem[]
  ownedTaskIds: string[]
  blockers: string[]
  /** Kept, with why. `unverifiedOwner` is the thread whose checkout can't be verified and whose records name it. */
  retained: Array<{ identity: string; reason: string; unverifiedOwner?: string }>
  exclusiveBytes: number
}

/**
 * Why the thread can't be deleted yet: something of it is kept back because another thread, whose worktree can't be
 * checked, may still use it (`retained` entries with `unverifiedOwner`). Deleting the thread then would leave what is
 * kept with no thread to own it, and nothing in the app could delete it later; so the thread stays in the trash, owning
 * it, until that worktree can be checked again. One line per such thread.
 */
export function unverifiedHolds(preview: Pick<LifecyclePurgePreview, 'retained'>): string[] {
  return [...new Set(preview.retained.filter((item) => item.unverifiedOwner).map((item) => item.reason))]
    .map((reason) => `${reason} What this thread may share with it stays in the trash with this thread until Mousse can check that worktree again.`)
}
export interface LifecyclePurgeProgress extends LifecyclePurgePreview {
  operationId: string
  startedAt: string
  completedAt?: string
  error?: string
  discardAuthorized: boolean
}
export interface TrashRetentionPolicy { schemaVersion: 1; graceDays: number; automaticPurge: boolean }
export interface LifecycleAdmission {
  profileId: string
  taskId: string
  generation: number
  location: string
  ancestors?: Array<{ taskId: string; generation: number }>
}
