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
 * What a profile gets until it saves a policy: remove the worktrees of deleted threads (what deleting a
 * thread already does), remove worktrees inactive for 30 days or already merged, and delete browser
 * captures after 30 days. Every rule keeps unpublished work, and a profile that already saved a policy
 * keeps what it saved. The Storage page shows each of these and can turn each off.
 */
export const STORAGE_POLICY_DEFAULTS: StoragePolicy = {
  schemaVersion: 1,
  worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: true },
  browser: { captureDays: 30 }
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

/** One line of a dry run: what a run would do with an item right now, and why. Nothing has been changed. */
export interface StorageCleanupPlanItem {
  rule: StorageCleanupRule
  threadId?: string
  projectId?: string
  label: string
  action: 'remove' | 'keep'
  reason: string
  /** Space a removal would free (0 for a kept item), measured the way a run measures it. */
  bytes: number
  bytesApproximate?: true
  bytesLowerBound?: true
}

// ---- Disk usage ----

/** What a measured folder holds. `other` is everything under Mousse's data that is not one of the four named kinds. */
export type StorageUsageKind = 'threads' | 'worktrees' | 'browser' | 'logs' | 'other'

export const STORAGE_USAGE_KINDS: readonly StorageUsageKind[] = ['threads', 'worktrees', 'browser', 'logs', 'other']

export const STORAGE_USAGE_KIND_LABELS: Record<StorageUsageKind, string> = {
  threads: 'Threads',
  worktrees: 'Worktrees',
  browser: 'Browser data',
  logs: 'Logs',
  other: 'Other'
}

/**
 * Space held for one project and thread. Subagents count under their root thread. An entry with no
 * `threadId` is not attributed to a live thread (logs, trash, unclaimed worktrees); with no `projectId`
 * it is not attributed to a project. Nothing here is a path.
 */
export interface StorageUsageEntry {
  kind: StorageUsageKind
  projectId?: string
  threadId?: string
  bytes: number
  files: number
  /** The figure is not exact: logical size on Windows, or some entries could not be read. */
  estimated?: true
  /** The measurement was cut short, so the figure is a lower bound. */
  partial?: true
}

export interface StorageUsageSnapshot {
  /** The oldest measurement behind any entry (ISO time). */
  measuredAt: string
  /** How long the latest scan took. */
  durationMs: number
  /** Some entry is missing, from an older scan, or was cut short. Older and newer numbers are never presented as one fresh scan. */
  partial: boolean
  /** Per-thread detail was folded into project or kind totals to keep the answer small. */
  condensed?: true
  entries: StorageUsageEntry[]
  /** Display names for the ids used by `entries`, nothing else. */
  names: { projects: Record<string, string>; threads: Record<string, string> }
}

export interface UsageMachine { node: string; name: string }
export type MachineUsageEntry = StorageUsageEntry & { machine: UsageMachine }
export type UsageGroupBy = 'project' | 'kind' | 'thread'
export interface UsageNames { projects: Record<string, string>; threads: Record<string, string> }

export interface UsageGroup {
  /** Unique within one view; machine-qualified except in the kind view. */
  key: string
  label: string
  /** Absent in the kind view, which sums across machines. */
  machine?: UsageMachine
  id?: string
  kind?: StorageUsageKind
  bytes: number
  share: number
}

export const USAGE_THREAD_LIMIT = 10
const OTHER_ID = '\u0000other'

/**
 * Groups usage rows for the chart and table. The kind view sums across machines; the project and
 * thread views keep one row per machine, so identical ids on two machines stay separate. The thread
 * view lists the biggest ten and folds the rest, and anything not attributed, into "Other" per
 * machine. `names` maps a machine's `node` to the names its snapshot carried.
 */
export function groupUsage(rows: readonly MachineUsageEntry[], by: UsageGroupBy, names: Readonly<Record<string, UsageNames>> = {}): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()
  const add = (group: Omit<UsageGroup, 'share' | 'bytes'>, bytes: number): void => {
    const existing = groups.get(group.key)
    if (existing) existing.bytes += bytes
    else groups.set(group.key, { ...group, bytes, share: 0 })
  }
  for (const row of rows) {
    if (row.bytes <= 0) continue
    const machine = row.machine
    if (by === 'kind') {
      add({ key: row.kind, label: STORAGE_USAGE_KIND_LABELS[row.kind], kind: row.kind }, row.bytes)
    } else if (by === 'project') {
      const id = row.projectId
      add({ key: `${machine.node}:${id ?? OTHER_ID}`, label: id ? names[machine.node]?.projects[id] ?? 'Unnamed project' : 'Other', machine, ...(id ? { id } : {}) }, row.bytes)
    } else {
      const id = row.threadId
      add({ key: `${machine.node}:${id ?? OTHER_ID}`, label: id ? names[machine.node]?.threads[id] ?? 'Unnamed thread' : 'Other', machine, ...(id ? { id } : {}) }, row.bytes)
    }
  }
  let list = [...groups.values()]
  if (by === 'thread') {
    const named = list.filter((group) => group.id).sort((a, b) => b.bytes - a.bytes)
    const keep = new Set(named.slice(0, USAGE_THREAD_LIMIT).map((group) => group.key))
    const folded = new Map<string, UsageGroup>()
    for (const group of list) {
      if (keep.has(group.key)) continue
      const key = `${group.machine!.node}:${OTHER_ID}`
      const into = folded.get(key)
      if (into) into.bytes += group.bytes
      else folded.set(key, { key, label: 'Other', machine: group.machine, bytes: group.bytes, share: 0 })
    }
    list = [...list.filter((group) => keep.has(group.key)), ...folded.values()]
  }
  const total = list.reduce((sum, group) => sum + group.bytes, 0)
  for (const group of list) group.share = total > 0 ? group.bytes / total : 0
  const isOther = (group: UsageGroup): number => (by !== 'kind' && !group.id ? 1 : group.kind === 'other' ? 1 : 0)
  return list.sort((a, b) => isOther(a) - isOther(b) || b.bytes - a.bytes || a.label.localeCompare(b.label))
}

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
