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
import { NetError, newId, type NodeDelegation, type WireMessage } from '../../../../src/shared/net'
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

describe('remote approval requests (SPEC §17)', () => {
  const question = [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]
  const tag = {
    action: 'command' as const,
    permissionKey: 'claude:command',
    options: [{ id: 'allow', decision: 'allow' as const, scope: 'once' as const }, { id: 'reject', decision: 'reject' as const }],
    tool: { name: 'Bash', input: { command: 'npm test' } }
  }
  const ask = (p: Awaited<ReturnType<typeof setup>>, threadId: string) => {
    const outcome = p.mms.questions.requestAnswers(question, threadId, { approval: tag }).then((value) => value, (error: Error) => error.message)
    return { outcome, requestId: p.mms.questions.listPendingForThread(threadId)[0]!.requestId }
  }
  const answer = (b: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['connect']>>['b'], threadId: string, requestId: string, answers: Record<string, string>, idem = 'a-' + newId('rpc')) =>
    b.rpc('orchestrator.answerQuestions', { threadId, requestId, answers }, rpc(idem))

  it('a phone with the chat capability answers a saved request; the answer is recorded as coming from the Bridge', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Approve'),
      { outcome, requestId } = ask(p, thread.id)
    const { pending } = (await b.rpc('orchestrator.pendingQuestions', { threadId: thread.id }, rpc())) as { pending: Array<{ requestId: string; approval?: { answerPath: string } }> }
    expect(pending).toEqual([expect.objectContaining({ requestId, approval: expect.objectContaining({ answerPath: 'live' }) })])
    expect(await answer(b, thread.id, requestId, { permission: 'reject', feedback: 'not on a phone' })).toEqual({ ok: true })
    await expect(outcome).resolves.toEqual({ permission: 'reject', feedback: 'not on a phone' })
    expect(p.mms.runEngine.approvals.get(requestId)).toMatchObject({ status: 'answered', decision: 'reject', feedback: 'not on a phone', answeredBy: { kind: 'user', via: 'bridge' } })
  })

  it('a phone answers "Always for this thread": that exact request is not asked again, anything else is, and the phone cannot touch the rules', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Always'),
      sent = await p.mms.runEngine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'always-run', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    p.mms.runEngine.markStarting(sent.runId)
    p.mms.runEngine.markRunning(sent.runId)
    const exact = { ...tag, tool: { name: 'Bash', input: { command: 'npm test' }, cwd: '/work/app' } }
    const askExact = (approval = exact) => {
      const outcome = p.mms.questions.requestAnswers(question, thread.id, { approval }).then((value) => value, (error: Error) => error.message)
      return { outcome, pending: p.mms.questions.listPendingForThread(thread.id) }
    }

    const first = askExact()
    const requestId = first.pending[0]!.requestId
    const { pending } = (await b.rpc('orchestrator.pendingQuestions', { threadId: thread.id }, rpc())) as { pending: Array<{ questions: Array<{ options: Array<{ id: string; decision?: string; scope?: string }> }> }> }
    expect(pending[0]!.questions[0]!.options).toContainEqual({ id: 'allow_always', label: 'Always for this thread', decision: 'allow', scope: 'always' })
    expect(await answer(b, thread.id, requestId, { permission: 'allow_always' })).toEqual({ ok: true })
    await expect(first.outcome).resolves.toEqual({ permission: 'allow' })
    expect(p.mms.runEngine.approvals.get(requestId)).toMatchObject({ decision: 'allow', decisionScope: 'always', answeredBy: { kind: 'user', via: 'bridge' } })
    expect(p.mms.runEngine.approvals.listRules(thread.id)).toHaveLength(1)

    // The same request is answered by the rule; a near miss asks.
    const again = askExact()
    expect(again.pending).toEqual([])
    await expect(again.outcome).resolves.toEqual({ permission: 'allow' })
    const nearMiss = askExact({ ...exact, tool: { name: 'Bash', input: { command: 'npm test --watch' }, cwd: '/work/app' } })
    expect(nearMiss.pending).toHaveLength(1)
    p.mms.questions.dismissAllForThread(thread.id)
    await nearMiss.outcome

    // The phone has no way to list or revoke rules.
    for (const method of ['threads.approvalRules', 'threads.clearApprovalRules'])
      await expect(b.rpc(method, { threadId: thread.id }, rpc(`no-${method}`))).rejects.toBeTruthy()
    expect(p.mms.runEngine.approvals.listRules(thread.id)).toHaveLength(1)
  })

  it('a phone that can only read sees the request but cannot answer it', async () => {
    const p = await setup(['read']),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Read only'),
      { outcome, requestId } = ask(p, thread.id)
    expect(await b.rpc('orchestrator.pendingQuestions', { threadId: thread.id }, rpc())).toMatchObject({ pending: [{ requestId }] })
    await expect(answer(b, thread.id, requestId, { permission: 'allow' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(p.mms.runEngine.approvals.get(requestId)!.status).toBe('pending')
    p.mms.questions.dismissAllForThread(thread.id)
    await outcome
  })

  it('a local answer wins: the phone gets the terminal result with who decided what, and its retry is told the same', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Race'),
      { outcome, requestId } = ask(p, thread.id)
    expect(p.mms.questions.settle(requestId, { permission: 'allow' }, { kind: 'user', via: 'gui' })).toEqual({ ok: true, decision: 'allow' })
    await expect(outcome).resolves.toEqual({ permission: 'allow' })
    const expected = { ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'gui' }, decision: 'allow' }
    expect(await answer(b, thread.id, requestId, { permission: 'reject' }, 'late')).toEqual(expected)
    // The same request replays its recorded result; a fresh one is told the same.
    expect(await answer(b, thread.id, requestId, { permission: 'reject' }, 'late')).toEqual(expected)
    expect(await answer(b, thread.id, requestId, { permission: 'reject' })).toEqual(expected)
    expect(p.mms.runEngine.approvals.get(requestId)).toMatchObject({ decision: 'allow', answeredBy: { kind: 'user', via: 'gui' } })
  })

  it('the phone\'s own answer, retried, is already answered with the phone as the winner', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Retry'),
      { requestId } = ask(p, thread.id)
    expect(await answer(b, thread.id, requestId, { permission: 'allow' }, 'first')).toEqual({ ok: true })
    expect(await answer(b, thread.id, requestId, { permission: 'allow' }, 'second')).toEqual({
      ok: false, reason: 'already_answered', answeredBy: { kind: 'user', via: 'bridge' }, decision: 'allow'
    })
  })

  it('a request that was closed says so', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Closed'),
      { outcome, requestId } = ask(p, thread.id)
    p.mms.runEngine.approvals.cancelForThread(thread.id, 'stopped')
    await expect(outcome).resolves.toMatch(/closed/)
    expect(await answer(b, thread.id, requestId, { permission: 'allow' })).toEqual({ ok: false, reason: 'cancelled', cancelReason: 'stopped' })
  })

  it('naming another thread, or an unknown request, gets a bare refusal whether the request is pending or settled', async () => {
    const p = await setup(),
      { b } = await p.connect(),
      thread = p.mms.threads.createThread('Mine'),
      other = p.mms.threads.createThread('Theirs'),
      { requestId } = ask(p, thread.id)
    expect(await answer(b, other.id, requestId, { permission: 'allow' })).toEqual({ ok: false })
    expect(await answer(b, thread.id, 'no-such-request', { permission: 'allow' })).toEqual({ ok: false })
    expect(p.mms.runEngine.approvals.get(requestId)!.status).toBe('pending')
    p.mms.questions.settle(requestId, { permission: 'allow' }, { kind: 'user', via: 'gui' })
    // Settled now: the thread check still applies, so the other thread learns nothing about who answered.
    expect(await answer(b, other.id, requestId, { permission: 'allow' })).toEqual({ ok: false })
    expect(await b.rpc('orchestrator.dismissQuestions', { threadId: other.id, requestId }, rpc('dismiss-other'))).toEqual({ ok: false })
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
  /** A phone-side session subscribed to every stream, collecting what arrives in wire order. */
  async function subscribed(
    p: Awaited<ReturnType<typeof setup>>,
    adapter: ThreadStreamAdapter,
    threads: string[]
  ) {
    const descriptors = threads.map((id) => adapter.activate(id))
    for (const descriptor of descriptors) p.bStore.createStream(descriptor, 1)
    const live = await p.connect(adapter.store, true),
      seen: string[] = []
    live.b.onEphemeral((message) => {
      const body = (message as { data?: { threadId?: string; type?: string; data?: unknown } }).data
      seen.push(
        body?.type === 'questions.updated'
          ? `questions:${body.threadId}`
          : `delta:${(body?.data as { message?: { content?: string } })?.message?.content?.slice(0, 3)}`
      )
    })
    for (const descriptor of descriptors)
      await new Promise<void>((resolve, reject) =>
        live.b.subscribe(descriptor.id, {
          onRecord: () => seen.push('record'),
          onCaughtUp: () => resolve(),
          onSnapshotInstalled: () => resolve(),
          onError: (code) => reject(new Error(code))
        })
      )
    seen.length = 0
    return { live, descriptors, seen }
  }
  const multiSource = () => {
    const listeners = new Map<string, (event: ThreadSourceEvent) => void>(),
      source: ThreadSourcePort = {
        snapshot: (id) => ({ thread: { id }, messages: [] }),
        onThread: (id, listener) => {
          listeners.set(id, listener)
          return () => undefined
        }
      }
    return { source, emit: (id: string, event: ThreadSourceEvent) => listeners.get(id)!(event) }
  }

  it('never delivers a streaming delta after the settled record of the same message', async () => {
    const p = await setup(),
      clock = manualClock(),
      { source, emit } = multiSource()
    let session: Awaited<ReturnType<typeof subscribed>>['live']['a'] | undefined
    const adapter = new ThreadStreamAdapter({
      db: p.aDb,
      store: p.aStore,
      generations: p.aStore,
      identity: p.aIdentity,
      keys: p.aKeys,
      clock,
      source,
      onDelta: (stream, body, key) => session!.publishDelta(stream, body, key),
      onDeltaDiscard: (stream, matches) => session!.discardDeltas(stream, matches),
      onRecord: (stream, record) => void session?.publishRecord(stream, record)
    })
    resources.push(() => adapter.close())
    const { live, seen } = await subscribed(p, adapter, ['t1'])
    session = live.a
    const streaming = (content: string) => ({
      type: 'thread.message-updated' as const,
      data: message('m1', content),
      ephemeral: true as const
    })
    // 'Hel' and the questions update wait behind the delta being written when m1 settles.
    emit('t1', streaming('Hxx'))
    clock.flush()
    emit('t1', {
      type: 'questions.updated',
      data: { threadId: 't1', pending: [] },
      ephemeral: true
    })
    emit('t1', streaming('Hel'))
    clock.flush()
    emit('t1', { type: 'thread.message-updated', data: message('m1', 'Hello!', false) })
    emit('t1', {
      type: 'questions.updated',
      data: { threadId: 't1', pending: [] },
      ephemeral: true
    })
    clock.flush()
    await vi.waitFor(() => expect(seen).toContain('record'))
    // Wire order is FIFO, so once a marker queued after the record arrives, no stale delta is left.
    emit('t1', {
      type: 'questions.updated',
      data: { threadId: 't1', pending: [] },
      ephemeral: true
    })
    clock.flush()
    await vi.waitFor(() =>
      expect(seen.lastIndexOf('questions:t1')).toBeGreaterThan(seen.indexOf('record'))
    )
    expect(seen.filter((entry) => entry === 'delta:Hel')).toEqual([])
    expect(seen.indexOf('delta:Hxx')).toBeLessThan(seen.indexOf('record'))
    expect(live.a.state()).toBe('open')
  })

  it('bounds delta bytes per session, not per stream, so many live threads cannot fill the control lane', async () => {
    const p = await setup(),
      clock = manualClock(),
      { source, emit } = multiSource(),
      threads = Array.from({ length: 12 }, (_, i) => `t${i}`)
    let session: Awaited<ReturnType<typeof subscribed>>['live']['a'] | undefined
    const adapter = new ThreadStreamAdapter({
      db: p.aDb,
      store: p.aStore,
      generations: p.aStore,
      identity: p.aIdentity,
      keys: p.aKeys,
      clock,
      source,
      onDelta: (stream, body, key) => session!.publishDelta(stream, body, key)
    })
    resources.push(() => adapter.close())
    const { live, seen } = await subscribed(p, adapter, threads)
    session = live.a
    let writing = 0,
      peak = 0
    const internals = live.a as unknown as { send(message: WireMessage): Promise<void> },
      send = internals.send.bind(live.a)
    internals.send = (message) => {
      if (message.t !== 'ephemeral' || message.kind !== 'delta') return send(message)
      peak = Math.max(peak, ++writing)
      return send(message).finally(() => writing--)
    }
    threads.forEach((id, i) =>
      emit(id, {
        type: 'thread.message-updated',
        data: {
          threadId: id,
          message: { ...message(`m${i}`, `${i}`.padEnd(31 * 1024, 'x')).message }
        },
        ephemeral: true
      })
    )
    clock.flush()
    await vi.waitFor(() => expect(seen).toHaveLength(threads.length))
    expect(peak).toBe(1)
    expect(live.a.state()).toBe('open')
    expect(live.b.state()).toBe('open')
  })

  it('still sends a thread that keeps updating while another one streams, within a few writes', async () => {
    const p = await setup(),
      { source } = multiSource(),
      adapter = new ThreadStreamAdapter({
        db: p.aDb,
        store: p.aStore,
        generations: p.aStore,
        identity: p.aIdentity,
        keys: p.aKeys,
        clock: manualClock(),
        source
      })
    resources.push(() => adapter.close())
    const { live, descriptors } = await subscribed(p, adapter, ['t1', 't2']),
      [first, second] = descriptors.map((descriptor) => descriptor.id),
      sent: string[] = [],
      gates: Array<() => void> = [],
      internals = live.a as unknown as { send(message: WireMessage): Promise<void> },
      send = internals.send.bind(live.a)
    // Every delta write stays open until the test completes it, like a slow phone link.
    internals.send = (message) => {
      if (message.t !== 'ephemeral' || message.kind !== 'delta') return send(message)
      sent.push(message.stream)
      return new Promise<void>((resolve) => gates.push(resolve)).then(() => send(message))
    }
    const publish = (stream: string, n: number) =>
      live.a.publishDelta(
        stream,
        { type: 'thread.message-updated', data: message('m', `${n}`) },
        'message:m'
      )
    publish(first, 0)
    for (let n = 1; n <= 6; n++) {
      // Both threads refresh in the same order before each write completes.
      publish(first, n)
      publish(second, n)
      gates.shift()!()
      await vi.waitFor(() => expect(sent).toHaveLength(n + 1))
    }
    expect(sent.slice(0, 4)).toContain(second)
    gates.splice(0).forEach((open) => open())
    expect(live.a.state()).toBe('open')
  })

  it('drops a delta the mux refuses and keeps both the session and later deltas', async () => {
    const p = await setup(),
      { source, emit } = multiSource()
    let session: Awaited<ReturnType<typeof subscribed>>['live']['a'] | undefined
    const clock = manualClock(),
      adapter = new ThreadStreamAdapter({
        db: p.aDb,
        store: p.aStore,
        generations: p.aStore,
        identity: p.aIdentity,
        keys: p.aKeys,
        clock,
        source,
        onDelta: (stream, body, key) => session!.publishDelta(stream, body, key)
      })
    resources.push(() => adapter.close())
    const { live, seen } = await subscribed(p, adapter, ['t1'])
    session = live.a
    let refused = 0
    const internals = live.a as unknown as { send(message: WireMessage): Promise<void> },
      send = internals.send.bind(live.a)
    internals.send = (message) => {
      if (message.t === 'ephemeral' && message.kind === 'delta' && refused++ === 0)
        return Promise.reject(new NetError('rate_limited'))
      return send(message)
    }
    emit('t1', { type: 'thread.message-updated', data: message('m1', 'one'), ephemeral: true })
    clock.flush()
    await vi.waitFor(() => expect(refused).toBe(1))
    emit('t1', { type: 'thread.message-updated', data: message('m1', 'two'), ephemeral: true })
    clock.flush()
    await vi.waitFor(() => expect(seen).toEqual(['delta:two']))
    expect(live.a.state()).toBe('open')
  })

  it('drops deltas of a stream that is resyncing after a live queue overflow without failing the session', async () => {
    const p = await setup(),
      { source, emit } = multiSource()
    let session: Awaited<ReturnType<typeof subscribed>>['live']['a'] | undefined
    const clock = manualClock(),
      adapter = new ThreadStreamAdapter({
        db: p.aDb,
        store: p.aStore,
        generations: p.aStore,
        identity: p.aIdentity,
        keys: p.aKeys,
        clock,
        source,
        onDelta: (stream, body, key) => session!.publishDelta(stream, body, key)
      })
    resources.push(() => adapter.close())
    const { live, descriptors, seen } = await subscribed(p, adapter, ['t1', 't2'])
    session = live.a
    const sent: string[] = [],
      internals = live.a as unknown as {
        send(message: WireMessage): Promise<void>
        sendRecords(): Promise<void>
      },
      send = internals.send.bind(live.a)
    let refused = 0
    internals.send = (message) => {
      sent.push(message.t)
      // The control lane is full for the first delta only; the resync request must still go out.
      if (message.t === 'ephemeral' && message.kind === 'delta' && refused++ === 0)
        return Promise.reject(new NetError('rate_limited'))
      return send(message)
    }
    // A stalled link: the first record never completes, so later ones queue behind it.
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(internals, 'sendRecords').mockImplementationOnce(() => stalled)
    resources.push(() => release())
    emit('t1', { type: 'thread.message-updated', data: message('m1', 'one'), ephemeral: true })
    clock.flush()
    await vi.waitFor(() => expect(refused).toBe(1))
    const body = new Uint8Array(8 * 1024 * 1024),
      record = (seq: number) => ({
        epoch: 1,
        seq,
        recvTs: Date.now(),
        envelope: body,
        sig: new Uint8Array(64)
      })
    // Seven 8 MiB records fit under the 64 MiB cap and the eighth overflows into a resync.
    const queued = Array.from({ length: 7 }, (_, i) =>
      live.a.publishRecord(descriptors[0].id, record(i + 1))
    )
    await live.a.publishRecord(descriptors[0].id, record(8))
    expect(sent).toContain('snapshotRequired')
    // The stream no longer serves live, so its deltas are dropped; other streams are unaffected.
    emit('t1', { type: 'thread.message-updated', data: message('m1', 'stale'), ephemeral: true })
    emit('t2', { type: 'thread.message-updated', data: message('m2', 'two'), ephemeral: true })
    clock.flush()
    await vi.waitFor(() => expect(seen).toContain('delta:two'))
    expect(seen).not.toContain('delta:sta')
    release()
    await Promise.allSettled(queued)
    expect(live.a.state()).toBe('open')
    expect(live.b.state()).toBe('open')
  })
})
