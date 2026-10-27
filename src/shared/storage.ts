import type { TrashRetentionPolicy } from './resourceLifecycle'

/** Storage cleanup rules kept next to the trash policy (`storage-policy.json`). `null` turns a rule off. */
export interface StoragePolicy {
  schemaVersion: 1
  worktrees: {
    removeWithDeletedThreads: boolean
    inactiveDays: number | null
    removeMerged: boolean
  }
  browser: {
    captureDays: number | null
  }
}

export const STORAGE_POLICY_MAX_DAYS = 3650

/**
 * Remove-with-deleted-threads is on because that is what deleting a thread already does. The other
 * rules are off until the Storage page can show and change them.
 */
export const STORAGE_POLICY_DEFAULTS: StoragePolicy = {
  schemaVersion: 1,
  worktrees: { removeWithDeletedThreads: true, inactiveDays: null, removeMerged: false },
  browser: { captureDays: null }
}

/** True when any cleanup rule, including automatic trash emptying, would act on a run. */
export function storagePolicyHasRule(policy: StoragePolicy, trash: TrashRetentionPolicy): boolean {
  return trash.automaticPurge
    || policy.worktrees.removeWithDeletedThreads
    || policy.worktrees.inactiveDays !== null
    || policy.worktrees.removeMerged
    || policy.browser.captureDays !== null
}

export type StorageCleanupRule =
  | 'worktree-deleted'
  | 'worktree-inactive'
  | 'worktree-merged'
  | 'worktree-orphan'
  | 'browser-capture'
  | 'trash'

export interface StorageCleanupItem {
  rule: StorageCleanupRule
  threadId?: string
  projectId?: string
  label: string
  /** Space recovered when `removed`; space the item holds otherwise. */
  bytes: number
  /** The measurement was estimated (logical size) or cut short. */
  bytesApproximate?: true
  /** The measurement was cut short and counted allocated space only, so the real figure is at least this. */
  bytesLowerBound?: true
  files?: number
  outcome: 'removed' | 'kept' | 'failed'
  reason: string
}

export interface StorageCleanupReport {
  startedAt: string
  completedAt: string
  trigger: 'schedule' | 'manual'
  bytesRecovered: number
  /** Some removed item was estimated or cut short, so `bytesRecovered` is not exact. */
  bytesApproximate: boolean
  /** `bytesRecovered` is a proven lower bound: every approximate removed item was cut short, none estimated. */
  bytesLowerBound?: boolean
  clockNote?: string
  suspended?: string
  counts: { removed: number; kept: number; failed: number }
  items: StorageCleanupItem[]
  omittedCount: number
}

export const REPORT_ENTRY_LIMIT = 200

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** One plain sentence for the last-run summary. An approximate figure says so. */
export function summarizeCleanupReport(report: StorageCleanupReport): string {
  const { removed, kept, failed } = report.counts
  if (removed + kept + failed === 0) return 'Nothing needed cleanup.'
  const counts = `Removed ${removed}, kept ${kept}, failed ${failed}.`
  if (removed === 0 || report.bytesRecovered === 0) return `${counts} No space recovered.`
  const size = formatBytes(report.bytesRecovered)
  if (report.bytesLowerBound) return `${counts} At least ${size} recovered.`
  if (report.bytesApproximate) return `${counts} About ${size} recovered.`
  return `${counts} ${size} recovered.`
}
