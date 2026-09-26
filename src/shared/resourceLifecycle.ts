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
  retained: Array<{ identity: string; reason: string }>
  exclusiveBytes: number
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
