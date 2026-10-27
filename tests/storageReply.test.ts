import { describe, expect, it } from 'vitest'
import type { StorageCleanupReport, StorageUsageSnapshot } from '../src/shared/storage'
import {
  StorageReplyError,
  parseCleanupPlan,
  parseCleanupReport,
  parseStoragePolicy,
  parseStoragePolicyReply,
  parseUsageSnapshot
} from '../src/shared/storageReply'

const usage = (): StorageUsageSnapshot => ({
  measuredAt: '2026-10-27T10:00:00.000Z',
  durationMs: 1200,
  partial: false,
  entries: [
    { kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 2048, files: 12 },
    { kind: 'logs', bytes: 10, files: 1, estimated: true, partial: true }
  ],
  names: { projects: { p1: 'Mousse' }, threads: { t1: 'Fix storage' } }
})

const report = (): StorageCleanupReport => ({
  startedAt: '2026-10-27T10:00:00.000Z',
  completedAt: '2026-10-27T10:00:05.000Z',
  trigger: 'manual',
  bytesRecovered: 4096,
  bytesApproximate: false,
  counts: { removed: 1, kept: 1, failed: 0 },
  items: [
    { rule: 'worktree-inactive', threadId: 't1', label: 'Fix storage', bytes: 4096, outcome: 'removed', reason: 'Inactive for 40 days' },
    { rule: 'worktree-merged', label: 'Other', bytes: 0, outcome: 'kept', reason: 'Has 1 unpublished commit' }
  ],
  omittedCount: 0
})

