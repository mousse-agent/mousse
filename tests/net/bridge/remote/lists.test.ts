import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  LISTS_STREAM_THREAD_ID,
  MmsListsSource,
  ThreadStreamAdapter,
  type ListsSnapshot,
  type ThreadSourceEvent
} from '../../../../src/mms/bridge/remote'
import type { ListsServices } from '../../../../src/mms/bridge/remote/MmsListsSource'
import { remoteListMethods, type RemoteChatsPort } from '../../../../src/mms/bridge/remote/RemoteLists'
import type { ChatSummary } from '../../../../src/shared/chats'
import type { Project, Thread, ThreadActivityState, TurnState } from '../../../../src/shared/types'
import type { RpcContext } from '../../../../src/mms/net/contracts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose()
})

const at = '2026-10-21T10:00:00.000Z'

function fakeServices() {
  const threads = Object.assign(new EventEmitter(), { list: [] as Thread[], listAllThreads: () => threads.list })
  const projects = { list: [] as Project[], listProjects: () => projects.list }
  const orchestrator = Object.assign(new EventEmitter(), { turns: {} as Record<string, TurnState>, getTurnSnapshot: () => orchestrator.turns })
  const runtimes = Object.assign(new EventEmitter(), { activity: {} as Record<string, ThreadActivityState>, getActivitySnapshot: () => runtimes.activity })
  const chatListeners = new Set<() => void>()
  const chats = {
    list: [] as ChatSummary[],
    snapshot: () => ({ chats: chats.list }),
    onChange: (listener: () => void) => {
      chatListeners.add(listener)
      return () => chatListeners.delete(listener)
    },
    changed: () => chatListeners.forEach((listener) => listener())
  }
  const services = {
    threads,
    projects,
    orchestrator,
    threadRuntimes: runtimes,
    questions: new EventEmitter(),
    events: new EventEmitter(),
    platform: { chats }
  } as unknown as ListsServices
  return { services, threads, projects, orchestrator, runtimes, chats, chatListeners }
}

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, name: `Thread ${id}`, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...extra }
}

/** Timers the test runs by hand. */
function manualTimers() {
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  let next = 1
  return {
    timeouts,
    intervals,
    setTimeout: (run: () => void) => (timeouts.set(next, run), next++),
    clearTimeout: (handle: unknown) => timeouts.delete(handle as number),
    setInterval: (run: () => void) => (intervals.set(next, run), next++),
    clearInterval: (handle: unknown) => intervals.delete(handle as number),
    flush() {
      const due = [...timeouts.entries()]
      timeouts.clear()
      for (const [, run] of due) run()
    }
  }
}

