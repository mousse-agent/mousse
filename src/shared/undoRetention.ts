export interface UndoRetentionEligibility {
  state: 'available' | 'expired' | 'pinned' | 'blocked'
  reason: string
  deadline?: string
}

export interface UndoRetentionPolicy {
  windowMs: number
  migrationGraceMs: number
  maxForwardStepMs: number
  batchSize: number
}

export const DEFAULT_UNDO_RETENTION_POLICY: UndoRetentionPolicy = {
  windowMs: 30 * 24 * 60 * 60 * 1000,
  migrationGraceMs: 30 * 24 * 60 * 60 * 1000,
  maxForwardStepMs: 7 * 24 * 60 * 60 * 1000,
  batchSize: 100
}
