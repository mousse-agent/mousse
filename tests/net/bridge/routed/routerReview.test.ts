/**
 * Corners of the router found in review: what a window is told after an answer that did not come from
 * the live stream, version skew, leases that end with a window's binding, ids in odd places, and the
 * events a CLI is not given.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AttachedThreads } from '../../../../src/mms/bridge/routed/attachedThreads'
import { RoutedClient } from '../../../../src/mms/bridge/routed/RoutedClient'
import { MmsProtocolServer } from '../../../../src/mms/protocol/server'
import {
  outgoingMessageText,
  qualifyRoutedResult,
  unqualifyRoutedParams
} from '../../../../src/shared/bridge/routedIds'
import { NetError, newId, type NodeId } from '../../../../src/shared/net'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

type Loose = Record<string, any>
const snapshot = (
  threadId: string,
  extra: Loose = {}
): Loose => ({
  thread: { id: threadId, name: 'T' },
  messages: [],
  queue: [],
  pendingQuestions: [],
  activeTurn: { active: false, running: false },
  ...extra
})

describe('a window is told what the live stream knows, once it arrives', () => {
  let t: Awaited<ReturnType<typeof linked>>
  let inside: Loose
  beforeAll(async () => {
    t = await linked()
    inside = t.router.attached as unknown as Loose
  }, 120_000)

  const focus = (threadId: string) => inside.leases.set('window', new Set([inside.key(t.node, threadId)]))
  const types = (from: number, id: string) =>
    t.events.slice(from).filter((event) => event.threadId === id).map((event) => event.type)

  it('puts a window right after a whole read: prompts that went away are cleared and the turn ends', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const attachment = inside.obtain(t.node, thread.id)
    // The window was answered by a whole routed read that showed a prompt and a running turn.
    attachment.served = { questions: ['old-prompt'], active: true }
    focus(thread.id)
    const from = t.events.length
    inside.onUpdate(attachment, {
      kind: 'snapshot',
      value: snapshot(thread.id, { messages: [{ id: 'm1', role: 'user', content: 'x' }] })
    })
    expect(types(from, id)).toEqual(['thread.messages', 'queue.updated', 'questions.cleared', 'turn.completed'])
    const cleared = t.events.slice(from).find((event) => event.type === 'questions.cleared')!
    expect(cleared.data).toEqual({ requestId: 'old-prompt', threadId: id })
    // It was served once; the next snapshot is an ordinary resync, with nothing left to clear.
    expect(attachment.served).toBeUndefined()
  })

  it('puts a window right after the offline copy, and never lets the copy replace a newer live view', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const hub = (t.caller.bridge as unknown as { hub: Loose }).hub
    const old = snapshot(thread.id, {
      messages: [{ id: 'old', role: 'user', content: 'before' }],
      pendingQuestions: [{ requestId: 'q-old', threadId: thread.id, questions: [] }]
    })
    const replay = vi
      .spyOn(hub, 'replay')
      .mockImplementation(async (_ref: unknown, _options: unknown, update: (value: Loose) => void) => {
        update({ kind: 'snapshot', value: old })
        return true
      })
    // 1. The copy on disk is served first; then the live snapshot arrives and corrects the window.
    const attachment = inside.obtain(t.node, thread.id)
    await inside.fromReplica(attachment)
    expect(attachment.replica).toBe(true)
    expect(attachment.served).toEqual({ questions: ['q-old'], active: false })
    focus(thread.id)
    const from = t.events.length
    inside.onUpdate(attachment, {
      kind: 'snapshot',
      value: snapshot(thread.id, { messages: [{ id: 'new', role: 'user', content: 'after' }] })
    })
    expect(types(from, id)).toContain('questions.cleared')
    expect(attachment.view.read().messages.map((row: Loose) => row.id)).toEqual(['new'])
    expect(attachment.replica).toBe(false)

    // 2. The live snapshot is in before the copy has been read: the copy is dropped.
    const other = t.thread()
    const racing = inside.obtain(t.node, other.id)
    racing.view.install(snapshot(other.id, { messages: [{ id: 'live', role: 'user', content: 'live' }] }))
    racing.installed = true
    await inside.fromReplica(racing)
    expect(racing.view.read().messages.map((row: Loose) => row.id)).toEqual(['live'])
    expect(racing.replica).toBe(false)
    replay.mockRestore()
  })
})

describe('version skew, leases and ids', () => {
  let t: Awaited<ReturnType<typeof linked>>
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  /** A client that sees the owner's `net.info` with some rows missing or older. */
  const olderOwner = (change: (routed: Record<string, number>) => Record<string, number>): RoutedClient => {
    const wrapped = new WeakMap<object, object>()
    return new RoutedClient({
      session: (node: NodeId) => {
        const real = t.caller.net.session(node) as unknown as Loose
        let proxy = wrapped.get(real)
        if (!proxy)
          wrapped.set(
            real,
            (proxy = new Proxy(real, {
              get: (target, key) => {
                if (key === 'rpc')
                  return async (method: string, params: unknown, options: unknown) => {
                    const answer = await target.rpc(method, params, options)
                    return method === 'net.info'
                      ? { ...(answer as Loose), routed: change({ ...(answer as Loose).routed }) }
                      : answer
                  }
                const value = Reflect.get(target, key, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            }))
          )
        return proxy as never
      },
      computer: (node) => t.router.computer(node),
      signal: new AbortController().signal,
      stager: undefined
    })
  }
  const using = async <T>(client: RoutedClient, run: () => Promise<T>): Promise<T> => {
    const original = t.router.client
    const inside = t.router.attached as unknown as { options: { client: RoutedClient } }
    ;(t.router as unknown as { client: RoutedClient }).client = client
    inside.options.client = client
    try {
      return await run()
    } finally {
      ;(t.router as unknown as { client: RoutedClient }).client = original
      inside.options.client = original
    }
  }

  it('reads the whole snapshot from an owner that cannot leave the transcript out, or has no streams', async () => {
    const thread = t.thread('Older owner')
    const session = t.owner.orchestrator.getOrCreateSession(thread.id)
    session.messages = [{ id: 'm1', role: 'user', content: 'hello', timestamp: new Date().toISOString() }] as never
    const id = t.qualified(thread.id)
    for (const change of [
      (routed: Record<string, number>) => ({ ...routed, 'thread.snapshot': 1 }),
      (routed: Record<string, number>) => {
        const { 'stream.open': _open, ...rest } = routed
        return rest
      }
    ]) {
      const snap = await using(olderOwner(change), () => t.dispatch('thread.snapshot', { threadId: id }))
      expect(snap.messages.map((row: Loose) => row.id)).toEqual(['m1'])
      expect(snap.thread.id).toBe(id)
    }
  }, 120_000)

  it('keeps a claimed item out of the queue it is also in', async () => {
    const thread = t.thread('Claimed')
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id })
    await t.dispatch('thread.snapshot', { threadId: id })
    t.owner.orchestrator.emit('queue-updated', { threadId: thread.id, items: [{ id: 'i1', content: 'a', state: 'pending' }] })
    const real = t.client().call.bind(t.client())
    const spy = vi.spyOn(t.client(), 'call').mockImplementation(async (node, method, params, options) => {
      const answer = await real(node, method, params, options)
      return (params as Loose).transcript === false
        ? { ...(answer as Loose), claimed: [{ id: 'i1', content: 'a', state: 'claimed' }, { id: 'i2', content: 'b', state: 'claimed' }] }
        : answer
    })
    await vi.waitFor(async () => {
      const snap = await t.dispatch('thread.snapshot', { threadId: id })
      expect(snap.queue.map((row: Loose) => row.id)).toEqual(['i1'])
      expect(snap.claimed.map((row: Loose) => row.id)).toEqual(['i2'])
    })
    spy.mockRestore()
  }, 60_000)

  it('ends a window’s leases when its binding ends', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const binding = new AbortController()
    const window = { ...t.connection('switching'), lifetime: binding.signal }
    await t.dispatch('threads.focus', { threadId: id }, window)
    const here = () => t.router.attached.state().find((row) => row.threadId === thread.id)
    expect(here()?.focused).toBe(true)
    // The window switches to another profile: its signal aborts.
    binding.abort()
    expect(here()?.focused).toBe(false)
    // A window whose binding has already ended gets no lease at all.
    await expect(t.dispatch('threads.focus', { threadId: id }, window)).resolves.toMatchObject({ focused: false })
  }, 60_000)

  it('finds a qualified id anywhere an id belongs, and refuses it from a CLI', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    expect(
      unqualifyRoutedParams({ orderedIds: [id, 'plain'], nested: { sourceThreadId: id }, content: id })
    ).toMatchObject({
      params: { orderedIds: [thread.id, 'plain'], nested: { sourceThreadId: thread.id }, content: id },
      nodes: [t.node]
    })
    // The order of threads in the sidebar is local, but a qualified id in it must not reach local storage.
    expect(
      await t.refused(t.dispatch('threads.reorder', { orderedIds: [id] }, t.connection('c', 'cli')))
    ).toMatchObject({ code: 'forbidden' })
    expect(
      await t.refused(t.dispatch('threads.reorder', { threadIds: [id, 'plain'] }))
    ).toMatchObject({ code: 'mixed_computers' })
  }, 60_000)

  it('names the references in a sent message the way the owner does, and back', () => {
    const owner = newId('node'),
      self = newId('node')
    const block = (threadId: string) =>
      `[Mousse references data="${encodeURIComponent(JSON.stringify([{ id: 'r', kind: 'thread', title: 'T', threadId }]))}"]\n- thread: "T"\n  Thread ID: ${threadId}\n[/Mousse references]`
    const sent = outgoingMessageText(block('local-1') + block(`${owner}:theirs`), { node: owner, self })
    // This computer's thread is named with this computer; the owner's own is plain to the owner.
    expect(sent).toContain(`Thread ID: ${self}:local-1`)
    expect(sent).toContain('Thread ID: theirs')
    // And it comes back as it was: this computer's own thread is plain again.
    const back = qualifyRoutedResult('thread.messages', { messages: [{ id: 'm', content: sent }] }, { node: owner, self }) as Loose
    expect(back.messages[0].content).toContain('Thread ID: local-1')
    expect(back.messages[0].content).toContain(`Thread ID: ${owner}:theirs`)
  })

  it('does not give a CLI the events of a thread on another computer', () => {
    const accepts = (MmsProtocolServer.prototype as unknown as Loose).clientAcceptsEvent as (
      this: Loose,
      session: Loose,
      event: Loose
    ) => boolean
    const server = { opts: { mms: { profileId: 'p' } } }
    const remote = { type: 'thread.message', threadId: t.qualified('abc'), profileId: 'p' }
    expect(accepts.call(server, { clientType: 'gui', binding: { profileId: 'p' } }, remote)).toBe(true)
    expect(accepts.call(server, { clientType: 'cli', binding: { profileId: 'p' } }, remote)).toBe(false)
    expect(accepts.call(server, { clientType: 'cli', binding: { profileId: 'p' } }, { ...remote, threadId: 'abc' })).toBe(true)
  })
})

