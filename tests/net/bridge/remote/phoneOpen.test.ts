/**
 * A phone opening a thread: the computer reads the newest messages of a thread kept in thread.db in the read worker,
 * without loading the thread, builds the display snapshot once, and serves that snapshot to the phone's read.
 *
 * When a reader's open must publish a fresh snapshot instead of the one already published, as rows:
 * - nothing happened since it was published: no;
 * - a stored event followed it: no, the reader gets the snapshot and the event;
 * - the source replaced it (`{ snapshot: true }`, or an event too large to store): no, it is the fresh one;
 * - a display-only delta went out since (a question, streaming text): yes, a delta is never stored;
 * - a snapshot larger than the ring lost its first records when an event was stored: yes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  MmsRemoteBackend,
  ThreadDisplayProjection,
  ThreadStreamAdapter,
  type ThreadSourceEvent
} from '../../../../src/mms/bridge/remote'
import type { StreamId } from '../../../../src/shared/net'
import type { ChatMessage } from '../../../../src/shared/types'
import { cleanup, fixture } from '../hub/fixture'

const cleanups: Array<() => void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanups.splice(0).reverse()) dispose()
  await cleanup()
})

const KIB = 1024,
  MIB = 1024 * KIB

async function adapterFixture(content: () => string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-phone-open-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => db.close())
  const keys = new FileKeyStore(dir),
    identity = new NetIdentityService({ database: db.database, keys, clock: systemClock, coordinator: db })
  await identity.bootstrapAuthority('Phone open')
  const store = new SqliteStreamStore(db)
  cleanups.push(() => store.close())
  let emit: (event: ThreadSourceEvent) => void = () => undefined
  let builds = 0
  const adapter = new ThreadStreamAdapter({
    db,
    store,
    generations: store,
    identity,
    keys,
    clock: systemClock,
    source: {
      snapshot: (threadId) => {
        builds++
        return { threadId, content: content() }
      },
      onThread: (_threadId, listener) => {
        emit = listener
        return () => undefined
      }
    },
    onDelta: () => undefined
  })
  cleanups.push(() => adapter.close())
  /** What a reader that opens the stream now is sent: the snapshot it rebuilds, and the events after it. */
  const read = (stream: StreamId) => {
    const reader = adapter.store.openSnapshot(stream),
      projection = new ThreadDisplayProjection('t1')
    let snapshot: any
    const events: string[] = []
    try {
      for (;;) {
        const page = reader.next(4 * MIB)
        for (const record of page.records) {
          const update = projection.accept(decodeEnvelope(record.envelope).envelope)
          if (update?.kind === 'snapshot') snapshot = update.value
          if (update?.kind === 'event') events.push(update.type)
        }
        if (page.done) return { snapshot, events }
      }
    } finally {
      reader.close()
    }
  }
  return { adapter, read, emit: (event: ThreadSourceEvent) => emit(event), builds: () => builds }
}

describe('what a reader that opens a thread stream is served', () => {
  // `replaced`: the stream published a new snapshot when it happened. `fresh`: the reader's open publishes another.
  const rows: Array<{ name: string; size: number; between: ThreadSourceEvent[]; replaced?: true; fresh?: true; events: string[] }> = [
    { name: 'nothing happened since', size: 100, between: [], events: [] },
    { name: 'a stored event followed', size: 100, between: [{ type: 'turn.started', data: {} }], events: ['turn.started'] },
    { name: 'the source replaced the snapshot', size: 100, between: [{ snapshot: true }], replaced: true, events: [] },
    {
      name: 'an event too large to store replaced it',
      size: 100,
      between: [{ type: 'thread.messages', data: { messages: ['x'.repeat(64 * KIB)] } }],
      replaced: true,
      events: []
    },
    {
      name: 'a display-only delta went out',
      size: 100,
      between: [{ type: 'questions.updated', data: { pending: [] }, ephemeral: true }],
      fresh: true,
      events: []
    },
    {
      name: 'a snapshot larger than the ring lost its first records to a stored event',
      size: 3 * MIB,
      between: [{ type: 'turn.started', data: {} }],
      fresh: true,
      events: []
    },
    { name: 'a snapshot larger than the ring, with nothing after it', size: 3 * MIB, between: [], events: [] }
  ]
  for (const row of rows)
    it(`${row.name}: ${row.fresh ? 'a fresh snapshot' : 'the one published'}`, async () => {
      let version = 0
      const f = await adapterFixture(() => `${++version}:`.padEnd(row.size, 'x'))
      const descriptor = f.adapter.activate('t1')
      expect(f.builds()).toBe(1)
      for (const event of row.between) f.emit(event)
      const served = f.read(descriptor.id)
      expect(f.builds()).toBe(1 + (row.replaced ? 1 : 0) + (row.fresh ? 1 : 0))
      // Either way the reader has the newest snapshot whole, and what was stored after it.
      expect(served.snapshot?.content.startsWith(`${version}:`)).toBe(true)
      expect(served.events).toEqual(row.events)
      // A second reader, with nothing new in between, is served that snapshot again.
      const builds = f.builds()
      expect(f.read(descriptor.id).snapshot.content.startsWith(`${version}:`)).toBe(true)
      expect(f.builds()).toBe(builds)
    })
})

