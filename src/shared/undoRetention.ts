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

/** A retention window in words, for a notice: `30 days`, `1 day`, `12 hours`. */
export function retentionWindowText(windowMs: number): string {
  const hours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)))
  if (hours < 48 && hours % 24 !== 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}