describe('attached threads, with fakes', () => {
  const fake = () => {
    const closes: string[] = []
    const opened: string[] = []
    let finishClose: (() => void) | undefined
    let release: ((handle: { close(): void; descriptor: unknown }) => void) | undefined
    const handlers: Loose = {}
    const hub = {
      attach: vi.fn(async (ref: Loose, update: unknown, error: () => void, options: Loose) => {
        opened.push(ref.entityId)
        handlers.error = error
        if (options?.slow) return new Promise((resolve) => (release = resolve as never))
        return { close: () => undefined, descriptor: {} }
      }),
      replay: vi.fn(async () => false)
    }
    const client = {
      closeStream: vi.fn(
        (_node: string, request: Loose) =>
          new Promise<void>((resolve) => {
            closes.push(request.threadId)
            finishClose = resolve
          })
      ),
      openStream: vi.fn(),
      call: vi.fn()
    }
    const attached = new AttachedThreads({
      services: { events: { emit: vi.fn() }, protocolSequence: () => 0 } as never,
      hub: hub as never,
      client: client as never,
      self: () => 'nod_self',
      computer: (node) => ({ node, name: 'Other' }),
      onGit: () => undefined
    })
    return {
      attached: attached as unknown as Loose,
      hub,
      client,
      closes,
      opened,
      handlers,
      finishClose: () => finishClose?.(),
      release: (handle: Loose) => release?.(handle)
    }
  }
  const NODE = newId('node')

  it('waits for the owner to close a stream before it opens one for the same thread', async () => {
    const f = fake()
    const first = f.attached.obtain(NODE, 't1')
    await f.attached.attach(first)
    f.attached.drop(first)
    expect(f.closes).toEqual(['t1'])
    const second = f.attached.obtain(NODE, 't1')
    const attaching = f.attached.attach(second)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The close has not been confirmed: nothing was opened yet.
    expect(f.opened).toEqual(['t1'])
    f.finishClose()
    await attaching
    expect(f.opened).toEqual(['t1', 't1'])
  })

  it('tells the owner when a thread is let go of while its stream was still being opened', async () => {
    const f = fake()
    f.hub.attach.mockImplementationOnce(
      (ref: Loose) =>
        new Promise((resolve) => {
          f.opened.push(ref.entityId)
          setTimeout(() => resolve({ close: () => undefined, descriptor: {} }), 50)
        }) as never
    )
    const attachment = f.attached.obtain(NODE, 't2')
    const attaching = f.attached.attach(attachment)
    f.attached.drop(attachment)
    await attaching
    expect(f.closes).toEqual(['t2'])
    f.finishClose()
  })

  it('attaches a focused thread again after its stream failed', async () => {
    const f = fake()
    const attachment = f.attached.obtain(NODE, 't3')
    f.attached.leases.set('w', new Set([f.attached.key(NODE, 't3')]))
    await f.attached.attach(attachment)
    expect(f.opened).toEqual(['t3'])
    f.handlers.error('internal')
    await vi.waitFor(() => expect(f.opened).toEqual(['t3', 't3']), { timeout: 5000 })
  })

  it('gives Git progress a room of its own beside the threads in view', async () => {
    const { fixture } = await import('../hub/fixture')
    const f = await fixture()
    const hub = f.hub() as unknown as Loose
    // 32 threads are attached (the room of threads in view is full).
    for (let n = 0; n < 32; n += 1)
      hub.attachments.set(`k${n}`, { ref: { nodeId: f.targetNode, entityId: `t${n}` }, options: { open: () => undefined }, listeners: new Set() })
    const refuse = () => Promise.reject(new NetError('forbidden'))
    const ref = { nodeId: f.targetNode, entityId: 'one-more' }
    await expect(hub.attach(ref, () => undefined, undefined, { open: refuse })).rejects.toMatchObject({
      code: 'rate_limited'
    })
    // Git progress is counted apart: it gets as far as opening the stream.
    await expect(hub.attach(ref, () => undefined, undefined, { open: refuse, room: 'channel' })).rejects.toMatchObject({
      code: 'forbidden'
    })
    hub.attachments.clear()
  }, 60_000)
})
