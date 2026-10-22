import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { FileBlobStore } from '../../../../src/mms/net/store/blobs'
import { SqliteExecutionLedger } from '../../../../src/mms/net/store/executions'
import { DurableRpcDispatcher } from '../../../../src/mms/net/sync/rpcDispatcher'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import { openSecureChannel } from '../../../../src/mms/net/link/secureChannel'
import { fingerprint } from '../../../../src/mms/net/link/selfSignedCert'
import type { Clock, StreamStore } from '../../../../src/mms/net/contracts'
import { systemClock } from '../../../../src/mms/net/clock'
import {
  RemoteApi,
  MmsRemoteBackend,
  MmsThreadSource,
  ThreadStreamAdapter,
  type ThreadSourceEvent,
  type ThreadSourcePort
} from '../../../../src/mms/bridge/remote'
import { newId, type NodeDelegation, type WireMessage } from '../../../../src/shared/net'
import { memoryPair } from '../../harness/MemoryTransport'

const resources: Array<() => void | Promise<void>> = [],
  paths: string[] = []
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
function temp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bridge-q-')))
  paths.push(path)
  return path
}

async function setup(caps: NodeDelegation['caps'] = ['read', 'chat', 'write']) {
  const mms = await MousseMainService.create({ homeDir: temp(), headless: true, ownerKind: 'test' })
  await mms.start()
  resources.push(() => mms.stop())
  const aPath = mms.getProfileHomeDir(),
    bPath = temp(),
    aDb = new NetDatabase({ profileDir: aPath }),
    bDb = new NetDatabase({ profileDir: bPath })
  resources.push(
    () => aDb.close(),
    () => bDb.close()
  )
  const aKeys = new FileKeyStore(aPath),
    bKeys = new FileKeyStore(bPath),
    aIdentity = new NetIdentityService({
      database: aDb.database,
      keys: aKeys,
      clock: systemClock,
      coordinator: aDb
    })
  await aIdentity.bootstrapAuthority('Bridge source')
  await bKeys.initialize({ asAuthority: false })
  const node = newId('node'),
    user = aIdentity.self()!.user
  aIdentity.issueNodeDelegation({ node, keys: bKeys.nodeKeys(), name: 'Phone', caps })
  const bIdentity = new NetIdentityService({
    database: bDb.database,
    keys: bKeys,
    clock: systemClock,
    coordinator: bDb,
    self: { user, node }
  })
  bIdentity.pinUser(user, aKeys.rootKey()!)
  bIdentity.acceptRoster(aIdentity.roster()!, aKeys.rootKey()!)
  const aStore = new SqliteStreamStore(aDb),
    bStore = new SqliteStreamStore(bDb),
    aBlobs = new FileBlobStore(aDb)
  resources.push(
    () => aStore.close(),
    () => bStore.close(),
    () => aBlobs.close()
  )
  const dispatcher = new DurableRpcDispatcher({
      db: aDb,
      executions: new SqliteExecutionLedger(aDb),
      identity: aIdentity,
      clock: systemClock
    }),
    api = new RemoteApi(new MmsRemoteBackend(mms), systemClock)
  api.register(dispatcher)
  resources.push(() => api.close())
  async function connect(store: StreamStore = aStore, presence = false) {
    const transport = memoryPair(),
      [aChannel, bChannel] = await Promise.all([
        openSecureChannel(transport.b, {
          role: 'server',
          credentials: aKeys.tlsCredentials(),
          deadlineMs: 2000
        }),
        openSecureChannel(transport.a, {
          role: 'client',
          credentials: bKeys.tlsCredentials(),
          expectedPeerFingerprint: fingerprint(
            Buffer.from(aKeys.nodeKeys().transport, 'base64url')
          ),
          deadlineMs: 2000
        })
      ])
    const a = new NetSyncSession({
        channel: aChannel,
        identity: aIdentity,
        store,
        authority: new NodeStreamAuthority(aIdentity, store, aBlobs, systemClock),
        blobs: aBlobs,
        rpc: dispatcher,
        capabilities: ['streams.v1', 'rpc.v1', 'blobs.v1', 'presence.v1'],
        verifyPresence: () => false
      }),
      b = new NetSyncSession({
        channel: bChannel,
        identity: bIdentity,
        store: bStore,
        capabilities: [
          'streams.v1',
          'rpc.v1',
          'blobs.v1',
          ...(presence ? ['presence.v1' as const] : [])
        ],
        ...(presence ? { verifyPresence: () => false } : {})
      })
    resources.push(
      () => a.close(),
      () => b.close(),
      () => transport.cut()
    )
    await Promise.all([a.opened, b.opened])
    return { a, b }
  }
  return { mms, aDb, aStore, bStore, aKeys, aIdentity, connect }
}

