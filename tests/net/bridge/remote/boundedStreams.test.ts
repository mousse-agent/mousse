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

function manualClock(): Clock & {
  advance(ms: number): void
  pending(): number
  delays(): number[]
  fire(): void
} {
  let now = Date.now()
  const timers = new Map<object, { callback: () => void; ms: number }>()
  return {
    now: () => now,
    monotonic: () => now,
    setTimeout(callback, ms) {
      const handle = {}
      timers.set(handle, { callback, ms })
      return { cancel: () => timers.delete(handle) }
    },
    advance(ms) {
      now += ms
    },
    pending: () => timers.size,
    delays: () => [...timers.values()].map((timer) => timer.ms),
    fire() {
      const due = [...timers.entries()]
      timers.clear()
      for (const [, timer] of due) timer.callback()
    }
  }
}

async function fixture(
  options: Partial<ThreadStreamOptions> = {},
  before?: (db: NetDatabase) => void
) {
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
  before?.(db)
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
  it('counts streams a caller is subscribed to, however they were reopened', async () => {
    const f = await fixture()
    // Reopened by a direct subscribe (or after an owner restart), these have no opening caller.
    for (let i = 1; i <= 16; i++) {
      const descriptor = f.adapter.activate(`thread-${i}`)
      f.subscribed.add(`${descriptor.id}|nod_laptop`)
    }
    expect(() => f.adapter.activate('thread-17', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
    expect(() => f.adapter.activate('thread-17', 'nod_phone')).not.toThrow()
  })

  it('refuses a 17th thread only while the caller reads all 16, and not from another caller', async () => {
    const f = await fixture()
    for (let i = 1; i <= 16; i++) {
      const descriptor = f.adapter.activate(`thread-${i}`, 'nod_laptop')
      f.subscribed.add(`${descriptor.id}|nod_laptop`)
    }
    expect(() => f.adapter.activate('thread-17', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
    // Another caller still has room, and a thread both hold counts once for each.
    expect(() => f.adapter.activate('thread-17', 'nod_phone')).not.toThrow()
    expect(() => f.adapter.activate('thread-1', 'nod_phone')).not.toThrow()
    // A thread the caller already holds is never refused.
    expect(() => f.adapter.activate('thread-3', 'nod_laptop')).not.toThrow()
  })

  it('lets a caller move through more than 16 threads: the one it opened longest ago and no longer reads gives way', async () => {
    const f = await fixture()
    for (let i = 1; i <= 16; i++) {
      f.adapter.activate(`thread-${i}`, 'nod_laptop')
      f.clock.advance(1000)
    }
    // Long before the holds are idle, a 17th and an 18th open.
    expect(() => f.adapter.activate('thread-17', 'nod_laptop')).not.toThrow()
    expect(() => f.adapter.activate('thread-18', 'nod_laptop')).not.toThrow()
    // Opening thread-1 again needs a hold again, so the next oldest gives way, and so on.
    expect(() => f.adapter.activate('thread-1', 'nod_laptop')).not.toThrow()
  })

  it('does not count the shared lists stream against a caller', async () => {
    const f = await fixture()
    for (let i = 1; i <= 16; i++) f.adapter.activate(`thread-${i}`, 'nod_laptop')
    expect(() => f.adapter.activate(LISTS_STREAM_THREAD_ID, 'nod_laptop')).not.toThrow()
  })

  it('gives a caller room again when the threads it reads are released', async () => {
    const f = await fixture({ maxThreadsPerHolder: 2 })
    for (const id of ['a', 'b']) f.subscribed.add(`${f.adapter.activate(id, 'nod_laptop').id}|nod_laptop`)
    expect(() => f.adapter.activate('c', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
    f.subscribed.clear()
    expect(() => f.adapter.activate('c', 'nod_laptop')).not.toThrow()
  })

  it('still refuses past the cap when it cannot tell what the caller reads', async () => {
    const f = await fixture({ maxThreadsPerHolder: 2, isSubscribed: undefined })
    f.adapter.activate('a', 'nod_laptop')
    f.adapter.activate('b', 'nod_laptop')
    expect(() => f.adapter.activate('c', 'nod_laptop')).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
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

  it('makes room under the shared cap from the least recently busy stream no one reads', async () => {
    const f = await fixture({ maxThreads: 2 })
    f.adapter.activate('a')
    f.clock.advance(1000)
    f.adapter.activate('b')
    expect(() => f.adapter.activate('c')).not.toThrow()
    expect(f.watching.get('a')).toBe(0)
    expect(f.watching.get('b')).toBe(1)
  })

  it('refuses under the shared cap only when every stream is read or running a turn', async () => {
    const f = await fixture({ maxThreads: 2 })
    f.subscribed.add(`${f.adapter.activate('a').id}|nod_laptop`)
    f.adapter.activate('b')
    f.running.add('b')
    expect(() => f.adapter.activate('c')).toThrow(expect.objectContaining({ code: 'rate_limited' }))
    f.running.clear()
    expect(() => f.adapter.activate('c')).not.toThrow()
    expect(f.watching.get('a')).toBe(1)
  })

  it('runs no sweep of its own where subscribers cannot be told', async () => {
    const f = await fixture({ isSubscribed: undefined })
    f.adapter.activate('t1')
    expect(f.clock.pending()).toBe(0)
  })

  it('keeps one sweep timer, quick while a stream is open and hourly while none is, and stops it on close', async () => {
    const f = await fixture()
    // One timer from the start, so stale records go even when nothing is ever opened.
    expect(f.clock.delays()).toEqual([60 * 1000])
    f.clock.fire()
    expect(f.clock.delays()).toEqual([60 * MINUTE])
    f.adapter.activate('t1')
    expect(f.clock.delays()).toEqual([60 * 1000])
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

  it('is not starved by many long-open streams, and runs while nothing is open', async () => {
    const f = await fixture({ staleMs: 2 * DAY })
    const stored = (id: StreamId) =>
      (
        f.db.database
          .prepare(
            'SELECT count(*) AS n FROM net_records WHERE generation=(SELECT active_generation FROM net_streams WHERE id=?)'
          )
          .get(id) as { n: number }
      ).n
    // More open streams than one batch holds, all older than the one that has gone stale.
    for (let i = 0; i < 25; i++) {
      const open = f.adapter.activate(`open-${i}`)
      f.subscribed.add(`${open.id}|nod_laptop`)
    }
    f.clock.advance(5 * MINUTE)
    const stale = f.adapter.activate('stale')
    f.clock.advance(11 * MINUTE)
    f.clock.fire()
    expect(f.watching.get('stale')).toBe(0)
    f.clock.advance(3 * DAY)
    expect(f.adapter.dropStale()).toBe(1)
    expect(stored(stale.id)).toBe(0)
    expect(f.records(f.adapter.activate('open-0').id).length).toBeGreaterThan(0)

    // With every stream closed, the hourly sweep still drops what has gone stale.
    const quiet = await fixture({ staleMs: 2 * DAY })
    const only = quiet.adapter.activate('only')
    quiet.clock.advance(11 * MINUTE)
    quiet.clock.fire()
    expect(quiet.clock.delays()).toEqual([60 * MINUTE])
    quiet.clock.advance(3 * DAY)
    quiet.clock.fire()
    expect(
      (
        quiet.db.database
          .prepare(
            'SELECT count(*) AS n FROM net_records WHERE generation=(SELECT active_generation FROM net_streams WHERE id=?)'
          )
          .get(only.id) as { n: number }
      ).n
    ).toBe(0)
  })

  it('leaves no id tombstones for a stream only this computer authors', async () => {
    const f = await fixture({ staleMs: 2 * DAY })
    const descriptor = f.adapter.activate('t1')
    const ids = () =>
      (
        f.db.database
          .prepare('SELECT count(*) AS n FROM net_event_ids WHERE stream=?')
          .get(descriptor.id) as { n: number }
      ).n
    // Every reopen publishes a snapshot and truncates the one before it.
    for (let i = 0; i < 5; i++) {
      f.clock.advance(11 * MINUTE)
      f.adapter.releaseIdle()
      f.adapter.activate('t1')
    }
    expect(ids()).toBe(0)
    f.clock.advance(11 * MINUTE)
    f.adapter.releaseIdle()
    f.clock.advance(3 * DAY)
    expect(f.adapter.dropStale()).toBe(1)
    expect(ids()).toBe(0)
  })

  it('releases tombstones an earlier version kept for such a stream', async () => {
    const f = await fixture({ staleMs: 2 * DAY })
    const descriptor = f.adapter.activate('t1')
    const epoch = f.adapter.store.head(descriptor.id).epoch
    const insert = f.db.database.prepare('INSERT INTO net_event_ids VALUES(?,?,?,?,?,?,?)')
    insert.run(descriptor.id, 'evt_old', epoch, 1, 0, 'a', 'b')
    insert.run(descriptor.id, 'evt_older', epoch - 1, 99, 0, 'a', 'b')
    f.clock.advance(11 * MINUTE)
    f.adapter.releaseIdle()
    f.adapter.activate('t1')
    expect(
      (
        f.db.database
          .prepare('SELECT count(*) AS n FROM net_event_ids WHERE stream=?')
          .get(descriptor.id) as { n: number }
      ).n
    ).toBe(0)
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

describe('thread stream table upgrade', () => {
  it('adds the idle columns to a table from an earlier version and starts its rows now', async () => {
    const f = await fixture({}, (db) =>
      db.database.exec(
        "CREATE TABLE bridge_thread_streams(thread_id TEXT PRIMARY KEY,stream TEXT NOT NULL UNIQUE,boot TEXT NOT NULL) STRICT;INSERT INTO bridge_thread_streams VALUES('old-thread','stm_old','boot-1')"
      )
    )
    const columns = () =>
      f.db.database
        .prepare('PRAGMA table_info(bridge_thread_streams)')
        .all()
        .map((row) => String(row.name))
    expect(columns()).toEqual(['thread_id', 'stream', 'boot', 'last_active', 'dropped'])
    const row = f.db.database
      .prepare("SELECT last_active,dropped FROM bridge_thread_streams WHERE thread_id='old-thread'")
      .get() as { last_active: number; dropped: number }
    expect(row.dropped).toBe(0)
    expect(row.last_active).toBeGreaterThan(Date.now() - 60 * 1000)
    // A second opener of the same database finds the columns and leaves the row alone.
    const second = new ThreadStreamAdapter({
      db: f.db,
      store: f.store,
      generations: f.store,
      identity: undefined as never,
      keys: undefined as never,
      clock: f.clock,
      source: { snapshot: () => ({}), onThread: () => () => undefined }
    })
    second.close()
    expect(columns()).toHaveLength(5)
  })
})

describe('long threads', () => {
  // About 30 nodes a message, like a real transcript row with a tool call.
  const transcript = (count: number) => ({
    messages: Array.from({ length: count }, (_, n) => ({
      id: `m${n}`,
      role: 'system',
      kind: 'mcp_tool_call',
      content: '',
      toolCall: { title: 'Bash', status: 'complete', input: { command: `echo ${n}`, flags: [1, 2, 3, 4, 5, 6] } },
      tags: Array.from({ length: 16 }, (_, i) => i)
    }))
  })

  it('opens a thread with far more nodes than one wire message carries', async () => {
    const f = await fixture({
      source: { snapshot: () => transcript(1000), onThread: () => () => undefined }
    })
    const descriptor = f.adapter.activate('long', 'nod_phone')
    expect(f.records(descriptor.id).map((entry) => entry.type)).toContain('thread.snapshot.end')
  })

  it('turns an event with more nodes than a record carries into a fresh snapshot instead of failing the stream', async () => {
    let emit: ((event: { type: string; data: unknown }) => void) | undefined
    const errors: unknown[] = []
    const f = await fixture({
      source: {
        snapshot: () => ({ kind: 'test' }),
        onThread: (_threadId, listener) => {
          emit = listener as never
          return () => undefined
        }
      },
      onError: (_thread, error) => errors.push(error)
    })
    const descriptor = f.adapter.activate('busy', 'nod_phone')
    // A fresh snapshot replaces the records before it, so the one stored now is a new one.
    const snapshotId = () =>
      f
        .records(descriptor.id)
        .filter((entry) => entry.type === 'thread.snapshot.end')
        .map((entry) => (entry.body as { snapshot: string }).snapshot)
    const before = snapshotId()
    // Under 48 KiB, but 20,000 nodes.
    emit!({ type: 'thread.messages', data: { messages: Array.from({ length: 20_000 }, () => 0) } })
    expect(errors).toEqual([])
    const after = snapshotId()
    expect(after).toHaveLength(1)
    expect(after[0]).not.toBe(before[0])
    expect(f.records(descriptor.id).map((entry) => entry.type)).not.toContain('thread.event')
    expect(() => f.adapter.ringStats(descriptor.id)).not.toThrow()
  })
})