describe('a phone opening a thread kept in thread.db', () => {
  const message = (index: number, size: number): ChatMessage =>
    ({
      id: `m-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}:`.padEnd(size, 'x'),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    }) as ChatMessage

  async function opened(messages: ChatMessage[], { loaded = false } = {}) {
    const f = await fixture()
    f.mms.threads.setSqliteStoreEnabled(true)
    const thread = f.mms.threads.createThread('Long', undefined, undefined, { started: true })
    f.mms.threads.mutateThreadData(thread.id, () => ({ messages }))
    expect(f.mms.threads.usesThreadDb(thread.id)).toBe(true)
    if (loaded) f.mms.orchestrator.getOrCreateSession(thread.id)
    const adapter = f.makeAdapter()
    await f.connect(adapter.store)
    const builds = vi.spyOn(MmsRemoteBackend.prototype, 'snapshot'),
      wholeReads = vi.spyOn(f.mms.orchestrator, 'getMessages'),
      sessionLoads = vi.spyOn(f.mms.orchestrator, 'getOrCreateSession')
    const updates: any[] = [],
      errors: string[] = []
    // The hub opens the stream (`bridge.thread.open`), subscribes, and reads its snapshot, as a phone does.
    await f.hub().attach(
      { nodeId: f.targetNode, entityId: thread.id },
      (value) => updates.push(value),
      (code) => errors.push(code)
    )
    await vi.waitFor(() => expect(updates.some((value) => value.kind === 'snapshot')).toBe(true), { timeout: 30_000 })
    expect(errors).toEqual([])
    return {
      f,
      thread,
      snapshot: updates.find((value) => value.kind === 'snapshot').value,
      builds: builds.mock.calls.length,
      wholeReads: wholeReads.mock.calls.length,
      sessionLoads: sessionLoads.mock.calls.length
    }
  }

  it('reads its newest 8 MiB without loading the thread, and builds the snapshot once', async () => {
    const all = Array.from({ length: 40 }, (_, index) => message(index, 512 * KIB))
    const open = await opened(all)
    expect(open.builds).toBe(1)
    expect(open.wholeReads).toBe(0)
    expect(open.sessionLoads).toBe(0)
    expect(open.f.mms.orchestrator.hasSession(open.thread.id)).toBe(false)
    const newest = open.snapshot.messages as Array<{ id: string }>
    expect(newest.at(-1)!.id).toBe('m-39')
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThanOrEqual(8 * MIB)
    expect(open.snapshot.earlier).toEqual({ before: newest[0].id, count: 40 - newest.length })
  }, 120_000)

  it('builds the snapshot once from a thread that is loaded already', async () => {
    const open = await opened([message(0, 100), message(1, 100)], { loaded: true })
    expect(open.builds).toBe(1)
    expect(open.snapshot.messages.map((row: { id: string }) => row.id)).toEqual(['m-0', 'm-1'])
  }, 120_000)

  it('loads the thread when its newest page shows work still running, which loading settles', async () => {
    const running = { ...message(1, 100), kind: 'context_compaction', streaming: true } as ChatMessage
    const open = await opened([message(0, 100), running])
    expect(open.builds).toBe(1)
    expect(open.f.mms.orchestrator.hasSession(open.thread.id)).toBe(true)
    expect(open.snapshot.messages.find((row: { id: string }) => row.id === 'm-1').streaming).not.toBe(true)
  }, 120_000)
})

describe('the newest page read ahead of a snapshot', () => {
  it('is not used once the thread changed after it was read', async () => {
    const f = await fixture()
    f.mms.threads.setSqliteStoreEnabled(true)
    const thread = f.mms.threads.createThread('Changing', undefined, undefined, { started: true })
    f.mms.threads.mutateThreadData(thread.id, () => ({
      messages: [{ id: 'm-0', role: 'user', content: 'first', timestamp: new Date().toISOString() } as ChatMessage]
    }))
    const backend = new MmsRemoteBackend(f.mms)
    await backend.warm(thread.id)
    f.mms.threads.mutateThreadData(thread.id, (current) => ({
      messages: [...current.messages, { id: 'm-1', role: 'assistant', content: 'second', timestamp: new Date().toISOString() } as ChatMessage]
    }))
    const snapshot = backend.snapshot(thread.id) as { messages: Array<{ id: string }> }
    expect(snapshot.messages.map((row) => row.id)).toEqual(['m-0', 'm-1'])
  }, 60_000)
})