/** A clock whose timers run only when the test flushes them. */
function manualClock(): Clock & { flush(): void; pending(): number } {
  let timers: Array<{ run: () => void; cancelled: boolean }> = []
  return {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    setTimeout(callback) {
      const timer = { run: callback, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
    flush() {
      const due = timers
      timers = []
      for (const timer of due) if (!timer.cancelled) timer.run()
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length
  }
}

const rpc = (idem?: string) => ({ id: newId('rpc'), deadlineMs: 2000, ...(idem ? { idem } : {}) })

describe('remote pending questions', () => {
  it('lists, answers and dismisses only questions that belong to the named thread', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Asks'),
      other = p.mms.threads.createThread('Other')
    const answered = p.mms.questions.requestAnswers(
      [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'Alpha' }] }],
      thread.id
    )
    const { pending } = (await b.rpc(
      'orchestrator.pendingQuestions',
      { threadId: thread.id },
      rpc()
    )) as { pending: Array<{ requestId: string; threadId: string }> }
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ threadId: thread.id, questions: [{ id: 'q1' }] })
    const requestId = pending[0].requestId
    expect(await b.rpc('orchestrator.pendingQuestions', { threadId: other.id }, rpc())).toEqual({
      pending: []
    })
    // Naming another thread never settles the question.
    expect(
      await b.rpc(
        'orchestrator.answerQuestions',
        { threadId: other.id, requestId, answers: { q1: 'a' } },
        rpc('wrong-thread')
      )
    ).toEqual({ ok: false })
    expect(
      await b.rpc(
        'orchestrator.dismissQuestions',
        { threadId: other.id, requestId },
        rpc('wrong-thread-dismiss')
      )
    ).toEqual({ ok: false })
    expect(p.mms.questions.getPending(requestId)).not.toBeNull()
    for (const answers of [
      [],
      { q1: 5 },
      { q1: ['x'.repeat(1025)] },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['k' + i, 'v']))
    ])
      await expect(
        b.rpc(
          'orchestrator.answerQuestions',
          { threadId: thread.id, requestId, answers },
          rpc('bad-' + newId('rpc'))
        )
      ).rejects.toMatchObject({ code: 'bad_request' })
    expect(
      await b.rpc(
        'orchestrator.answerQuestions',
        { threadId: thread.id, requestId, answers: { q1: 'a' } },
        rpc('answer')
      )
    ).toEqual({ ok: true })
    await expect(answered).resolves.toEqual({ q1: 'a' })
    expect(
      p.mms.orchestrator
        .getMessages(thread.id)
        .some((message) => message.role === 'user' && message.content.includes('Alpha'))
    ).toBe(true)

    const dismissed = p.mms.questions
      .requestAnswers([{ id: 'q2', prompt: 'Again?', options: [] }], thread.id)
      .then(
        () => 'answered',
        (error: Error) => error.message
      )
    const next = p.mms.questions.listPendingForThread(thread.id)[0].requestId
    expect(
      await b.rpc(
        'orchestrator.dismissQuestions',
        { threadId: thread.id, requestId: next },
        rpc('dismiss')
      )
    ).toEqual({ ok: true })
    await expect(dismissed).resolves.toMatch(/dismissed/)
  })

  it('lets a read-only phone see questions but not answer them', async () => {
    const p = await setup(['read']),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Read only')
    void p.mms.questions
      .requestAnswers([{ id: 'q', prompt: 'Yes?', options: [] }], thread.id)
      .catch(() => undefined)
    const requestId = p.mms.questions.listPendingForThread(thread.id)[0].requestId
    expect(
      await b.rpc('orchestrator.pendingQuestions', { threadId: thread.id }, rpc())
    ).toMatchObject({ pending: [{ requestId }] })
    for (const [method, params] of [
      ['orchestrator.answerQuestions', { threadId: thread.id, requestId, answers: { q: 'y' } }],
      ['orchestrator.dismissQuestions', { threadId: thread.id, requestId }]
    ] as const)
      await expect(b.rpc(method, params, rpc('denied-' + method))).rejects.toMatchObject({
        code: 'forbidden'
      })
    expect(p.mms.questions.getPending(requestId)).not.toBeNull()
  })

  it('reports question changes from the thread source as display-only deltas', async () => {
    const p = await setup(),
      thread = p.mms.threads.createThread('Live questions'),
      events: ThreadSourceEvent[] = []
    const stop = new MmsThreadSource(p.mms).onThread(thread.id, (event) => events.push(event))
    resources.push(stop)
    const asked = p.mms.questions
      .requestAnswers([{ id: 'q', prompt: 'Go?', options: [] }], thread.id)
      .catch(() => undefined)
    void p.mms.questions
      .requestAnswers([{ id: 'x', prompt: 'Elsewhere', options: [] }], 'another-thread')
      .catch(() => undefined)
    const updates = () => events.filter((event) => event.type === 'questions.updated')
    expect(updates()).toEqual([
      {
        type: 'questions.updated',
        ephemeral: true,
        data: {
          threadId: thread.id,
          pending: [
            expect.objectContaining({
              threadId: thread.id,
              questions: [expect.objectContaining({ id: 'q' })]
            })
          ]
        }
      }
    ])
    p.mms.questions.dismiss(p.mms.questions.listPendingForThread(thread.id)[0].requestId)
    await asked
    expect(updates().at(-1)).toEqual({
      type: 'questions.updated',
      ephemeral: true,
      data: { threadId: thread.id, pending: [] }
    })
  })
})

