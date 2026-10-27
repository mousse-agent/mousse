import type { TrashRetentionPolicy } from './resourceLifecycle'
import {
  STORAGE_POLICY_MAX_DAYS,
  STORAGE_USAGE_KINDS,
  type StorageCleanupItem,
  type StorageCleanupPlanItem,
  type StorageCleanupPlanToken,
  type StorageCleanupReport,
  type StorageCleanupRule,
  type StoragePolicy,
  type StorageUsageEntry,
  type StorageUsageSnapshot
} from './storage'

/**
 * Checks for replies the Storage page draws. A reply from another machine, an older daemon or a damaged
 * file is untrusted: each parser returns a clean copy or throws `StorageReplyError`, so nothing malformed
 * reaches the screen and a bad figure is never shown as a real one.
 */
export class StorageReplyError extends Error {
  constructor(what: string) {
    super(`Storage reply is not valid: ${what}`)
    this.name = 'StorageReplyError'
  }
}

const MAX_ROWS = 20_000
const MAX_TEXT = 2_000
const RULES: readonly StorageCleanupRule[] = ['worktree-deleted', 'worktree-inactive', 'worktree-merged', 'worktree-orphan', 'browser-capture', 'trash']
const OUTCOMES: readonly StorageCleanupItem['outcome'][] = ['removed', 'kept', 'failed']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const own = (record: Record<string, unknown>, key: string): unknown => Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new StorageReplyError(`${what} is not an object`)
  return value
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StorageReplyError(`${what} is not a count`)
  return value
}

function text(value: unknown, what: string, optional = false, minLength = 0): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > MAX_TEXT || value.length < minLength) throw new StorageReplyError(`${what} is not text`)
  return value
}

function time(value: unknown, what: string): string {
  const raw = text(value, what)!
  if (!Number.isFinite(Date.parse(raw))) throw new StorageReplyError(`${what} is not a time`)
  return raw
}

function flag(value: unknown, what: string): true | undefined {
  if (value === undefined) return undefined
  if (value !== true) throw new StorageReplyError(`${what} is not a flag`)
  return true
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new StorageReplyError(`${what} is not a list`)
  return value
}

function names(value: unknown, what: string): Record<string, string> {
  const source = record(value, what)
  const keys = Object.keys(source)
  if (keys.length > MAX_ROWS) throw new StorageReplyError(`${what} is too long`)
  // A null-prototype copy: an id such as `__proto__` stays an ordinary key.
  const copy: Record<string, string> = Object.create(null)
  for (const key of keys) copy[key] = text(own(source, key), `${what} name`)!
  return copy
}