describe('phone sidebar lists', () => {
  it('lists projects, threads, chats and only the threads that are not idle', () => {
    const f = fakeServices()
    f.projects.list = [{ id: 'p1', name: 'Mousse', path: '/src/mousse', createdAt: at, order: 0 }]
    f.threads.list = [
      thread('t1', { projectId: 'p1', pinnedAt: at }),
      thread('t2'),
      thread('t3'),
      thread('t4'),
      thread('t5', { settledAt: at })
    ]
    f.runtimes.activity = { t1: 'processing', t2: 'awaiting_input', t3: 'completed', t5: 'idle' }
    f.orchestrator.turns = {
      t1: { threadId: 't1', turnId: 'x', phase: 'streaming', startedAt: at, updatedAt: at },
      t4: { threadId: 't4', turnId: 'y', phase: 'failed', updatedAt: at, error: 'Provider refused' }
    }
    f.chats.list = [
      {
        id: 'c1', kind: 'direct', name: 'Reviewer', threadId: 'ct1', createdAt: at, updatedAt: at,
        participants: [{ id: 'self', kind: 'person', name: 'You' }, { id: 'a1', kind: 'agent', name: 'Reviewer' }],
        lastMessage: { id: 'm1', participantId: 'a1', text: `Looks\n good ${'x'.repeat(400)}`, createdAt: at, status: 'completed' },
        run: { id: 'r1', state: 'running', startedAt: at }
      },
      {
        presentation: 'network', id: 'c2', kind: 'group', name: 'Team', createdAt: at, updatedAt: at,
        participants: [], binding: {} as never
      } as unknown as ChatSummary
    ]
    const lists: ListsSnapshot = new MmsListsSource(f.services).snapshot()
    expect(lists).toMatchObject({ kind: 'mousse.lists', version: 1 })
    expect(lists.projects).toEqual([{ id: 'p1', name: 'Mousse', path: '/src/mousse', order: 0 }])
    expect(lists.threads.map((entry) => entry.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(lists.threads[0]).toMatchObject({ projectId: 'p1', pinnedAt: at })
    expect(lists.status).toEqual({
      t1: { state: 'processing', since: at },
      t2: { state: 'awaiting_input' },
      t3: { state: 'completed' },
      t4: { state: 'failed', error: 'Provider refused' }
    })
    expect(lists.chats[0]).toMatchObject({ id: 'c1', threadId: 'ct1', agents: ['Reviewer'], run: { id: 'r1', state: 'running' } })
    expect(lists.chats[0]!.preview!.length).toBeLessThanOrEqual(280)
    expect(lists.chats[0]!.preview).toMatch(/^Looks good x/)
    expect(lists.chats[1]).toEqual({ id: 'c2', kind: 'group', name: 'Team', network: true, agents: [], updatedAt: at })
  })

  it('reports a change once per burst, and only when the lists changed', () => {
    const f = fakeServices(),
      timers = manualTimers()
    f.threads.list = [thread('t1')]
    let calls = 0
    const stop = new MmsListsSource(f.services, timers).watch(() => calls++)
    // A burst of signals that change nothing.
    f.threads.emit('updated', f.threads.list[0])
    f.orchestrator.emit('turn-state', {})
    expect(timers.timeouts.size).toBe(1)
    timers.flush()
    expect(calls).toBe(0)
    // A run starts: one call however many events arrive.
    f.runtimes.activity = { t1: 'processing' }
    f.runtimes.emit('activity', {})
    f.orchestrator.emit('turn-state', {})
    timers.flush()
    expect(calls).toBe(1)
    // A rename, a new project and a chat each count.
    f.threads.list = [thread('t1', { name: 'Renamed' })]
    f.threads.emit('updated', f.threads.list[0])
    timers.flush()
    f.projects.list = [{ id: 'p', name: 'P', path: '/p', createdAt: at, order: 0 }]
    ;(f.services.events as unknown as EventEmitter).emit('projects:updated', [])
    timers.flush()
    f.chats.list = [{ id: 'c', kind: 'direct', name: 'C', threadId: 'ct', createdAt: at, updatedAt: at, participants: [] }]
    f.chats.changed()
    timers.flush()
    expect(calls).toBe(4)
    // The slow reconcile catches a change that sent no event.
    f.threads.list = []
    expect(timers.intervals.size).toBe(1)
    ;[...timers.intervals.values()][0]!()
    timers.flush()
    expect(calls).toBe(5)
    stop()
    expect(timers.intervals.size).toBe(0)
    expect(f.chatListeners.size).toBe(0)
    expect((f.services.threads as unknown as EventEmitter).listenerCount('updated')).toBe(0)
  })

  it('publishes the lists as a signed display stream and replaces the snapshot on change', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-lists-')))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const keys = new FileKeyStore(dir),
      identity = new NetIdentityService({ database: db.database, keys, clock: systemClock, coordinator: db })
    await identity.bootstrapAuthority('Lists source')
    const store = new SqliteStreamStore(db)
    cleanups.push(() => store.close())
    let lists = { kind: 'mousse.lists', threads: ['one'] }
    let push: ((event: ThreadSourceEvent) => void) | undefined
    const adapter = new ThreadStreamAdapter({
      db, store, generations: store, identity, keys, clock: systemClock,
      source: {
        snapshot: (id) => {
          expect(id).toBe(LISTS_STREAM_THREAD_ID)
          return lists
        },
        onThread: (_id, listener) => {
          push = listener
          return () => (push = undefined)
        }
      }
    })
    cleanups.push(() => adapter.close())
    const descriptor = adapter.activate(LISTS_STREAM_THREAD_ID)
    const read = () => {
      const reader = adapter.store.openSnapshot(descriptor.id)
      try {
        return reader.next(1024 * 1024).records.map((record) => decodeEnvelope(record.envelope).envelope)
      } finally {
        reader.close()
      }
    }
    const decoded = (envelopes: ReturnType<typeof read>) => {
      const chunks = envelopes.filter((entry) => entry.type === 'thread.snapshot.chunk')
      return JSON.parse(Buffer.concat(chunks.map((entry) => Buffer.from((entry.body as { data: string }).data, 'base64url'))).toString())
    }
    expect(decoded(read())).toEqual(lists)
    const before = adapter.store.head(descriptor.id).seq
    lists = { kind: 'mousse.lists', threads: ['one', 'two'] }
    push!({ snapshot: true })
    const after = read()
    expect(adapter.store.head(descriptor.id).seq).toBeGreaterThan(before)
    expect(after[0]!.type).toBe('thread.snapshot.begin')
    expect(after.filter((entry) => entry.type === 'thread.snapshot.begin')).toHaveLength(1)
    expect(decoded(after)).toEqual(lists)
  })

  it('opens the lists, and sends to and stops only local chats that are free', async () => {
    const chats: ChatSummary[] = [
      { id: 'c1', kind: 'direct', name: 'A', threadId: 't', createdAt: at, updatedAt: at, participants: [] },
      { presentation: 'network', id: 'c2', kind: 'group', name: 'Space', createdAt: at, updatedAt: at, participants: [], binding: {} } as unknown as ChatSummary
    ]
    const sent: unknown[] = []
    let refuse: { code: string; message: string } | undefined
    let currentRun = 'r1'
    const port: RemoteChatsPort = {
      snapshot: () => ({ chats }),
      assertSendable: () => {
        if (refuse) throw Object.assign(new Error(refuse.message), { code: refuse.code })
      },
      assertCancellable: (_chatId, runId) => {
        if (runId !== currentRun) throw Object.assign(new Error('The selected response is no longer current'), { code: 'run_conflict' })
      },
      send: (input) => {
        sent.push(input)
        return { ...(chats[0] as never), messages: [], run: { id: 'r1', state: 'running', startedAt: at } }
      },
      cancel: () => ({ ...(chats[0] as never), messages: [], run: { id: 'r1', state: 'cancelled', startedAt: at } })
    }
    const methods = new Map(remoteListMethods({ openLists: () => ({ descriptor: 'd' }), chats: () => port }).map((method) => [method.method, method]))
    expect([...methods.keys()]).toEqual(['bridge.lists.open', 'chats.send', 'chats.cancel'])
    expect(methods.get('bridge.lists.open')).toMatchObject({ capability: 'read', mutating: false, family: 'bridge' })
    expect(methods.get('chats.send')).toMatchObject({ capability: 'chat', mutating: true, family: 'bridge' })
    expect(methods.get('chats.cancel')).toMatchObject({ capability: 'chat', mutating: true, family: 'bridge' })
    expect(() => methods.get('bridge.lists.open')!.validate!({ extra: 1 })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    const send = methods.get('chats.send')!
    expect(() => send.validate!({ chatId: 'c1' })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    expect(() => send.validate!({ chatId: 'c1', text: '  ' })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    expect(() => send.validate!({ chatId: 'c1', text: 'hi', profileId: 'x' })).toThrow(expect.objectContaining({ code: 'bad_request' }))
    const context = { execution: 'exec_01abc' } as unknown as RpcContext
    expect(() => send.authorize!({ chatId: 'nope', text: 'hi' }, context)).toThrow(expect.objectContaining({ code: 'stream_unknown' }))
    expect(() => send.authorize!({ chatId: 'c2', text: 'hi' }, context)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    send.authorize!({ chatId: 'c1', text: 'hi' }, context)
    expect(await send.handle({ chatId: 'c1', text: 'hi' }, context)).toEqual({ chatId: 'c1', run: { id: 'r1', state: 'running' } })
    expect(sent).toEqual([{ chatId: 'c1', text: 'hi', clientMessageId: 'exec_01abc' }])
    // Refusals from the chat service reach the phone as plain, non-retryable errors.
    expect(() => send.authorizeNew!({ chatId: 'c1', text: 'again' }, context)).not.toThrow()
    refuse = { code: 'chat_busy', message: 'Wait for this chat response or cancel it first' }
    expect(() => send.authorizeNew!({ chatId: 'c1', text: 'again' }, context)).toThrow(expect.objectContaining({ code: 'conflict', message: 'Wait for this chat response or cancel it first' }))
    refuse = { code: 'chat_published', message: 'This Group sends through its published Space' }
    expect(() => send.authorizeNew!({ chatId: 'c1', text: 'again' }, context)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    refuse = { code: 'agent_unavailable', message: 'Reviewer is unavailable on this device' }
    expect(() => send.authorizeNew!({ chatId: 'c1', text: 'again' }, context)).toThrow(expect.objectContaining({ code: 'conflict' }))
    // The busy check is not part of `authorize`, which a retry of an earlier send also passes.
    expect(() => send.authorize!({ chatId: 'c1', text: 'again' }, context)).not.toThrow()
    const cancel = methods.get('chats.cancel')!
    expect(await cancel.handle(cancel.validate!({ chatId: 'c1', runId: 'r1' }), context)).toEqual({ chatId: 'c1', run: { id: 'r1', state: 'cancelled' } })
    // Stop after the reply finished and a newer run took its place is a plain conflict.
    expect(() => cancel.authorizeNew!({ chatId: 'c1', runId: 'r1' }, context)).not.toThrow()
    currentRun = 'r2'
    expect(() => cancel.authorizeNew!({ chatId: 'c1', runId: 'r1' }, context)).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('rereads chats only when a chat signals or the reconcile tick runs', () => {
    const f = fakeServices(),
      timers = manualTimers()
    f.threads.list = [thread('t1')]
    let reads = 0
    const read = f.chats.snapshot
    f.chats.snapshot = () => (reads++, read())
    let calls = 0
    const stop = new MmsListsSource(f.services, timers).watch(() => calls++)
    expect(reads).toBe(1)
    // Thread, turn and activity signals change the lists without touching the chat files.
    f.runtimes.activity = { t1: 'processing' }
    f.runtimes.emit('activity', {})
    timers.flush()
    f.orchestrator.emit('turn-state', {})
    f.threads.emit('updated', f.threads.list[0])
    timers.flush()
    expect(calls).toBe(1)
    expect(reads).toBe(1)
    // A chat signal rereads once for the burst and publishes the new chat.
    f.chats.list = [{ id: 'c', kind: 'direct', name: 'C', threadId: 'ct', createdAt: at, updatedAt: at, participants: [] }]
    f.chats.changed()
    f.chats.changed()
    timers.flush()
    expect(reads).toBe(2)
    expect(calls).toBe(2)
    // The reconcile tick rereads once, and catches a chat change that sent no signal.
    f.chats.list = []
    ;[...timers.intervals.values()][0]!()
    timers.flush()
    expect(reads).toBe(3)
    expect(calls).toBe(3)
    stop()
  })
})