describe('remote display deltas', () => {
  function fakeSource(threadId: string) {
    let emit!: (event: ThreadSourceEvent) => void
    const source: ThreadSourcePort = {
      snapshot: (id) => ({ thread: { id }, messages: [] }),
      onThread: (id, listener) => {
        expect(id).toBe(threadId)
        emit = listener
        return () => undefined
      }
    }
    return { source, emit: (event: ThreadSourceEvent) => emit(event) }
  }
  const message = (id: string, content: string, streaming = true) => ({
    threadId: 't1',
    message: { id, role: 'assistant', content, timestamp: '2026-10-21T00:00:00.000Z', streaming }
  })

  it('coalesces streaming deltas per message and drops them once the settled record lands', async () => {
    const p = await setup(),
      clock = manualClock(),
      { source, emit } = fakeSource('t1'),
      deltas: unknown[] = [],
      errors: unknown[] = []
    const adapter = new ThreadStreamAdapter({
      db: p.aDb,
      store: p.aStore,
      generations: p.aStore,
      identity: p.aIdentity,
      keys: p.aKeys,
      clock,
      source,
      onDelta: (_stream, body) => deltas.push(body),
      onError: (_thread, error) => errors.push(error)
    })
    resources.push(() => adapter.close())
    adapter.activate('t1')
    emit({ type: 'thread.message-updated', data: message('m1', 'H'), ephemeral: true })
    emit({ type: 'thread.message-updated', data: message('m1', 'Hel'), ephemeral: true })
    emit({ type: 'thread.message-updated', data: message('m2', 'Other'), ephemeral: true })
    emit({ type: 'questions.updated', data: { threadId: 't1', pending: [] }, ephemeral: true })
    emit({
      type: 'thread.message-updated',
      data: message('big', 'z'.repeat(40 * 1024)),
      ephemeral: true
    })
    expect(deltas).toEqual([])
    expect(clock.pending()).toBe(1)
    clock.flush()
    expect(deltas).toEqual([
      { threadId: 't1', type: 'thread.message-updated', data: message('m1', 'Hel') },
      { threadId: 't1', type: 'thread.message-updated', data: message('m2', 'Other') },
      { threadId: 't1', type: 'questions.updated', data: { threadId: 't1', pending: [] } }
    ])
    deltas.length = 0
    emit({ type: 'thread.message-updated', data: message('m1', 'Hello'), ephemeral: true })
    emit({ type: 'thread.message-updated', data: message('m1', 'Hello!', false) })
    clock.flush()
    expect(deltas).toEqual([])
    emit({ type: 'thread.message-updated', data: message('m3', 'a'), ephemeral: true })
    emit({ type: 'thread.messages', data: { threadId: 't1', messages: [] } })
    clock.flush()
    expect(deltas).toEqual([])
    expect(errors).toEqual([])
    // Durable-only and unknown types are refused as deltas, failing the stream like any bad event.
    emit({ type: 'turn.state', data: { threadId: 't1' }, ephemeral: true } as ThreadSourceEvent)
    expect(errors).toEqual([expect.objectContaining({ code: 'bad_request' })])
  })

  it('sends deltas only to sessions live-serving the stream with presence negotiated', async () => {
    const p = await setup(),
      { source, emit } = fakeSource('t1')
    let publish: (stream: string, body: unknown) => void = () => undefined
    const adapter = new ThreadStreamAdapter({
      db: p.aDb,
      store: p.aStore,
      generations: p.aStore,
      identity: p.aIdentity,
      keys: p.aKeys,
      clock: systemClock,
      source,
      deltaIntervalMs: 1,
      onDelta: (stream, body) => publish(stream, body)
    })
    resources.push(() => adapter.close())
    const descriptor = adapter.activate('t1')
    p.bStore.createStream(descriptor, 1)
    const plain = await p.connect(adapter.store),
      live = await p.connect(adapter.store, true),
      received: Array<Extract<WireMessage, { t: 'ephemeral' | 'presence' }>> = []
    live.b.onEphemeral((message) => received.push(message))
    publish = (stream, body) => {
      plain.a.publishDelta(stream as typeof descriptor.id, body)
      live.a.publishDelta(stream as typeof descriptor.id, body)
    }
    // Not yet subscribed: nothing is sent.
    emit({ type: 'thread.message-updated', data: message('m1', 'early'), ephemeral: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual([])
    for (const session of [plain.b, live.b])
      await new Promise<void>((resolve, reject) =>
        session.subscribe(descriptor.id, {
          onRecord() {},
          onCaughtUp: () => resolve(),
          onSnapshotInstalled: () => resolve(),
          onError: (code) => reject(new Error(code))
        })
      )
    emit({ type: 'thread.message-updated', data: message('m1', 'streamed'), ephemeral: true })
    await vi.waitFor(() =>
      expect(received).toEqual([
        {
          t: 'ephemeral',
          stream: descriptor.id,
          kind: 'delta',
          data: { threadId: 't1', type: 'thread.message-updated', data: message('m1', 'streamed') }
        }
      ])
    )
    expect(plain.a.state()).toBe('open')
    expect(plain.b.state()).toBe('open')
  })

  it('keeps the session open when deltas outpace the link, sending the newest per key', async () => {
    // A reply with an applet streams ~32 KiB deltas every 100 ms, faster than a phone link drains.
    const p = await setup(),
      { source } = fakeSource('t1')
    const adapter = new ThreadStreamAdapter({
      db: p.aDb,
      store: p.aStore,
      generations: p.aStore,
      identity: p.aIdentity,
      keys: p.aKeys,
      clock: systemClock,
      source
    })
    resources.push(() => adapter.close())
    const descriptor = adapter.activate('t1')
    p.bStore.createStream(descriptor, 1)
    const live = await p.connect(adapter.store, true),
      received: unknown[] = []
    live.b.onEphemeral((message) => received.push((message as { data?: unknown }).data))
    await new Promise<void>((resolve, reject) =>
      live.b.subscribe(descriptor.id, {
        onRecord() {},
        onCaughtUp: () => resolve(),
        onSnapshotInstalled: () => resolve(),
        onError: (code) => reject(new Error(code))
      })
    )
    const questions = { threadId: 't1', type: 'questions.updated', data: { pending: [] } }
    for (let i = 0; i < 40; i++)
      live.a.publishDelta(
        descriptor.id,
        {
          threadId: 't1',
          type: 'thread.message-updated',
          data: message('m1', `${i}`.padEnd(31 * 1024, 'x'))
        },
        'message:m1'
      )
    live.a.publishDelta(descriptor.id, questions, 'questions')
    const last = message('m1', '39'.padEnd(31 * 1024, 'x'))
    await vi.waitFor(() =>
      expect(received).toContainEqual({
        threadId: 't1',
        type: 'thread.message-updated',
        data: last
      })
    )
    await vi.waitFor(() => expect(received).toContainEqual(questions))
    expect(received.length).toBeLessThan(10)
    expect(live.a.state()).toBe('open')
    expect(live.b.state()).toBe('open')
  })
})
