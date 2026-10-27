import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORAGE_POLICY_DEFAULTS, STORAGE_POLICY_EXISTING_INSTALL, storagePolicyHasRule, type StoragePolicy } from '../src/shared/storage'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { StoragePolicyStore } from '../src/mms/lifecycle/StoragePolicyStore'
import { StorageSweepClock, STORAGE_CLOCK_BACKWARD_TOLERANCE_MS } from '../src/mms/lifecycle/sweepClock'
import { ResourcePurgeService } from '../src/mms/lifecycle/ResourcePurgeService'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(onConfigured?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-storage-policy-')); roots.push(root)
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: join(root, 'profile') })
  const clockState = { now: 1_700_000_000_000 }
  const clock = new StorageSweepClock(store.root, () => clockState.now); clock.start()
  return { root, store, clock, clockState, policy: new StoragePolicyStore(store, clock, onConfigured) }
}
const valid = (worktrees: Partial<StoragePolicy['worktrees']> = {}, captureDays: number | null = 30): StoragePolicy => ({
  schemaVersion: 1,
  worktrees: { removeWithDeletedThreads: true, inactiveDays: 30, removeMerged: true, ...worktrees },
  browser: { captureDays }
})

describe('StoragePolicyStore', () => {
  it('starts from the defaults without writing a file', () => {
    const f = fixture()
    expect(f.policy.policy()).toEqual(STORAGE_POLICY_DEFAULTS)
    expect(existsSync(join(f.store.root, 'storage-policy.json'))).toBe(false)
    expect(f.policy.policy()).not.toBe(STORAGE_POLICY_DEFAULTS)
  })

  it('saves a valid policy next to the trash policy and reads it back', () => {
    const f = fixture()
    expect(f.policy.configure(valid(), true)).toEqual(valid())
    expect(JSON.parse(readFileSync(join(f.store.root, 'storage-policy.json'), 'utf8'))).toEqual(valid())
    expect(new StoragePolicyStore(f.store, f.clock).policy()).toEqual(valid())
  })

  it.each([
    ['zero days', valid({ inactiveDays: 0 })],
    ['more than ten years', valid({ inactiveDays: 3651 })],
    ['a fraction', valid({ inactiveDays: 1.5 })],
    ['a string', valid({ inactiveDays: '30' as never })],
    ['negative capture days', valid({}, -1)],
    ['capture days over the bound', valid({}, 4000)],
    ['a missing flag', { ...valid(), worktrees: { inactiveDays: 30, removeMerged: true } } as never],
    ['an unknown schema', { ...valid(), schemaVersion: 2 } as never],
    ['nothing', undefined as never]
  ])('refuses %s', (_name, input) => {
    const f = fixture()
    expect(() => f.policy.configure(input, true)).toThrow(/Invalid storage policy/)
    expect(existsSync(join(f.store.root, 'storage-policy.json'))).toBe(false)
  })

  it('accepts the bounds and off', () => {
    const f = fixture()
    expect(f.policy.configure(valid({ inactiveDays: 1 }, 3650), true).worktrees.inactiveDays).toBe(1)
    expect(f.policy.configure(valid({ inactiveDays: null }, null), true)).toMatchObject({ worktrees: { inactiveDays: null }, browser: { captureDays: null } })
  })

  it('refuses a caller that is not a human-controlled settings action', () => {
    const f = fixture()
    expect(() => f.policy.configure(valid(), false)).toThrow(/human-controlled/)
    expect(existsSync(join(f.store.root, 'storage-policy.json'))).toBe(false)
  })

  it('refuses an unreadable stored policy instead of guessing', () => {
    const f = fixture(); mkdirSync(f.store.root, { recursive: true })
    writeFileSync(join(f.store.root, 'storage-policy.json'), JSON.stringify({ schemaVersion: 1, worktrees: { removeWithDeletedThreads: 'yes' } }))
    expect(() => f.policy.policy()).toThrow('Unknown storage policy')
  })

  it('changes its digest when a rule changes and not when nothing does', () => {
    const f = fixture()
    const defaults = f.policy.digest()
    f.policy.configure(valid({ inactiveDays: 45 }), true)
    const saved = f.policy.digest()
    expect(saved).not.toBe(defaults)
    f.policy.configure(valid({ inactiveDays: 45 }), true); expect(f.policy.digest()).toBe(saved)
    f.policy.configure(valid({ inactiveDays: 31 }), true); expect(f.policy.digest()).not.toBe(saved)
  })

  it('tells the owner a policy was saved', () => {
    const changed = vi.fn(); const f = fixture(changed)
    f.policy.configure(valid(), true); expect(changed).toHaveBeenCalledTimes(1)
    expect(() => f.policy.configure(valid(), false)).toThrow(); expect(changed).toHaveBeenCalledTimes(1)
  })

  it('saving resets the storage clock and leaves the trash clock suspended', () => {
    const f = fixture()
    f.clockState.now -= STORAGE_CLOCK_BACKWARD_TOLERANCE_MS + 1; expect(f.clock.check().suspended).toBe(true)
    expect(existsSync(join(f.store.root, 'storage-clock.json'))).toBe(true)
    writeFileSync(join(f.store.root, 'trash-clock.json'), JSON.stringify({ highWater: 1, suspended: true }))
    f.policy.configure(valid(), true)
    expect(existsSync(join(f.store.root, 'storage-clock.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(f.store.root, 'trash-clock.json'), 'utf8'))).toEqual({ highWater: 1, suspended: true })
    expect(f.clock.check()).toMatchObject({ suspended: false })
    const purge = new ResourcePurgeService(f.store, { assertIdle() {}, projectPurged() {} })
    expect(purge.sweepStatus().suspended).toBe(true)
  })

  it('the trash row\'s own save resets the trash clock and does not touch the storage clock', () => {
    const f = fixture(); mkdirSync(f.store.root, { recursive: true })
    f.clockState.now -= HOUR_MS; expect(f.clock.check().suspended).toBe(true)
    writeFileSync(join(f.store.root, 'trash-clock.json'), JSON.stringify({ highWater: 1, suspended: true }))
    const purge = new ResourcePurgeService(f.store, { assertIdle() {}, projectPurged() {} })
    purge.configure({ schemaVersion: 1, graceDays: 30, automaticPurge: true }, true)
    expect(purge.sweepStatus().suspended).toBe(false)
    expect(existsSync(join(f.store.root, 'storage-clock.json'))).toBe(true)
  })
})

describe('policy snapshot', () => {
  it('returns the rules and the digest of the same read, and the digest follows a save', () => {
    const f = fixture()
    const before = f.policy.snapshot()
    expect(before).toEqual({ policy: STORAGE_POLICY_DEFAULTS, digest: f.policy.digest() })
    f.policy.configure(valid({ inactiveDays: 45 }), true)
    const after = f.policy.snapshot()
    expect(after.policy).toEqual(valid({ inactiveDays: 45 })); expect(after.digest).not.toBe(before.digest); expect(after.digest).toBe(f.policy.digest())
    expect(before.policy).toEqual(STORAGE_POLICY_DEFAULTS) // an earlier snapshot is not changed by a later save
  })
})

describe('StorageSweepClock', () => {
  it('peek answers like check without persisting a suspension or moving the sample', () => {
    const f = fixture()
    f.clockState.now -= HOUR_MS
    expect(f.clock.peek()).toMatchObject({ suspended: true })
    expect(existsSync(join(f.store.root, 'storage-clock.json'))).toBe(false)
    expect(f.clock.suspended()).toBe(false)
    expect(f.clock.check().suspended).toBe(true) // the real check still finds the jump
    expect(f.clock.peek()).toMatchObject({ suspended: true })
    f.clockState.now += 30 * HOUR_MS; f.clock.resume(); f.clockState.now += 2 * HOUR_MS
    expect(f.clock.peek()).toEqual({ suspended: false, forwardJumpMs: 2 * HOUR_MS })
  })

  it('suspends only on a backward jump, not a forward one', () => {
    const f = fixture()
    f.clockState.now += 30 * HOUR_MS; expect(f.clock.check()).toEqual({ suspended: false, forwardJumpMs: 30 * HOUR_MS })
    f.clockState.now -= STORAGE_CLOCK_BACKWARD_TOLERANCE_MS - 1; expect(f.clock.check().suspended).toBe(false)
    f.clockState.now -= STORAGE_CLOCK_BACKWARD_TOLERANCE_MS + 1; expect(f.clock.check().suspended).toBe(true)
  })

  it('re-samples on a suspension and on resume, so a sustained backward set does not suspend again', () => {
    const f = fixture()
    f.clockState.now -= HOUR_MS; expect(f.clock.check().suspended).toBe(true)
    expect(f.clock.check().suspended).toBe(true) // persisted until the policy is saved
    f.clock.resume()
    expect(f.clock.check()).toMatchObject({ suspended: false })
    f.clockState.now -= HOUR_MS; expect(f.clock.check().suspended).toBe(true)
  })

  it('treats a process that starts days later as normal and keeps a persisted suspension across a restart', () => {
    const f = fixture()
    f.clockState.now += 3 * 24 * HOUR_MS
    const restarted = new StorageSweepClock(f.store.root, () => f.clockState.now); restarted.start()
    expect(restarted.check()).toMatchObject({ suspended: false, forwardJumpMs: 0 })
    f.clockState.now -= HOUR_MS; expect(restarted.check().suspended).toBe(true)
    const again = new StorageSweepClock(f.store.root, () => f.clockState.now); again.start()
    expect(again.check().suspended).toBe(true)
  })
})

describe('storagePolicyHasRule', () => {
  const trash = (automaticPurge: boolean) => ({ schemaVersion: 1 as const, graceDays: 30, automaticPurge })
  it('is on for any rule, including automatic trash emptying', () => {
    const off: StoragePolicy = { schemaVersion: 1, worktrees: { removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false }, browser: { captureDays: null } }
    expect(storagePolicyHasRule(off, trash(false))).toBe(false)
    expect(storagePolicyHasRule(off, trash(true))).toBe(true)
    expect(storagePolicyHasRule({ ...off, worktrees: { ...off.worktrees, removeWithDeletedThreads: true } }, trash(false))).toBe(true)
    expect(storagePolicyHasRule({ ...off, worktrees: { ...off.worktrees, inactiveDays: 7 } }, trash(false))).toBe(true)
    expect(storagePolicyHasRule({ ...off, worktrees: { ...off.worktrees, removeMerged: true } }, trash(false))).toBe(true)
    expect(storagePolicyHasRule({ ...off, browser: { captureDays: 30 } }, trash(false))).toBe(true)
  })
})

const HOUR_MS = 3_600_000

describe('first start after the recommended rules arrive', () => {
  it('gives a profile that was in use what it had before, saved, with a review pending', () => {
    const f = fixture()
    expect(f.policy.initialize(() => true)).toBe('existing')
    expect(f.policy.policy()).toEqual(STORAGE_POLICY_EXISTING_INSTALL)
    expect(JSON.parse(readFileSync(join(f.store.root, 'storage-policy.json'), 'utf8'))).toEqual(STORAGE_POLICY_EXISTING_INSTALL)
    expect(STORAGE_POLICY_EXISTING_INSTALL.worktrees).toEqual({ removeWithDeletedThreads: true, inactiveDays: null, removeMerged: false })
    expect(STORAGE_POLICY_EXISTING_INSTALL.browser.captureDays).toBeNull()
    expect(f.policy.reviewPending()).toBe(true)
  })

  it('gives a new profile the recommended rules, saved, with nothing to review', () => {
    const f = fixture()
    expect(f.policy.initialize(() => false)).toBe('new')
    expect(f.policy.policy()).toEqual(STORAGE_POLICY_DEFAULTS)
    expect(existsSync(join(f.store.root, 'storage-policy.json'))).toBe(true)
    expect(f.policy.reviewPending()).toBe(false)
  })

  it('is decided once: a later thread, a second call and a restart change nothing', () => {
    const f = fixture()
    let used = false
    expect(f.policy.initialize(() => used)).toBe('new'); used = true
    expect(f.policy.initialize(() => used)).toBe('present')
    expect(new StoragePolicyStore(f.store, f.clock).policy()).toEqual(STORAGE_POLICY_DEFAULTS)
    const existing = fixture(); existing.policy.initialize(() => true)
    expect(existing.policy.initialize(() => false)).toBe('present')
    expect(existing.policy.policy()).toEqual(STORAGE_POLICY_EXISTING_INSTALL)
  })

  it('never replaces a policy that was already saved', () => {
    const f = fixture(); f.policy.configure(valid({ inactiveDays: 45 }), true)
    expect(f.policy.initialize(() => true)).toBe('present')
    expect(f.policy.policy()).toEqual(valid({ inactiveDays: 45 })); expect(f.policy.reviewPending()).toBe(false)
  })

  it('ends the review when the person saves a policy or dismisses the notice, and only a person can dismiss', () => {
    const saved = fixture(); saved.policy.initialize(() => true)
    saved.policy.configure(valid(), true); expect(saved.policy.reviewPending()).toBe(false)
    const dismissed = fixture(); dismissed.policy.initialize(() => true)
    expect(() => dismissed.policy.dismissReview(false)).toThrow(); expect(dismissed.policy.reviewPending()).toBe(true)
    dismissed.policy.dismissReview(true); expect(dismissed.policy.reviewPending()).toBe(false)
    expect(dismissed.policy.policy()).toEqual(STORAGE_POLICY_EXISTING_INSTALL)
  })

  it('dismissing the notice does not lift a clock pause, which only saving a policy does', () => {
    const f = fixture(); f.policy.initialize(() => true)
    f.clockState.now -= 600_000; f.clock.check()
    expect(f.clock.suspended()).toBe(true)
    f.policy.dismissReview(true); expect(f.clock.suspended()).toBe(true)
    f.policy.configure(valid(), true); expect(f.clock.suspended()).toBe(false)
  })
})
