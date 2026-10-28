/**
 * Each computer that works on this computer's threads reads through streams of its own: a thread
 * stream, a lists stream, a channel stream and a stream per terminal. No one else reads them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MmsListsSource,
  type ListsServices
} from '../../../../src/mms/bridge/remote/MmsListsSource'
import { MmsThreadSource } from '../../../../src/mms/bridge/remote/MmsThreadSource'
import {
  PRIVATE_STREAM_QUOTA,
  PRIVATE_THREAD_STREAMS_TOTAL,
  isPrivateKey,
  parsePrivateKey,
  privateKey
} from '../../../../src/mms/bridge/remote/privateStreams'
import {
  ThreadStreamAdapter,
  type ThreadSourceEvent
} from '../../../../src/mms/bridge/remote/ThreadStreamAdapter'
import { systemClock } from '../../../../src/mms/net/clock'
import type { RoutedStreamOpened } from '../../../../src/shared/bridge/routed'
import { newId, type NodeId } from '../../../../src/shared/net'
import { cleanup, resources } from '../hub/fixture'
import { readStream, recordsOf, routedOwner, testClock } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const MIB = 1024 * 1024
const message = (index: number, content: string) => ({
  id: `m-${index}`,
  role: index % 2 ? ('assistant' as const) : ('user' as const),
  content,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
})
const approval = (threadId: string, requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  threadId,
  instanceId: 'i',
  provider: 'claude',
  action: 'command' as const,
  permissionKey: 'claude:command',
  fingerprint: requestId.padEnd(64, 'f'),
  permissionMode: 'full' as const,
  questions: [
    {
      id: 'permission',
      prompt: 'Run it?',
      options: [
        { id: 'allow', label: 'Allow once', decision: 'allow' as const, scope: 'once' as const },
        {
          id: 'allow_always',
          label: 'Always',
          decision: 'allow' as const,
          scope: 'always' as const
        },
        { id: 'reject', label: 'Reject', decision: 'reject' as const }
      ]
    }
  ],
  ...extra
})

describe('opening a private stream', () => {
  it('gives a thread stream that carries the thread and is bound to the computer that opened it', async () => {
    const { ok, thread, f, adapter } = await routedOwner({ streams: true })
    const t = thread('Mine')
    f.mms.orchestrator.getOrCreateSession(t.id).messages = [
      message(0, 'hello'),
      message(1, 'hi')
    ] as never

    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    expect(opened).toMatchObject({
      kind: 'thread',
      subject: t.id,
      descriptor: { kind: 'node.thread', authority: f.targetNode },
      head: { epoch: expect.any(Number), seq: expect.any(Number) }
    })
    const stream = (opened.descriptor as { id: never }).id
    const { snapshot } = readStream(f, stream, t.id)
    expect(snapshot.thread.id).toBe(t.id)
    expect(snapshot.messages.map((m: { content: string }) => m.content)).toEqual(['hello', 'hi'])

    // The stream is this computer's: the display adapter says so, and it is not the shared stream a phone reads.
    expect(adapter!.privateAccess(stream)).toEqual({
      reader: f.callerNode,
      kind: 'thread',
      open: true
    })
    const shared = adapter!.activate(t.id)
    expect(shared.id).not.toBe(stream)
    expect(adapter!.privateAccess(shared.id)).toBeUndefined()
    // Another computer gets a stream of its own for the same thread; the same computer gets the same one back.
    const other = newId('node')
    const theirs = adapter!.openPrivate({ reader: other, kind: 'thread', subject: t.id })
    expect(theirs.id).not.toBe(stream)
    expect(adapter!.privateAccess(theirs.id)).toEqual({ reader: other, kind: 'thread', open: true })
    const again = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    expect((again.descriptor as { id: string }).id).toBe(stream)
  }, 60_000)

  it('is refused to a device without Works on threads, like every routed method', async () => {
    const { f } = await routedOwner({
      caps: ['read', 'chat', 'write'],
      streams: true,
      staging: {}
    })
    const attempt = (method: string, params: unknown) =>
      f.caller().rpc(`routed.${method}`, params, {
        id: newId('rpc'),
        ...(method === 'stage' ? { idem: 'stage-attempt' } : {}),
        deadlineMs: 10_000
      })
    await expect(attempt('stream.open', { kind: 'lists' })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(attempt('page', { id: 'x', index: 0 })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(
      attempt('stage', {
        input: {
          stream: newId('stream'),
          event: newId('event'),
          blob: `blb_${'a'.repeat(64)}`
        }
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
  }, 60_000)

  it('keeps no one from the shared stream through the private ones: a phone cannot ask for a private key', async () => {
    const { thread, adapter } = await routedOwner({ streams: true })
    const t = thread()
    const key = privateKey({ reader: newId('node'), kind: 'thread', subject: t.id })
    expect(isPrivateKey(key)).toBe(true)
    expect(parsePrivateKey(key)).toMatchObject({ kind: 'thread', subject: t.id })
    // `bridge.thread.open` reaches `activate`; a key that names another computer's stream is refused.
    expect(() => adapter!.activate(key)).toThrow(expect.objectContaining({ code: 'bad_request' }))
    // And what is not a key is not parsed as one.
    for (const bad of [
      'private:',
      'private:nod_x:thread:t',
      `private:${newId('node')}:nothing:t`,
      t.id
    ])
      expect(parsePrivateKey(bad), bad).toBeUndefined()
  }, 60_000)

  it('refuses what a stream does not take, a thread that is not here, and a terminal that is not allowed', async () => {
    const { call, ok, thread, f, policy, routes } = await routedOwner({ streams: true })
    const t = thread()
    const other = thread('Other')
    // Exactly the keys a kind takes.
    await expect(call('stream.open', { kind: 'thread' })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(call('stream.open', { kind: 'lists', threadId: t.id })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(call('stream.open', { kind: 'channel', ptyId: 'p' })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(call('stream.open', { kind: 'bogus' })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(call('stream.open', { kind: 'lists', extra: 1 })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(call('stream.open', {})).rejects.toMatchObject({ code: 'bad_request' })
    expect(await call('stream.open', { kind: 'thread', threadId: 'not-a-thread' })).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' }
    })

    // Terminal output is for a device whose terminal switch is on, and for a terminal of that thread.
    await expect(
      call('stream.open', { kind: 'terminal', threadId: t.id, ptyId: 'pty-1' })
    ).rejects.toMatchObject({ code: 'forbidden' })
    policy.set(f.callerNode, { terminal: true })
    const lookup = vi.spyOn(f.mms.ptyManager, 'lookup')
    lookup.mockReturnValue({
      alive: true,
      ptyId: 'pty-1',
      agentId: 'a',
      threadId: other.id,
      sequence: 0
    })
    expect(
      await call('stream.open', { kind: 'terminal', threadId: t.id, ptyId: 'pty-1' })
    ).toMatchObject({
      ok: false,
      error: { code: 'pty_not_found' }
    })
    lookup.mockReturnValue({ alive: false, ptyId: 'pty-1' })
    expect(
      await call('stream.open', { kind: 'terminal', threadId: t.id, ptyId: 'pty-1' })
    ).toMatchObject({
      ok: false,
      error: { code: 'pty_not_found' }
    })
    lookup.mockReturnValue({
      alive: true,
      ptyId: 'pty-1',
      agentId: 'a',
      threadId: t.id,
      sequence: 0
    })
    // A terminal of this thread that another computer (or the owner's window) opened is not this device's to read.
    expect(
      await call('stream.open', { kind: 'terminal', threadId: t.id, ptyId: 'pty-1' })
    ).toMatchObject({ ok: false, error: { code: 'pty_not_found' } })
    const claim = routes.terminals.claim(f.callerNode, t.id, 'a')
    claim.created('pty-1')
    claim.finish()
    const opened = (await ok('stream.open', {
      kind: 'terminal',
      threadId: t.id,
      ptyId: 'pty-1'
    })) as RoutedStreamOpened
    expect(opened).toMatchObject({ kind: 'terminal', subject: 'mousse:pty:pty-1' })
  }, 60_000)

  it('stays inside the quotas: 16 threads for one computer, 32 in all, one lists, one channel, 4 terminals', async () => {
    const { thread, adapter } = await routedOwner({ streams: true })
    const threads = Array.from({ length: PRIVATE_STREAM_QUOTA.thread + 1 }, (_, i) =>
      thread(`T${i}`)
    )
    const reader = (): NodeId => newId('node')
    const [a, b, c] = [reader(), reader(), reader()]
    for (const t of threads.slice(0, 16))
      adapter!.openPrivate({ reader: a, kind: 'thread', subject: t.id })
    // The 17th for the same computer is refused; another computer is not held back by it.
    expect(() =>
      adapter!.openPrivate({ reader: a, kind: 'thread', subject: threads[16].id })
    ).toThrow(expect.objectContaining({ code: 'rate_limited' }))
    for (const t of threads.slice(0, 16))
      adapter!.openPrivate({ reader: b, kind: 'thread', subject: t.id })
    // Asking again for a stream that is open is not a new stream.
    expect(() =>
      adapter!.openPrivate({ reader: a, kind: 'thread', subject: threads[0].id })
    ).not.toThrow()
    // 32 thread streams are open in all (16 each for two computers): a third computer has to wait.
    expect(PRIVATE_THREAD_STREAMS_TOTAL).toBe(32)
    expect(() =>
      adapter!.openPrivate({ reader: c, kind: 'thread', subject: threads[0].id })
    ).toThrow(expect.objectContaining({ code: 'rate_limited' }))
    // Lists and channel: one each, and they do not count as thread streams.
    expect(() => adapter!.openPrivate({ reader: c, kind: 'lists', subject: '' })).not.toThrow()
    expect(() => adapter!.openPrivate({ reader: c, kind: 'channel', subject: '' })).not.toThrow()
    // Terminals: four per computer.
    const pty = (n: number) => `${threads[0].id}:pty-${n}`
    for (let n = 0; n < PRIVATE_STREAM_QUOTA.terminal; n += 1)
      adapter!.openPrivate({ reader: c, kind: 'terminal', subject: pty(n) })
    expect(() => adapter!.openPrivate({ reader: c, kind: 'terminal', subject: pty(9) })).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )
  }, 120_000)

  it('releases a private stream that no one reads and nothing runs on, makes room with it, and reopens it on demand', async () => {
    const clock = testClock()
    const { thread, adapter, f } = await routedOwner({ streams: { idleMs: 10 * 60_000 }, clock })
    const threads = Array.from({ length: 17 }, (_, i) => thread(`T${i}`))
    const reader = newId('node')
    const first = adapter!.openPrivate({ reader, kind: 'thread', subject: threads[0].id })
    for (const t of threads.slice(1, 16))
      adapter!.openPrivate({ reader, kind: 'thread', subject: t.id })
    expect(() => adapter!.openPrivate({ reader, kind: 'thread', subject: threads[16].id })).toThrow(
      expect.objectContaining({ code: 'rate_limited' })
    )

    // Ten idle minutes later the quota gives way to a new stream, and the old one keeps its identity.
    clock.advance(10 * 60_000 + 1)
    expect(() =>
      adapter!.openPrivate({ reader, kind: 'thread', subject: threads[16].id })
    ).not.toThrow()
    expect(adapter!.privateAccess(first.id)).toEqual({ reader, kind: 'thread', open: false })
    expect(adapter!.privateHead(reader, threads[0].id)).toBeUndefined()
    const reopened = adapter!.openPrivate({ reader, kind: 'thread', subject: threads[0].id })
    expect(reopened.id).toBe(first.id)
    // The reopened stream has the thread's state, not what was there before it was released.
    f.mms.orchestrator.getOrCreateSession(threads[0].id).messages = [message(0, 'later')] as never
    const readerSide = readStream(f, reopened.id, threads[0].id)
    expect(readerSide.snapshot.thread.id).toBe(threads[0].id)
  }, 120_000)

  it('does not reopen a closed private stream because someone looked it up, and opens it only on request', async () => {
    const { thread, adapter, f, ok } = await routedOwner({ streams: true })
    const t = thread()
    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    const id = (opened.descriptor as { id: never }).id
    const before = f.targetStore.head(id)
    adapter!.closePrivate({ reader: f.callerNode })
    expect(adapter!.privateHead(f.callerNode, t.id)).toBeUndefined()

    // Any lookup of the stored stream (the network layer makes one for every read it checks) leaves it closed.
    for (let n = 0; n < 3; n += 1) expect(adapter!.store.getStream(id)?.id).toBe(id)
    expect(adapter!.privateHead(f.callerNode, t.id)).toBeUndefined()
    expect(f.targetStore.head(id)).toEqual(before)
    // A closed stream is known as the computer's but is not open: nothing reads it.
    expect(adapter!.privateAccess(id)).toEqual({
      reader: f.callerNode,
      kind: 'thread',
      open: false
    })

    // The computer asks to open it, through the request that runs the owner's checks, and it is open again.
    const again = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    expect((again.descriptor as { id: string }).id).toBe(id)
    expect(adapter!.privateAccess(id)).toMatchObject({ open: true })
    // A shared stream is still reopened by a lookup, as phones and hubs rely on.
    const shared = adapter!.activate(t.id)
    adapter!.deactivate(t.id)
    expect(adapter!.privateAccess(shared.id)).toBeUndefined()
    adapter!.store.getStream(shared.id)
    expect(adapter!.ringStats(shared.id)).toBeDefined()
  }, 60_000)

  it('does not use the cap that phones and hubs share, so a full set of private streams leaves them room', async () => {
    const { thread, adapter } = await routedOwner({ streams: { maxThreads: 2 } })
    const threads = Array.from({ length: 6 }, (_, i) => thread(`T${i}`))
    const warnings: string[] = []
    const onWarning = (warning: Error) => warnings.push(warning.name)
    process.on('warning', onWarning)
    try {
      // Two shared streams fill the shared cap; private streams are counted apart from it.
      adapter!.activate(threads[0].id)
      adapter!.activate(threads[1].id)
      expect(() => adapter!.activate(threads[2].id)).toThrow(
        expect.objectContaining({ code: 'rate_limited' })
      )
      const readers = [newId('node'), newId('node'), newId('node')]
      for (const reader of readers)
        for (const t of threads) adapter!.openPrivate({ reader, kind: 'thread', subject: t.id })
      expect(adapter!.privateReaders()).toHaveLength(3)
      expect(() => adapter!.activate(threads[2].id)).toThrow(
        expect.objectContaining({ code: 'rate_limited' })
      )
      // Many streams listen to the same services without the "too many listeners" warning.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', onWarning)
    }
    expect(warnings).not.toContain('MaxListenersExceededWarning')
  }, 60_000)

  it('opens a thread stream on a subagent thread like any other', async () => {
    const { ok, thread, f } = await routedOwner({ streams: true })
    const parent = thread('Parent')
    const child = f.mms.threads.createThread('Child', undefined, undefined, {
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' }
    })
    f.mms.orchestrator.getOrCreateSession(child.id).messages = [
      message(0, 'from the child')
    ] as never
    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: child.id
    })) as RoutedStreamOpened
    const { snapshot } = readStream(f, (opened.descriptor as { id: never }).id, child.id)
    expect(snapshot.thread).toMatchObject({ id: child.id, lineage: { parentThreadId: parent.id } })
    expect(snapshot.messages.map((m: { content: string }) => m.content)).toEqual(['from the child'])
  }, 60_000)

  it('tells a snapshot where the stream was before it read the thread, so no record is marked applied that it lacks', async () => {
    const { ok, thread, f } = await routedOwner({ streams: true })
    const t = thread()
    f.mms.orchestrator.getOrCreateSession(t.id).messages = [message(0, 'before')] as never
    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    const stream = (opened.descriptor as { id: never }).id
    const at = f.targetStore.head(stream)
    // A record lands on the stream while the snapshot is being read.
    const read = f.mms.orchestrator.getMessages.bind(f.mms.orchestrator)
    vi.spyOn(f.mms.orchestrator, 'getMessages').mockImplementation((threadId?: string) => {
      const messages = read(threadId)
      f.mms.orchestrator.emit('thread-messages', { threadId: t.id, messages })
      return messages
    })
    const snapshot = await ok('thread.snapshot', { threadId: t.id })
    const now = f.targetStore.head(stream)
    expect(now.seq).toBeGreaterThan(at.seq)
    expect(snapshot.streamHead).toEqual({ stream, epoch: at.epoch, seq: at.seq })
  }, 60_000)

  it('keeps a thread stream open while a turn runs on the thread, and not the other kinds', async () => {
    const clock = testClock()
    const { thread, adapter, f } = await routedOwner({ streams: { idleMs: 60_000 }, clock })
    const t = thread()
    const reader = newId('node')
    const running = vi.spyOn(f.mms.orchestrator, 'isTurnActive').mockReturnValue(true)
    const threadStream = adapter!.openPrivate({ reader, kind: 'thread', subject: t.id })
    const lists = adapter!.openPrivate({ reader, kind: 'lists', subject: '' })
    clock.advance(61_000)
    expect(adapter!.releaseIdle()).toBe(1)
    expect(adapter!.privateHead(reader, t.id)).toMatchObject({ stream: threadStream.id })
    expect(adapter!.privateAccess(lists.id)).toEqual({ reader, kind: 'lists', open: false })
    running.mockReturnValue(false)
    clock.advance(61_000)
    expect(adapter!.releaseIdle()).toBe(1)
    expect(adapter!.privateHead(reader, t.id)).toBeUndefined()
  }, 60_000)
})

describe('what a private stream carries', () => {
  it('offers "Always for this thread" on a card where the device may make the rule, and a phone never sees it', async () => {
    const { f, thread } = await routedOwner()
    const t = thread()
    f.mms.runEngine.approvals.create(approval(t.id, 'r-1') as never)
    f.mms.runEngine.approvals.create(
      approval(t.id, 'r-reserved', {
        fingerprint: 'e'.repeat(64),
        reason: 'Claude Code keeps this for a person'
      }) as never
    )
    const optionIds = (
      pending: Array<{ requestId: string; questions: Array<{ options?: Array<{ id: string }> }> }>
    ) =>
      Object.fromEntries(
        pending.map((entry) => [entry.requestId, entry.questions[0].options!.map((o) => o.id)])
      )

    const questions = f.mms.questions
    const pending = (source: MmsThreadSource) => {
      const seen: ThreadSourceEvent[] = []
      const stop = source.onThread(t.id, (event) => seen.push(event))
      questions.emit('pending', { requestId: 'r-1', threadId: t.id, questions: [] })
      stop()
      const delta = seen.find((event) => 'type' in event && event.type === 'questions.updated') as {
        data: { pending: Parameters<typeof optionIds>[0] }
      }
      return optionIds(delta.data.pending)
    }
    const allOptions = ['allow', 'allow_always', 'reject']
    const withoutAlways = ['allow', 'reject']
    // A phone has no "Always": it cannot list or revoke rules.
    expect(pending(new MmsThreadSource(f.mms))).toEqual({
      'r-1': withoutAlways,
      'r-reserved': withoutAlways
    })
    // A computer whose limit lets a command run without asking is offered it, except where the provider keeps the request for a person.
    expect(
      pending(new MmsThreadSource(f.mms, undefined, { private: { limit: () => 'full' } }))
    ).toEqual({
      'r-1': allOptions,
      'r-reserved': withoutAlways
    })
    // A computer limited to Auto-accept edits would be asked before a command, so it cannot make a rule for one.
    expect(
      pending(new MmsThreadSource(f.mms, undefined, { private: { limit: () => 'accept_edits' } }))
    ).toEqual({ 'r-1': withoutAlways, 'r-reserved': withoutAlways })
  }, 60_000)

  it('shows the same card in the question list a routed read returns, with the device limit applied', async () => {
    for (const [limit, expected] of [
      ['full', ['allow', 'allow_always', 'reject']],
      ['accept_edits', ['allow', 'reject']]
    ] as const) {
      const owner = await routedOwner({ maxMode: limit, streams: true })
      const t = owner.thread()
      owner.f.mms.runEngine.approvals.create(approval(t.id, 'r-1') as never)
      const ids = (pending: Array<{ questions: Array<{ options: Array<{ id: string }> }> }>) =>
        pending[0].questions[0].options.map((option) => option.id)
      // The list a routed read returns, the snapshot of a routed read, and the snapshot a thread stream starts with.
      expect(
        ids((await owner.ok('orchestrator.pendingQuestions', { threadId: t.id })).pending),
        limit
      ).toEqual(expected)
      expect(
        ids((await owner.ok('thread.snapshot', { threadId: t.id })).pendingQuestions),
        limit
      ).toEqual(expected)
      const opened = (await owner.ok('stream.open', {
        kind: 'thread',
        threadId: t.id
      })) as RoutedStreamOpened
      const attached = readStream(owner.f, (opened.descriptor as { id: never }).id, t.id).snapshot
      expect(ids(attached.pendingQuestions), limit).toEqual(expected)
      await cleanup()
    }
  }, 120_000)

  it('has the subagent rows and lineage in its lists stream, which the shared lists leave out', async () => {
    const { ok, thread, f, policy } = await routedOwner({ streams: true, maxMode: 'accept_edits' })
    const parent = thread('Parent')
    const child = f.mms.threads.createThread('Child', undefined, undefined, {
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' },
      permissionMode: 'ask'
    })
    void policy
    const opened = (await ok('stream.open', { kind: 'lists' })) as RoutedStreamOpened
    expect(opened).toMatchObject({ kind: 'lists', subject: 'mousse:lists' })
    const own = readStream(f, (opened.descriptor as { id: never }).id, 'mousse:lists').snapshot
    const ids = own.threads.map((row: { id: string }) => row.id)
    expect(ids).toEqual(expect.arrayContaining([parent.id, child.id]))
    const row = own.threads.find((entry: { id: string }) => entry.id === child.id)
    expect(row).toMatchObject({
      lineage: { parentThreadId: parent.id, relationship: 'subagent' },
      permissionMode: 'ask'
    })

    // A phone's lists, from the same services, list the parent only and carry no lineage.
    const shared = new MmsListsSource(f.mms as unknown as ListsServices).snapshot()
    expect(shared.threads.map((entry) => entry.id)).toContain(parent.id)
    expect(shared.threads.map((entry) => entry.id)).not.toContain(child.id)
    for (const entry of shared.threads) expect(entry).not.toHaveProperty('lineage')
  }, 60_000)

  it('reports every state a row shows, including Waiting and Paused, and where a thread came from', async () => {
    const { thread, f } = await routedOwner()
    const a = thread('Asking'),
      b = thread('Waiting'),
      c = thread('Paused'),
      d = thread('Sent')
    f.mms.threads.updateThreadMeta(d.id, { sentFrom: { node: f.callerNode } } as never, {
      touch: false
    })
    f.mms.threadRuntimes.setActivity(a.id, 'awaiting_input')
    f.mms.threadRuntimes.setActivity(b.id, 'waiting')
    f.mms.threadRuntimes.setActivity(c.id, 'paused')
    const own = new MmsListsSource(f.mms as unknown as ListsServices, undefined, {
      private: true
    }).snapshot()
    expect(own.status[a.id]).toMatchObject({ state: 'awaiting_input' })
    expect(own.status[b.id]).toMatchObject({ state: 'waiting' })
    expect(own.status[c.id]).toMatchObject({ state: 'paused' })
    expect(own.threads.find((row) => row.id === d.id)).toMatchObject({
      sentFrom: { node: f.callerNode }
    })
    // A phone has no such states.
    const shared = new MmsListsSource(f.mms as unknown as ListsServices).snapshot()
    expect(shared.status[b.id]).toBeUndefined()
    expect(shared.status[c.id]).toBeUndefined()
  }, 60_000)

  it('sends the notes a window would hear about a thread as display-only deltas, to a private stream only', async () => {
    const { f, thread } = await routedOwner()
    const t = thread()
    const private_ = new MmsThreadSource(f.mms, undefined, { private: { limit: () => 'full' } })
    const shared = new MmsThreadSource(f.mms)
    const heard = (source: MmsThreadSource) => {
      const seen: Array<{ type: string; data: unknown }> = []
      const stop = source.onThread(t.id, (event) => {
        if ('type' in event) seen.push({ type: event.type, data: event.data })
      })
      f.mms.threadRuntimes.emit('agents.updated', { threadId: t.id, agents: [{ id: 'a1' }] })
      f.mms.threadRuntimes.emit('tasks.updated', { threadId: t.id, tasks: [] })
      f.mms.pullRequestWatch.emit('updated', { threadId: t.id })
      f.mms.orchestrator.emit('thread-title-generation-failed', {
        threadId: t.id,
        error: 'no model'
      })
      // A save or an Undo, raised through the protocol server for this thread; another thread's is not heard.
      f.mms.events.broadcast('thread:event', {
        type: 'actions.updated',
        data: { threadId: t.id, action: { id: 'act-1' } },
        threadId: t.id
      })
      f.mms.events.broadcast('thread:event', {
        type: 'actions.updated',
        data: { threadId: 'other' },
        threadId: 'other'
      })
      stop()
      return seen.map((entry) => entry.type)
    }
    expect(heard(private_)).toEqual(
      expect.arrayContaining([
        'agents.updated',
        'tasks.updated',
        'pullRequests.updated',
        'thread.title-generation-failed',
        'actions.updated'
      ])
    )
    expect(heard(private_).filter((type) => type === 'actions.updated')).toHaveLength(1)
    // A phone's stream carries none of them.
    expect(heard(shared)).toEqual([])
  }, 60_000)

  it('coalesces the notes per kind and per action, says that something changed when a note is too large, and refuses them on a phone’s stream', async () => {
    const { thread, f } = await routedOwner()
    const t = thread()
    const deltas: Array<{ body: any; key: string }> = []
    const errors: unknown[] = []
    const emitters = new Map<string, (event: ThreadSourceEvent) => void>()
    const adapter = new ThreadStreamAdapter({
      db: f.targetDb,
      store: f.targetStore,
      generations: f.targetStore,
      identity: f.targetIdentity,
      keys: f.targetKeys,
      clock: systemClock,
      deltaIntervalMs: 1,
      source: {
        snapshot: () => ({ kind: 'fake' }),
        onThread: (key, listener) => {
          emitters.set(key, listener)
          return () => emitters.delete(key)
        }
      },
      onDelta: (_stream, body, key) => deltas.push({ body, key }),
      onError: (_thread, error) => errors.push(error)
    })
    resources.push(() => adapter.close())
    const reader = newId('node')
    const spec = { reader, kind: 'thread' as const, subject: t.id }
    adapter.openPrivate(spec)
    const emit = emitters.get(privateKey(spec))!
    const note = (type: string, data: unknown) =>
      emit({ type, data, ephemeral: true } as ThreadSourceEvent)
    note('subagents.updated', { parentThreadId: 'p1' })
    note('subagents.updated', { parentThreadId: 'p2' })
    note('subagents.updated', { parentThreadId: 'p1' })
    note('actions.updated', { threadId: t.id, action: { id: 'a1' } })
    note('actions.updated', { threadId: t.id, action: { id: 'a2' } })
    note('actions.updated', { threadId: t.id, action: { id: 'a1', state: 'later' } })
    note('agents.updated', { threadId: t.id, agents: ['x'.repeat(40 * 1024)] })
    await vi.waitFor(() => expect(deltas.length).toBe(5))
    expect(deltas.map((delta) => delta.key).sort()).toEqual([
      'actions.updated:a1',
      'actions.updated:a2',
      'agents.updated:',
      'subagents.updated:p1',
      'subagents.updated:p2'
    ])
    const byKey = Object.fromEntries(deltas.map((delta) => [delta.key, delta.body]))
    // The newest note of a kind wins; every body names the stream's subject.
    expect(byKey['actions.updated:a1']).toEqual({
      threadId: t.id,
      type: 'actions.updated',
      data: { threadId: t.id, action: { id: 'a1', state: 'later' } }
    })
    // Too large to send whole: it says that the agents changed, and the reader fetches them.
    expect(byKey['agents.updated:']).toEqual({
      threadId: t.id,
      type: 'agents.updated',
      data: { omitted: true, threadId: t.id }
    })
    expect(errors).toEqual([])

    // The stream a phone reads takes none of these: it is a bad event there, which ends that stream.
    adapter.activate('plain-thread')
    emitters.get('plain-thread')!({
      type: 'subagents.updated',
      data: { parentThreadId: 'p1' },
      ephemeral: true
    } as ThreadSourceEvent)
    expect(errors).toEqual([expect.objectContaining({ code: 'bad_request' })])
    // Nor may it carry a terminal's output or a Git action's progress as a record.
    errors.length = 0
    adapter.activate('plain-two')
    emitters.get('plain-two')!({ type: 'pty.data', data: {} } as ThreadSourceEvent)
    expect(errors).toEqual([expect.objectContaining({ code: 'bad_request' })])
  }, 60_000)
})

describe('the channel and terminal streams', () => {
  it('carries a Git action’s progress to the computer that started it and to no other', async () => {
    const { ok, adapter, f } = await routedOwner({ streams: true })
    const opened = (await ok('stream.open', { kind: 'channel' })) as RoutedStreamOpened
    const stream = (opened.descriptor as { id: never }).id
    const event = { event: { kind: 'push', phase: 'progress', percent: 40 } }
    expect(adapter!.pushChannel(f.callerNode, 'git.operation', event)).toBe(true)
    expect(adapter!.pushChannel(f.callerNode, 'git.operation', { event: { percent: 100 } })).toBe(
      true
    )
    // A computer that holds no channel stream is not told: progress is for a window that is watching.
    expect(adapter!.pushChannel(newId('node'), 'git.operation', event)).toBe(false)
    const { snapshot, events } = readStream(f, stream, 'mousse:channel')
    expect(snapshot).toMatchObject({ kind: 'mousse.channel' })
    expect(events).toEqual([
      { type: 'git.operation', data: event },
      { type: 'git.operation', data: { event: { percent: 100 } } }
    ])
  }, 60_000)

  it('keeps a terminal’s output in order and whole, one record per chunk, never merged', async () => {
    const { ok, thread, policy, f, routes } = await routedOwner({ streams: true })
    const t = thread()
    policy.set(f.callerNode, { terminal: true })
    const claim = routes.terminals.claim(f.callerNode, t.id, 'a')
    claim.created('pty-1')
    claim.finish()
    vi.spyOn(f.mms.ptyManager, 'lookup').mockReturnValue({
      alive: true,
      ptyId: 'pty-1',
      agentId: 'a',
      threadId: t.id,
      sequence: 0
    })
    vi.spyOn(f.mms.ptyManager, 'getScrollback').mockReturnValue('$ ')
    const opened = (await ok('stream.open', {
      kind: 'terminal',
      threadId: t.id,
      ptyId: 'pty-1'
    })) as RoutedStreamOpened
    const stream = (opened.descriptor as { id: never }).id
    const emit = (ptyId: string, sequence: number, data: string) =>
      f.mms.ptyManager.emit('data', { ptyId, data, sequence, threadId: t.id, agentId: 'a' })
    // Many small chunks, one large one that is cut into pieces, and another terminal's output that is not ours.
    for (let n = 1; n <= 200; n += 1) emit('pty-1', n, `chunk ${n}\n`)
    const big = 'é'.repeat(40 * 1024)
    emit('pty-1', 201, big)
    emit('pty-other', 1, 'someone else')
    f.mms.ptyManager.emit('exit', {
      ptyId: 'pty-1',
      agentId: 'a',
      threadId: t.id,
      exitCode: 0,
      signal: null
    })

    const { snapshot, events } = readStream(f, stream, 'mousse:pty:pty-1')
    expect(snapshot).toMatchObject({
      kind: 'mousse.terminal',
      ptyId: 'pty-1',
      alive: true,
      scrollback: '$ '
    })
    const data = events.filter((e) => e.type === 'pty.data')
    // Every small chunk is its own record, in order.
    expect(data.slice(0, 200).map((e) => e.data.sequence)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1)
    )
    expect(data.slice(0, 200).map((e) => e.data.data)).toEqual(
      Array.from({ length: 200 }, (_, i) => `chunk ${i + 1}\n`)
    )
    // The large one is in pieces that put back together exactly.
    const pieces = data.slice(200)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((e) => e.data.sequence === 201 && e.data.parts === pieces.length)).toBe(
      true
    )
    expect(pieces.map((e) => e.data.data).join('')).toBe(big)
    expect(events.at(-1)).toMatchObject({ type: 'pty.exit', data: { ptyId: 'pty-1', exitCode: 0 } })
    expect(events.some((e) => JSON.stringify(e.data).includes('someone else'))).toBe(false)
  }, 120_000)

  it('keeps terminal output and Git progress off the thread stream', async () => {
    const { ok, thread, f } = await routedOwner({ streams: true })
    const t = thread()
    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    const stream = (opened.descriptor as { id: never }).id
    f.mms.ptyManager.emit('data', {
      ptyId: 'pty-1',
      data: 'secret output',
      sequence: 1,
      threadId: t.id,
      agentId: 'a'
    })
    const { events } = readStream(f, stream, t.id)
    expect(events.map((e) => e.type)).not.toContain('pty.data')
    expect(
      recordsOf(f, stream)
        .map((r) => JSON.stringify(r.body))
        .join('')
    ).not.toContain('secret output')
  }, 60_000)
})

describe('a long thread on a private stream', () => {
  it('attaches with the newest 16 MiB of 40 MiB and says where the older messages begin', async () => {
    const { ok, thread, f } = await routedOwner({ streams: true })
    const t = thread()
    const all = Array.from({ length: 80 }, (_, index) =>
      message(index, `${index}:`.padEnd(512 * 1024, 'x'))
    )
    f.mms.orchestrator.getOrCreateSession(t.id).messages = all as never

    const opened = (await ok('stream.open', {
      kind: 'thread',
      threadId: t.id
    })) as RoutedStreamOpened
    const { snapshot } = readStream(f, (opened.descriptor as { id: never }).id, t.id)
    const newest = snapshot.messages as Array<{ id: string }>
    expect(newest.at(-1)!.id).toBe('m-79')
    expect(Buffer.byteLength(JSON.stringify(newest))).toBeLessThanOrEqual(16 * MIB)
    expect(newest.length).toBeGreaterThan(20)
    expect(snapshot.earlier).toEqual({ before: newest[0].id, count: 80 - newest.length })
  }, 180_000)
})