describe('usage reply validation', () => {
  it('accepts a well-formed reply and returns a clean copy', () => {
    const parsed = parseUsageSnapshot({ ...usage(), extra: 'ignored', entries: [{ ...usage().entries[0], path: 'C:\\secret' }] })
    expect(parsed.entries[0]).toEqual({ kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 2048, files: 12 })
    expect(parsed).not.toHaveProperty('extra')
    expect(parseUsageSnapshot(usage()).names.threads.t1).toBe('Fix storage')
  })

  it('keeps a condensed marker and rejects any other value for it', () => {
    expect(parseUsageSnapshot({ ...usage(), condensed: true }).condensed).toBe(true)
    expect(() => parseUsageSnapshot({ ...usage(), condensed: 'yes' })).toThrow(StorageReplyError)
  })

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an array', []],
    ['no entries', { ...usage(), entries: undefined }],
    ['entries not a list', { ...usage(), entries: {} }],
    ['unknown kind', { ...usage(), entries: [{ kind: 'secrets', bytes: 1, files: 1 }] }],
    ['inherited kind name', { ...usage(), entries: [{ kind: 'toString', bytes: 1, files: 1 }] }],
    ['negative bytes', { ...usage(), entries: [{ kind: 'logs', bytes: -1, files: 1 }] }],
    ['fractional bytes', { ...usage(), entries: [{ kind: 'logs', bytes: 1.5, files: 1 }] }],
    ['string bytes', { ...usage(), entries: [{ kind: 'logs', bytes: '10', files: 1 }] }],
    ['unsafe bytes', { ...usage(), entries: [{ kind: 'logs', bytes: 2 ** 60, files: 1 }] }],
    ['non-text thread id', { ...usage(), entries: [{ kind: 'logs', bytes: 1, files: 1, threadId: 7 }] }],
    ['partial flag as text', { ...usage(), entries: [{ kind: 'logs', bytes: 1, files: 1, partial: 'true' }] }],
    ['missing time', { ...usage(), measuredAt: undefined }],
    ['unreadable time', { ...usage(), measuredAt: 'yesterday-ish' }],
    ['partial not a flag', { ...usage(), partial: 'no' }],
    ['no names', { ...usage(), names: undefined }],
    ['names not text', { ...usage(), names: { projects: { p1: 4 }, threads: {} } }],
    ['negative duration', { ...usage(), durationMs: -5 }]
  ])('rejects %s', (_label, value) => {
    expect(() => parseUsageSnapshot(value)).toThrow(StorageReplyError)
  })

  it('keeps an id such as __proto__ as an ordinary name and never touches prototypes', () => {
    const raw = JSON.parse('{"measuredAt":"2026-10-27T10:00:00.000Z","durationMs":1,"partial":false,"entries":[],"names":{"projects":{"__proto__":"x"},"threads":{}}}')
    const parsed = parseUsageSnapshot(raw)
    expect(Object.getPrototypeOf(parsed.names.projects)).toBeNull()
    expect(Object.keys(parsed.names.projects)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('refuses an endless list before drawing it', () => {
    const entries = Array.from({ length: 20_001 }, () => ({ kind: 'logs', bytes: 1, files: 1 }))
    expect(() => parseUsageSnapshot({ ...usage(), entries })).toThrow(StorageReplyError)
  })
})

describe('cleanup reply validation', () => {
  it('accepts a report and a plan', () => {
    expect(parseCleanupReport(report())).toEqual(report())
    const plan = [{ rule: 'trash', label: '2 threads in the trash', action: 'remove', reason: 'Retention passed', bytes: 5, bytesApproximate: true }]
    expect(parseCleanupPlan(plan)).toEqual(plan)
  })

  it.each([
    ['unknown trigger', { ...report(), trigger: 'webhook' }],
    ['unknown rule', { ...report(), items: [{ ...report().items[0], rule: 'delete-everything' }] }],
    ['unknown outcome', { ...report(), items: [{ ...report().items[0], outcome: 'vaporised' }] }],
    ['counts as text', { ...report(), counts: { removed: '1', kept: 0, failed: 0 } }],
    ['negative recovered bytes', { ...report(), bytesRecovered: -1 }],
    ['no reason', { ...report(), items: [{ ...report().items[0], reason: undefined }] }],
    ['items not a list', { ...report(), items: 'none' }]
  ])('rejects a report with %s', (_label, value) => {
    expect(() => parseCleanupReport(value)).toThrow(StorageReplyError)
  })

  it.each([
    ['not a list', { plan: [] }],
    ['unknown action', [{ rule: 'trash', label: 'x', action: 'purge', reason: 'r', bytes: 0 }]],
    ['unknown rule', [{ rule: 'x', label: 'x', action: 'keep', reason: 'r', bytes: 0 }]],
    ['bytes as text', [{ rule: 'trash', label: 'x', action: 'keep', reason: 'r', bytes: '0' }]]
  ])('rejects a plan that is %s', (_label, value) => {
    expect(() => parseCleanupPlan(value)).toThrow(StorageReplyError)
  })
})

describe('policy reply validation', () => {
  const policy = { schemaVersion: 1, worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: false }, browser: { captureDays: null } }

  it('accepts stored policies and the clock flags', () => {
    expect(parseStoragePolicy(policy)).toEqual(policy)
    const reply = parseStoragePolicyReply({ trash: { schemaVersion: 1, graceDays: 30, automaticPurge: false }, trashSweepStatus: { suspended: true, reason: 'Clock moved' }, policy, clockSuspended: false })
    expect(reply.trashSweepStatus).toEqual({ suspended: true, reason: 'Clock moved' })
    expect(reply.policy).toEqual(policy)
  })

  it.each([
    ['0 days', { ...policy, worktrees: { ...policy.worktrees, inactiveDays: 0 } }],
    ['4000 days', { ...policy, worktrees: { ...policy.worktrees, inactiveDays: 4000 } }],
    ['text days', { ...policy, browser: { captureDays: '30' } }],
    ['a flag as a number', { ...policy, worktrees: { ...policy.worktrees, removeMerged: 1 } }],
    ['no worktree rules', { ...policy, worktrees: undefined }]
  ])('rejects a policy with %s', (_label, value) => {
    expect(() => parseStoragePolicy(value)).toThrow(StorageReplyError)
  })

  it('rejects a reply without a trash policy', () => {
    expect(() => parseStoragePolicyReply({ trashSweepStatus: { suspended: false }, policy, clockSuspended: false })).toThrow(StorageReplyError)
  })
})
