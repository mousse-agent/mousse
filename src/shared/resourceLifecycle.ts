/** Versioned lifecycle authority. Paths and inventories are never caller-issued capabilities. */
export const RESOURCE_LIFECYCLE_VERSION = 1 as const
export const RETENTION_CLAIM_KINDS = [
  'current-result', 'undo', 'redo', 'recall', 'conversation-attachment',
  'pending-integration', 'conflict', 'recovery', 'trash-restore', 'user-pin'
] as const
export type RetentionClaimKind = typeof RETENTION_CLAIM_KINDS[number]
export type LifecycleState = 'active' | 'draining' | 'trash-moving' | 'trashed' | 'restore-moving' | 'blocked' | 'purge-started' | 'purged'
export type LifecycleOperationKind = 'trash' | 'restore'
export type LifecycleOperationPhase = 'fenced' | 'drained' | 'move-prepared' | 'moved' | 'indexed' | 'completed' | 'rejected'
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
  /** Historical paths remain fenced after moves; IDs are never recycled. */
  locations: string[]
  operations: LifecycleOperation[]
  createdAt: string
  updatedAt: string
  blockedReason?: string
}
export interface LifecycleAdmission {
  profileId: string
  taskId: string
  generation: number
  location: string
  ancestors?: Array<{ taskId: string; generation: number }>
}
