import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { systemClock } from '../../../../src/mms/net/clock'
import type { Clock } from '../../../../src/mms/net/contracts'
import {
  LISTS_STREAM_THREAD_ID,
  ThreadStreamAdapter,
  type ThreadStreamOptions
} from '../../../../src/mms/bridge/remote'
import type { StreamId } from '../../../../src/shared/net'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose()
})

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

function manualClock(): Clock & { advance(ms: number): void; pending(): number } {
  let now = Date.now()
  const timers = new Set<unknown>()
  return {
    now: () => now,
    monotonic: () => now,
    setTimeout() {
      const handle = {}
      timers.add(handle)
      return { cancel: () => timers.delete(handle) }
    },
    advance(ms) {
      now += ms
    },
    pending: () => timers.size
  }
}

async function fixture(options: Partial<ThreadStreamOptions> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bounded-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => db.close())
  const keys = new FileKeyStore(dir),
    identity = new NetIdentityService({
      database: db.database,
      keys,
      clock: systemClock,
      coordinator: db
    })
  await identity.bootstrapAuthority('Bounded streams')
  const store = new SqliteStreamStore(db)
  cleanups.push(() => store.close())
  const clock = manualClock(),
    watching = new Map<string, number>(),
    subscribed = new Set<string>(),
    running = new Set<string>()
  const adapter = new ThreadStreamAdapter({
    db,
    store,
    generations: store,
    identity,
    keys,
    clock,
    source: {
      snapshot: (threadId) => ({ kind: 'test', threadId }),
      onThread: (threadId) => {
        watching.set(threadId, (watching.get(threadId) ?? 0) + 1)
        return () => watching.set(threadId, (watching.get(threadId) ?? 1) - 1)
      }
    },
    unmetered: (threadId) => threadId === LISTS_STREAM_THREAD_ID,
    isSubscribed: (stream, holder) =>
      holder === undefined
        ? [...subscribed].some((key) => key.startsWith(stream + '|'))
        : subscribed.has(`${stream}|${holder}`),
    isTurnActive: (threadId) => running.has(threadId),
    ...options
  })
  cleanups.push(() => adapter.close())
  const records = (stream: StreamId) => {
    const reader = adapter.store.openSnapshot(stream)
    try {
      return reader
        .next(1024 * 1024)
        .records.map((record) => decodeEnvelope(record.envelope).envelope)
    } finally {
      reader.close()
    }
  }
  return { adapter, clock, watching, subscribed, running, db, store, records }
}

