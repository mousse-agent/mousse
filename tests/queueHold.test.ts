/**
 * The saved queue hold of a running compaction (`queue-hold.json`): renewed by the process that set it, and taken
 * as left behind once nobody renewed it in time, whatever process it names.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStaleQueueHold,
  getQueueHoldPath,
  isQueueHoldLive,
  QUEUE_HOLD_STALE_MS,
  readQueueHold,
  renewQueueHold,
  requestQueueHoldStop,
  setQueueHold,
  type QueueHold
} from '../src/mms/queue/queueHold'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const threadDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-queue-hold-'))
  dirs.push(dir)
  return dir
}
const t0 = Date.parse('2026-11-09T10:00:00Z')
/** A hold another process set: the parent of this test process, which is alive. */
const peerHold = (renewedAt?: number): QueueHold => ({
  kind: 'compaction', id: 'row', since: new Date(t0).toISOString(), ownerPid: process.ppid, ownerInstance: 'another-process',
  ...(renewedAt !== undefined ? { renewedAt: new Date(renewedAt).toISOString() } : {})
})
const notOwn = () => false

describe('a queue hold another process set', () => {
  it('holds while renewed in time, and not after, though its process is alive', () => {
    const hold = peerHold(t0)
    expect(isQueueHoldLive(hold, notOwn, t0 + QUEUE_HOLD_STALE_MS - 1_000)).toBe(true)
    expect(isQueueHoldLive(hold, notOwn, t0 + QUEUE_HOLD_STALE_MS + 1_000)).toBe(false)
    // Renewed later, it holds for as long again.
    expect(isQueueHoldLive(peerHold(t0 + 30_000), notOwn, t0 + QUEUE_HOLD_STALE_MS + 1_000)).toBe(true)
  })

  it('counts from when it was set when it was never renewed (saved before holds were renewed)', () => {
    expect(isQueueHoldLive(peerHold(), notOwn, t0 + 1_000)).toBe(true)
    expect(isQueueHoldLive(peerHold(), notOwn, t0 + QUEUE_HOLD_STALE_MS + 1_000)).toBe(false)
  })

  it('a stale one is removed, unless its owner renewed it in between', () => {
    const dir = threadDir()
    writeFileSync(getQueueHoldPath(dir), JSON.stringify(peerHold(t0 + 50_000)))
    const late = t0 + QUEUE_HOLD_STALE_MS + 1_000
    // Read as stale before the renewal; under the lock it holds again.
    expect(clearStaleQueueHold(dir, 'row', (hold) => isQueueHoldLive(hold, notOwn, late))).toBe(false)
    expect(readQueueHold(dir)).not.toBeNull()
    expect(clearStaleQueueHold(dir, 'row', (hold) => isQueueHoldLive(hold, notOwn, t0 + 50_000 + QUEUE_HOLD_STALE_MS + 1_000))).toBe(true)
    expect(readQueueHold(dir)).toBeNull()
  })
})

describe('a queue hold this process set', () => {
  it('is renewed in place, and the renewal finds it gone once lifted', () => {
    const dir = threadDir()
    const set = setQueueHold(dir, { kind: 'compaction', id: 'row' }, t0)
    expect(set.renewedAt).toBe(set.since)
    const renewed = renewQueueHold(dir, 'row', t0 + 10_000)
    expect(renewed).toMatchObject({ id: 'row', since: set.since, renewedAt: new Date(t0 + 10_000).toISOString() })
    expect(readQueueHold(dir)).toEqual(renewed)
    // Another hold's id, or none at all: nothing to renew.
    expect(renewQueueHold(dir, 'other', t0 + 20_000)).toBeNull()
    rmSync(getQueueHoldPath(dir))
    expect(renewQueueHold(dir, 'row', t0 + 20_000)).toBeNull()
    expect(readQueueHold(dir)).toBeNull()
  })

  it('carries a stop another process asked for through each renewal', () => {
    const dir = threadDir()
    setQueueHold(dir, { kind: 'compaction', id: 'row' }, t0)
    expect(requestQueueHoldStop(dir, 'other')).toBe(false)
    expect(readQueueHold(dir)!.stopRequested).toBeUndefined()
    expect(requestQueueHoldStop(dir, 'row')).toBe(true)
    expect(renewQueueHold(dir, 'row', t0 + 10_000)).toMatchObject({ stopRequested: true })
    rmSync(getQueueHoldPath(dir))
    expect(requestQueueHoldStop(dir, 'row')).toBe(false)
  })

  it('holds while this process says it still runs it, however long ago it was renewed', () => {
    const dir = threadDir()
    const hold = setQueueHold(dir, { kind: 'compaction', id: 'row' }, t0)
    expect(isQueueHoldLive(hold, () => true, t0 + 10 * QUEUE_HOLD_STALE_MS)).toBe(true)
    expect(isQueueHoldLive(hold, () => false, t0)).toBe(false)
  })
})
