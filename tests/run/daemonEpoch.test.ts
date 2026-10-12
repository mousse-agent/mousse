import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonEpoch } from '../../src/mms/run/DaemonEpoch'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunStore } from '../../src/mms/run/RunStore'
import { leaseOwner } from '../../src/mms/run/types'

describe('DaemonEpoch', () => {
  let profileHome: string | undefined
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const open = (): DaemonEpoch => {
    profileHome ??= mkdtempSync(join(tmpdir(), 'mousse-epoch-'))
    const db = new ProfileDatabase({ profileHome })
    dbs.push(db)
    return new DaemonEpoch(new RunStore(db))
  }

  it('starts at epoch 1 with no previous daemon', () => {
    const epochs = open()
    expect(epochs.current()).toBeNull()
    expect(epochs.begin(100, '2026-10-12T00:00:00.000Z')).toEqual({
      epoch: 1,
      previous: null,
      previousCrashed: false
    })
    expect(epochs.current()).toEqual({
      epoch: 1,
      pid: 100,
      startedAt: '2026-10-12T00:00:00.000Z',
      heartbeatAt: '2026-10-12T00:00:00.000Z',
      endedAt: null
    })
  })

  it('detects a crash when the previous epoch never ended', () => {
    const epochs = open()
    epochs.begin(100, '2026-10-12T00:00:00.000Z')
    expect(epochs.heartbeat(1, '2026-10-12T00:00:10.000Z')).toBe(true)
    // A new daemon on a new connection, as after a crash.
    const next = open().begin(200, '2026-10-12T00:01:00.000Z')
    expect(next).toMatchObject({ epoch: 2, previousCrashed: true })
    expect(next.previous).toMatchObject({
      epoch: 1,
      pid: 100,
      heartbeatAt: '2026-10-12T00:00:10.000Z',
      endedAt: null
    })
  })

  it('does not report a crash after a clean shutdown', () => {
    const epochs = open()
    epochs.begin(100, '2026-10-12T00:00:00.000Z')
    expect(epochs.end(1, '2026-10-12T00:00:30.000Z')).toBe(true)
    expect(epochs.end(1, '2026-10-12T00:00:31.000Z')).toBe(false)
    expect(epochs.heartbeat(1, '2026-10-12T00:00:32.000Z')).toBe(false)
    const next = open().begin(200, '2026-10-12T00:01:00.000Z')
    expect(next).toMatchObject({
      epoch: 2,
      previousCrashed: false,
      previous: { epoch: 1, endedAt: '2026-10-12T00:00:30.000Z' }
    })
    expect(epochs.current()!.epoch).toBe(2)
    expect(leaseOwner(next.epoch, 200)).toBe('2:200')
  })
})