describe('thread stream quotas', () => {
  it('refuses the 17th thread from one caller and not from another', async () => {
    const f = await fixture()
    for (let i = 1; i <= 16; i++) f.adapter.activate(`thread-${i}`, 'nod_laptop')
    expect(() => f.adapter.activate('thread-17', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
    // Another caller still has room, and a thread both hold counts once for each.
    expect(() => f.adapter.activate('thread-17', 'nod_phone')).not.toThrow()
    expect(() => f.adapter.activate('thread-1', 'nod_phone')).not.toThrow()
    // A thread the caller already holds is never refused.
    expect(() => f.adapter.activate('thread-3', 'nod_laptop')).not.toThrow()
  })

  it('does not count the shared lists stream against a caller', async () => {
    const f = await fixture()
    for (let i = 1; i <= 16; i++) f.adapter.activate(`thread-${i}`, 'nod_laptop')
    expect(() => f.adapter.activate(LISTS_STREAM_THREAD_ID, 'nod_laptop')).not.toThrow()
  })

  it('gives a caller room again when its idle threads are released', async () => {
    const f = await fixture({ maxThreadsPerHolder: 2 })
    f.adapter.activate('a', 'nod_laptop')
    f.adapter.activate('b', 'nod_laptop')
    expect(() => f.adapter.activate('c', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
    f.clock.advance(11 * MINUTE)
    expect(() => f.adapter.activate('c', 'nod_laptop')).not.toThrow()
  })
})

describe('idle thread streams', () => {
  it('releases a stream nobody is subscribed to after ten idle minutes and reopens it on demand', async () => {
    const f = await fixture()
    const descriptor = f.adapter.activate('t1', 'nod_laptop')
    expect(f.watching.get('t1')).toBe(1)

    f.clock.advance(9 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(0)
    f.clock.advance(2 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(1)
    expect(f.watching.get('t1')).toBe(0)
    expect(() => f.adapter.ringStats(descriptor.id)).toThrow(
      expect.objectContaining({ code: 'stream_unknown' })
    )

    // The next subscriber finds the same stream, live again, with a current snapshot.
    expect(f.adapter.store.getStream(descriptor.id)).toEqual(descriptor)
    expect(f.watching.get('t1')).toBe(1)
    expect(f.records(descriptor.id).map((entry) => entry.type)).toContain('thread.snapshot.end')
    expect(f.adapter.activate('t1', 'nod_laptop')).toEqual(descriptor)
  })

  it('keeps a stream that has a subscriber or a running turn', async () => {
    const f = await fixture()
    const subscribedStream = f.adapter.activate('watched', 'nod_laptop'),
      turnStream = f.adapter.activate('busy', 'nod_laptop')
    f.adapter.activate('quiet', 'nod_laptop')
    f.subscribed.add(`${subscribedStream.id}|nod_laptop`)
    f.running.add('busy')
    f.clock.advance(30 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(1)
    expect(f.watching.get('watched')).toBe(1)
    expect(f.watching.get('busy')).toBe(1)
    expect(f.watching.get('quiet')).toBe(0)
    // Once the subscriber leaves, the quiet period starts from then.
    f.subscribed.clear()
    f.running.clear()
    f.clock.advance(5 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(0)
    f.clock.advance(6 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(2)
    expect(turnStream.id).toBeTruthy()
  })

  it('never releases a stream when it cannot tell who is subscribed', async () => {
    const f = await fixture({ isSubscribed: undefined })
    f.adapter.activate('t1')
    f.clock.advance(DAY)
    expect(f.adapter.releaseIdle()).toBe(0)
    expect(f.watching.get('t1')).toBe(1)
  })

  it('makes room under the shared cap by releasing idle streams', async () => {
    const f = await fixture({ maxThreads: 2 })
    f.adapter.activate('a')
    f.adapter.activate('b')
    expect(() => f.adapter.activate('c')).toThrow(expect.objectContaining({ code: 'rate_limited' }))
    f.clock.advance(11 * MINUTE)
    expect(() => f.adapter.activate('c')).not.toThrow()
  })

  it('runs no sweep of its own where subscribers cannot be told', async () => {
    const f = await fixture({ isSubscribed: undefined })
    f.adapter.activate('t1')
    expect(f.clock.pending()).toBe(0)
  })

  it('schedules its sweep only while a stream is open and stops it on close', async () => {
    const f = await fixture()
    expect(f.clock.pending()).toBe(0)
    f.adapter.activate('t1')
    expect(f.clock.pending()).toBe(1)
    f.adapter.activate('t2')
    expect(f.clock.pending()).toBe(1)
    f.adapter.close()
    expect(f.clock.pending()).toBe(0)
  })
})

describe('stale thread streams', () => {
  // Delegations last seven days, so these tests use a shorter stale period than the default.
  it('drops the stored records of a stream not opened for the stale period and republishes on reopen', async () => {
    const f = await fixture({ staleMs: 2 * DAY })
    const descriptor = f.adapter.activate('old', 'nod_laptop')
    expect(f.records(descriptor.id).length).toBeGreaterThan(0)
    const head = f.adapter.store.head(descriptor.id)

    f.clock.advance(11 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(1)
    f.clock.advance(1 * DAY)
    expect(f.adapter.dropStale()).toBe(0)
    f.clock.advance(2 * DAY)
    expect(f.adapter.dropStale()).toBe(1)
    expect(f.adapter.store.head(descriptor.id).seq).toBe(head.seq)
    expect(
      (
        f.db.database
          .prepare(
            'SELECT count(*) AS n FROM net_records WHERE generation=(SELECT active_generation FROM net_streams WHERE id=?)'
          )
          .get(descriptor.id) as { n: number }
      ).n
    ).toBe(0)

    // Opening it again keeps the stream's identity and brings the snapshot back.
    expect(f.adapter.activate('old', 'nod_laptop')).toEqual(descriptor)
    const types = f.records(descriptor.id).map((entry) => entry.type)
    expect(types[0]).toBe('thread.snapshot.begin')
    expect(types.at(-1)).toBe('thread.snapshot.end')
  })

  it('leaves streams that are open, or were opened recently, alone', async () => {
    const f = await fixture({ staleMs: 2 * DAY })
    const open = f.adapter.activate('open')
    f.subscribed.add(`${open.id}|nod_laptop`)
    f.clock.advance(3 * DAY)
    expect(f.adapter.dropStale()).toBe(0)
    expect(f.records(open.id).length).toBeGreaterThan(0)
    // The periodic sweep notes that a subscriber is still there.
    f.adapter.releaseIdle()
    f.subscribed.clear()
    f.clock.advance(11 * MINUTE)
    expect(f.adapter.releaseIdle()).toBe(1)
    f.clock.advance(1 * DAY)
    expect(f.adapter.dropStale()).toBe(0)
  })
})
