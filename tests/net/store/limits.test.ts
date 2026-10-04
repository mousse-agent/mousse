import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteNetStore } from '../../../src/mms/net/store'
import type { StorageLimitScope } from '../../../src/mms/net/store'
import { profile, fixture } from './helpers'

const roots: string[] = []
const stores: SqliteNetStore[] = []
function fresh(): string {
  const path = profile()
  roots.push(path)
  return path
}
function open(path: string): SqliteNetStore {
  const store = new SqliteNetStore({ profileDir: path })
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('explicit persisted quota and rate reservations', () => {
  it('rolls quota/rate charges back with the caller transaction and retains them across restart', () => {
    const path = fresh()
    const f = fixture()
    const store = open(path)
    const scope: StorageLimitScope = { kind: 'space', space: f.space }
    store.limits.configureQuota(scope, 100)
    store.limits.configureRate(scope, f.user, 2, 10_000)
    expect(() =>
      store.transaction(() => {
        store.limits.reserveQuota(scope, 'upload-one', 60)
        store.limits.chargeRate(scope, f.user, 'event-one', 1000)
        throw new Error('append rejected')
      })
    ).toThrow('append rejected')
    expect(store.limits.remainingQuota(scope)).toBe(100)
    expect(store.limits.remainingRate(scope, f.user, 1000)).toBe(2)
    store.transaction(() => {
      store.limits.reserveQuota(scope, 'upload-one', 60)
      store.limits.chargeRate(scope, f.user, 'event-one', 1000)
    })
    store.close()
    const restarted = open(path)
    expect(restarted.limits.remainingQuota(scope)).toBe(40)
    expect(restarted.limits.remainingRate(scope, f.user, 1000)).toBe(1)
    restarted.limits.reserveQuota(scope, 'upload-one', 60)
    restarted.limits.chargeRate(scope, f.user, 'event-one', 1000)
    expect(restarted.limits.remainingQuota(scope)).toBe(40)
    expect(restarted.limits.remainingRate(scope, f.user, 1000)).toBe(1)
    expect(() => restarted.limits.reserveQuota(scope, 'upload-two', 41)).toThrowError(
      expect.objectContaining({ code: 'quota_exceeded' })
    )
    restarted.limits.releaseQuota(scope, 'upload-one')
    restarted.limits.releaseQuota(scope, 'upload-one')
    restarted.limits.reserveQuota(scope, 'upload-one', 60)
    expect(restarted.limits.remainingQuota(scope)).toBe(100)
  })
  it('enforces a sliding window at the exact boundary without allowing backdated charges', () => {
    const f = fixture()
    const store = open(fresh())
    const scope: StorageLimitScope = { kind: 'space', space: f.space }
    store.limits.configureRate(scope, f.user, 2, 10_000)
    store.limits.chargeRate(scope, f.user, 'one', 1000)
    store.limits.chargeRate(scope, f.user, 'two', 1001)
    expect(() => store.limits.chargeRate(scope, f.user, 'three', 10_999)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' })
    )
    store.limits.chargeRate(scope, f.user, 'three', 11_000)
    expect(store.limits.remainingRate(scope, f.user, 11_000)).toBe(0)
    expect(() => store.limits.chargeRate(scope, f.user, 'four', 10999)).toThrowError(
      expect.objectContaining({ code: 'clock_skew' })
    )
    store.limits.chargeRate(scope, f.user, 'one', 21_001)
    expect(store.limits.remainingRate(scope, f.user, 21_001)).toBe(2)
  })
  it('requires explicit configurations and prevents scope/principal substitution', () => {
    const f = fixture()
    const store = open(fresh())
    const space: StorageLimitScope = { kind: 'space', space: f.space }
    const local: StorageLimitScope = { kind: 'profile', profileId: 'profile-one' }
    store.limits.configureQuota(local, 100)
    expect(() => store.limits.reserveQuota(space, 'same-id', 1)).toThrowError(
      expect.objectContaining({ code: 'quota_exceeded' })
    )
    store.limits.reserveQuota(local, 'same-id', 100)
    expect(() => store.limits.reserveQuota(local, 'same-id', 99)).toThrowError(
      expect.objectContaining({ code: 'conflict' })
    )
    store.limits.configureRate(space, f.user, 20, 10_000)
    expect(() => store.limits.chargeRate(space, 'different-person', 'same-id', 1)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' })
    )
    expect(() => store.limits.configureQuota(local, 99)).toThrowError(
      expect.objectContaining({ code: 'quota_exceeded' })
    )
  })
})