/** The usage snapshot from `storage.usage`, local or from another machine. */
export function parseUsageSnapshot(value: unknown): StorageUsageSnapshot {
  const raw = record(value, 'usage')
  const entries: StorageUsageEntry[] = list(raw.entries, 'usage entries').map((item) => {
    const entry = record(item, 'usage entry')
    const kind = entry.kind
    if (typeof kind !== 'string' || !STORAGE_USAGE_KINDS.includes(kind as never)) throw new StorageReplyError('usage kind is unknown')
    const projectId = text(entry.projectId, 'project id', true, 1)
    const threadId = text(entry.threadId, 'thread id', true, 1)
    const estimated = flag(entry.estimated, 'estimated')
    const partial = flag(entry.partial, 'partial')
    return {
      kind: kind as StorageUsageEntry['kind'],
      ...(projectId !== undefined ? { projectId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      bytes: count(entry.bytes, 'usage bytes'),
      files: count(entry.files, 'usage files'),
      ...(estimated ? { estimated } : {}),
      ...(partial ? { partial } : {})
    }
  })
  if (typeof raw.partial !== 'boolean') throw new StorageReplyError('usage partial is not a flag')
  const condensed = flag(raw.condensed, 'condensed')
  const usageNames = record(raw.names, 'usage names')
  return {
    measuredAt: time(raw.measuredAt, 'measuredAt'),
    durationMs: count(raw.durationMs, 'durationMs'),
    partial: raw.partial,
    ...(condensed ? { condensed } : {}),
    entries,
    names: { projects: names(usageNames.projects, 'project names'), threads: names(usageNames.threads, 'thread names') }
  }
}

function reportItem(value: unknown): StorageCleanupItem {
  const item = record(value, 'report item')
  if (typeof item.rule !== 'string' || !RULES.includes(item.rule as StorageCleanupRule)) throw new StorageReplyError('report rule is unknown')
  if (typeof item.outcome !== 'string' || !OUTCOMES.includes(item.outcome as StorageCleanupItem['outcome'])) throw new StorageReplyError('report outcome is unknown')
  const threadId = text(item.threadId, 'thread id', true, 1)
  const projectId = text(item.projectId, 'project id', true, 1)
  const approximate = flag(item.bytesApproximate, 'bytesApproximate')
  const lower = flag(item.bytesLowerBound, 'bytesLowerBound')
  return {
    rule: item.rule as StorageCleanupRule,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    label: text(item.label, 'label')!,
    bytes: count(item.bytes, 'item bytes'),
    ...(approximate ? { bytesApproximate: approximate } : {}),
    ...(lower ? { bytesLowerBound: lower } : {}),
    ...(item.files !== undefined ? { files: count(item.files, 'item files') } : {}),
    outcome: item.outcome as StorageCleanupItem['outcome'],
    reason: text(item.reason, 'reason')!
  }
}

/** The last-run report from `storage.cleanup.run` or `storage.cleanup.lastReport`. */
export function parseCleanupReport(value: unknown): StorageCleanupReport {
  const raw = record(value, 'report')
  if (raw.trigger !== 'schedule' && raw.trigger !== 'manual') throw new StorageReplyError('report trigger is unknown')
  if (typeof raw.bytesApproximate !== 'boolean') throw new StorageReplyError('report bytesApproximate is not a flag')
  if (raw.bytesLowerBound !== undefined && typeof raw.bytesLowerBound !== 'boolean') throw new StorageReplyError('report bytesLowerBound is not a flag')
  const counts = record(raw.counts, 'report counts')
  const clockNote = text(raw.clockNote, 'clockNote', true)
  const suspended = text(raw.suspended, 'suspended', true)
  const items = list(raw.items, 'report items').map(reportItem)
  const total = { removed: count(counts.removed, 'removed'), kept: count(counts.kept, 'kept'), failed: count(counts.failed, 'failed') }
  const omitted = count(raw.omittedCount, 'omittedCount')
  // The totals must account for exactly the listed items and the ones left out, or the sentence and the list would disagree.
  if (total.removed + total.kept + total.failed !== items.length + omitted) throw new StorageReplyError('report counts do not match its items')
  for (const outcome of OUTCOMES) if (items.filter((entry) => entry.outcome === outcome).length > total[outcome]) throw new StorageReplyError('report counts do not match its items')
  if (raw.bytesRecovered !== 0 && total.removed === 0) throw new StorageReplyError('report recovered space without removing anything')
  return {
    startedAt: time(raw.startedAt, 'startedAt'),
    completedAt: time(raw.completedAt, 'completedAt'),
    trigger: raw.trigger,
    bytesRecovered: count(raw.bytesRecovered, 'bytesRecovered'),
    bytesApproximate: raw.bytesApproximate,
    ...(raw.bytesLowerBound !== undefined ? { bytesLowerBound: raw.bytesLowerBound as boolean } : {}),
    ...(clockNote !== undefined ? { clockNote } : {}),
    ...(suspended !== undefined ? { suspended } : {}),
    counts: total,
    items,
    omittedCount: omitted
  }
}

/** The dry run from `storage.cleanup.plan`: the items and the token a confirmed run is bounded by. */
export function parseCleanupPlanReply(value: unknown): { plan: StorageCleanupPlanItem[]; token: StorageCleanupPlanToken } {
  const raw = record(value, 'plan reply')
  const token = record(raw.token, 'plan token')
  const issuedAt = token.issuedAt, expiresAt = token.expiresAt
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt < 0 || expiresAt < issuedAt) throw new StorageReplyError('plan token times are not valid')
  const keys = list(token.keys, 'plan token keys').map((key) => text(key, 'plan key', false, 1)!)
  return { plan: parseCleanupPlan(raw.plan), token: { issuedAt, expiresAt, policyDigest: text(token.policyDigest, 'plan digest', false, 1)!, keys } }
}

/** The dry run's items. */
export function parseCleanupPlan(value: unknown): StorageCleanupPlanItem[] {
  return list(value, 'plan').map((entry) => {
    const item = record(entry, 'plan item')
    if (typeof item.rule !== 'string' || !RULES.includes(item.rule as StorageCleanupRule)) throw new StorageReplyError('plan rule is unknown')
    if (item.action !== 'remove' && item.action !== 'keep') throw new StorageReplyError('plan action is unknown')
    const threadId = text(item.threadId, 'thread id', true, 1)
    const projectId = text(item.projectId, 'project id', true, 1)
    const approximate = flag(item.bytesApproximate, 'bytesApproximate')
    const lower = flag(item.bytesLowerBound, 'bytesLowerBound')
    const key = text(item.key, 'key', true, 1)
    return {
      rule: item.rule as StorageCleanupRule,
      ...(key !== undefined ? { key } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      label: text(item.label, 'label')!,
      action: item.action,
      reason: text(item.reason, 'reason')!,
      bytes: count(item.bytes, 'plan bytes'),
      ...(approximate ? { bytesApproximate: approximate } : {}),
      ...(lower ? { bytesLowerBound: lower } : {})
    }
  })
}

function days(value: unknown, what: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > STORAGE_POLICY_MAX_DAYS) throw new StorageReplyError(`${what} is not a number of days`)
  return value
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new StorageReplyError(`${what} is not a flag`)
  return value
}

/** The stored cleanup rules, as `storage.policy` and `storage.configure` return them. */
export function parseStoragePolicy(value: unknown): StoragePolicy {
  const raw = record(value, 'policy')
  // A newer daemon's policy has fields this page does not know; saving it back as version 1 would drop them.
  if (raw.schemaVersion !== 1) throw new StorageReplyError('policy version is not supported')
  const worktrees = record(raw.worktrees, 'worktree rules')
  const browser = record(raw.browser, 'browser rules')
  return {
    schemaVersion: 1,
    worktrees: {
      removeWithDeletedThreads: bool(worktrees.removeWithDeletedThreads, 'removeWithDeletedThreads'),
      inactiveDays: days(worktrees.inactiveDays, 'inactiveDays'),
      removeMerged: bool(worktrees.removeMerged, 'removeMerged')
    },
    browser: { captureDays: days(browser.captureDays, 'captureDays') }
  }
}

export interface StoragePolicyReply {
  /** The recommended rules are waiting for the person to look at them. */
  reviewRecommended: boolean
  trash: TrashRetentionPolicy
  trashSweepStatus: { suspended: boolean; reason?: string }
  policy: StoragePolicy
  clockSuspended: boolean
}

/** The reply of `storage.policy`: both policies and whether either clock guard has paused its rules. */
export function parseStoragePolicyReply(value: unknown): StoragePolicyReply {
  const raw = record(value, 'storage policy')
  const trash = record(raw.trash, 'trash policy')
  const status = record(raw.trashSweepStatus, 'trash status')
  if (trash.schemaVersion !== 1) throw new StorageReplyError('trash policy version is not supported')
  const grace = trash.graceDays
  if (typeof grace !== 'number' || !Number.isSafeInteger(grace) || grace < 1 || grace > STORAGE_POLICY_MAX_DAYS) throw new StorageReplyError('graceDays is not a number of days')
  const reason = text(status.reason, 'trash status reason', true)
  return {
    trash: { schemaVersion: 1, graceDays: grace, automaticPurge: bool(trash.automaticPurge, 'automaticPurge') },
    trashSweepStatus: { suspended: bool(status.suspended, 'suspended'), ...(reason !== undefined ? { reason } : {}) },
    policy: parseStoragePolicy(raw.policy),
    clockSuspended: bool(raw.clockSuspended, 'clockSuspended'),
    reviewRecommended: raw.reviewRecommended === undefined ? false : bool(raw.reviewRecommended, 'reviewRecommended')
  }
}
