/**
 * What the router does with a call on its way: refusals that reach the window unchanged, the words for
 * a computer that refused or is older, a lost reply, big replies and queue changes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NetError, type NodeId } from '../../../../src/shared/net'
import { RoutedClient } from '../../../../src/mms/bridge/routed/RoutedClient'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

type SyncSessionLike = Record<string, any>

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)

/** A client whose session is wrapped, so a test can change what the other computer says or drops a reply. */
function clientWith(overrides: (session: SyncSessionLike) => SyncSessionLike): RoutedClient {
  /** The session's methods, bound, so only the ones a test replaces differ. */
  const wrap = (real: SyncSessionLike): SyncSessionLike => {
    const changed = overrides(real)
    return new Proxy(real, {
      get: (target, key) => {
        if (typeof key === 'string' && key in changed) return changed[key]
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  const wrapped = new WeakMap<object, SyncSessionLike>()
  return new RoutedClient({
    session: (node: NodeId) => {
      const real = t.caller.net.session(node) as unknown as SyncSessionLike
      let proxy = wrapped.get(real)
      if (!proxy) wrapped.set(real, (proxy = wrap(real)))
      return proxy as never
    },
    computer: (node) => t.router.computer(node),
    signal: new AbortController().signal,
    stager: (t.router.client as unknown as { deps: { stager?: never } }).deps.stager
  })
}
const withClient = async <T>(client: RoutedClient, run: () => Promise<T>): Promise<T> => {
  const original = t.router.client
  ;(t.router as unknown as { client: RoutedClient }).client = client
  try {
    return await run()
  } finally {
    ;(t.router as unknown as { client: RoutedClient }).client = original
  }
}

describe('refusals', () => {
  it('reach the window as the owner’s own error, with its code and details', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const first = await t.dispatch('queue.enqueue', { threadId: id, content: 'one', requestId: 'q1' })
    const second = await t.dispatch('queue.enqueue', { threadId: id, content: 'two', requestId: 'q2' })
    expect(first.item.id).not.toBe(second.item.id)
    const listed = await t.dispatch('queue.list', { threadId: id })
    expect(listed.items.map((row: { id: string }) => row.id)).toEqual([first.item.id, second.item.id])
    // With the revision it read, a reorder goes through; with a stale one it is refused unchanged.
    const reordered = await t.dispatch('queue.reorder', {
      threadId: id,
      orderedIds: [second.item.id, first.item.id],
      expectedRevision: listed.revision
    })
    expect(reordered.items ?? true).toBeTruthy()
    const refusal = await t.refused(
      t.dispatch('queue.reorder', {
        threadId: id,
        orderedIds: [first.item.id, second.item.id],
        expectedRevision: 'stale-revision'
      })
    )
    expect(refusal).toMatchObject({ code: 'revision_mismatch' })
    expect(refusal.details).toMatchObject({ expectedRevision: 'stale-revision' })
    expect(await t.refused(t.dispatch('threads.get', { threadId: t.qualified('nope') }))).toMatchObject({
      code: 'thread_not_found'
    })
  }, 60_000)

  it('refuses a /workflow command from another computer, as the owner does', async () => {
    const thread = t.thread()
    const prepare = vi
      .spyOn(t.owner.platform.workflowChat!, 'prepare')
      .mockResolvedValue({ content: '/review', workflowInvocationId: 'invocation-1' } as never)
    const send = vi.spyOn(t.owner.orchestrator, 'send')
    expect(
      await t.refused(
        t.dispatch('orchestrator.send', {
          threadId: t.qualified(thread.id),
          content: '/review',
          requestId: 'wf-1'
        })
      )
    ).toMatchObject({ code: 'workflow_not_available_remotely' })
    expect(send).not.toHaveBeenCalled()
    prepare.mockRestore()
    send.mockRestore()
  }, 60_000)

  it('carries an answer with "Always" to the owner as a person on this computer', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const asked = vi
      .spyOn(t.owner.questions, 'getRequest')
      .mockReturnValue({ threadId: thread.id } as never)
    vi.spyOn(t.owner.questions, 'getPending').mockReturnValue(undefined as never)
    const settle = vi
      .spyOn(t.owner.questions, 'settle')
      .mockReturnValue({ ok: true } as never)
    const reply = await t.dispatch('orchestrator.answerQuestions', {
      threadId: id,
      requestId: 'ask-1',
      answers: { approval: 'always' }
    })
    expect(reply).toMatchObject({ ok: true })
    expect(settle).toHaveBeenCalledWith(
      'ask-1',
      expect.objectContaining({ approval: 'always' }),
      expect.objectContaining({ kind: 'user', via: 'bridge', node: t.callerNode })
    )
    // A request that belongs to another thread is not this thread's to answer.
    asked.mockReturnValue({ threadId: 'someone-elses' } as never)
    expect(
      await t.refused(
        t.dispatch('orchestrator.answerQuestions', { threadId: id, requestId: 'ask-2', answers: { approval: 'allow' } })
      )
    ).toMatchObject({ code: 'request_not_found' })
    vi.restoreAllMocks()
  }, 60_000)

  it('follows a large reply to its end and qualifies what it holds', async () => {
    const thread = t.thread()
    const session = t.owner.orchestrator.getOrCreateSession(thread.id)
    session.messages = [
      { id: 'big', role: 'user', content: 'x'.repeat(200 * 1024), timestamp: new Date().toISOString() },
      { id: 'tail', role: 'user', content: 'end', timestamp: new Date().toISOString() }
    ] as never
    const page = await t.dispatch('thread.messages', { threadId: t.qualified(thread.id), before: 'tail', limit: 10 })
    expect(page.messages.map((row: { id: string }) => row.id)).toEqual(['big'])
    expect(page.messages[0].content).toHaveLength(200 * 1024)
  }, 60_000)
})

describe('steer and Stop', () => {
  it('steer a turn the owner’s own window started, and stop it, from this computer', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const steer = vi
      .spyOn(t.owner.orchestrator, 'steerThreadOrEnqueueExternal')
      .mockReturnValue({ steered: true, queued: false })
    const stop = vi.spyOn(t.owner.orchestrator, 'stopThread').mockResolvedValue({ ok: true } as never)
    const steered = await t.dispatch('orchestrator.steer', { threadId: id, text: 'go left', clientRequestId: 'steer-1' })
    expect(steered).toMatchObject({ ok: true, steered: true })
    expect(steer).toHaveBeenCalledWith(thread.id, 'go left', expect.objectContaining({ source: 'gui' }))
    const stopped = await t.dispatch('orchestrator.abort', { threadId: id, clientRequestId: 'stop-1' })
    expect(stopped).toEqual({ ok: true })
    expect(stop).toHaveBeenCalledWith(thread.id, 'user', expect.objectContaining({ clientRequestId: 'stop-1' }))
    // The same request id again is the same request: the owner does not stop it twice.
    await t.dispatch('orchestrator.abort', { threadId: id, clientRequestId: 'stop-1' })
    expect(stop).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  }, 60_000)
})

describe('Git progress', () => {
  it('goes to the window that started the action, and only that window can cancel it', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const heard = { first: [] as unknown[], second: [] as unknown[] }
    const window = (name: 'first' | 'second') => ({
      ...t.connection(name),
      emitConnectionEvent: (_type: string, data: unknown) => {
        heard[name].push(data)
        return Promise.resolve()
      }
    })
    const first = window('first'),
      second = window('second')
    // The thread has no folder, so the action is refused; the progress route is set up before it is.
    expect(await t.refused(t.dispatch('git.fetch', { threadId: id, operationId: 'op-1' }, first))).toMatchObject({
      code: 'thread_has_no_folder'
    })
    const pushed = t.ownerThreads().pushChannel(t.callerNode, 'git.operation', {
      event: { operationId: 'op-1', phase: 'running' }
    })
    expect(pushed).toBe(true)
    await vi.waitFor(() => expect(heard.first).toHaveLength(1), { timeout: 10_000 })
    expect(heard.first[0]).toMatchObject({ event: { operationId: 'op-1' } })
    expect(heard.second).toEqual([])
    // Another window is told the action is not running; the starting window's cancel reaches the owner.
    await expect(t.dispatch('git.cancelOperation', { threadId: id, operationId: 'op-1' }, second)).resolves.toEqual({
      cancelled: false
    })
    await expect(t.dispatch('git.cancelOperation', { threadId: id, operationId: 'op-1' }, first)).resolves.toEqual({
      cancelled: false
    })
  }, 60_000)
})

describe('what a computer refused, in words', () => {
  it('says why: the owner’s switch, a block, and the grant', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    await t.owner.net.request('bridge.workOnThreads', { enabled: false })
    const off = await t.refused(t.dispatch('threads.get', { threadId: id }))
    expect(off).toMatchObject({ code: 'computer_forbidden', details: { reason: 'setting_off' } })
    expect(off.message).toMatch(/^Works on threads is off on /)
    await t.owner.net.request('bridge.workOnThreads', { enabled: true })

    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    const blocked = await t.refused(t.dispatch('threads.get', { threadId: id }))
    expect(blocked).toMatchObject({ code: 'computer_forbidden', details: { reason: 'blocked' } })
    expect(blocked.message).toMatch(/refused this device\.$/)
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: false })
    await expect(t.dispatch('threads.get', { threadId: id })).resolves.toBeDefined()
  }, 60_000)

  it('says to update only for the action an older computer lacks', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    const older = clientWith((real) => ({
      rpc: async (method: string, params: unknown, options: unknown) => {
        const answer = await real.rpc(method, params, options)
        if (method !== 'net.info') return answer
        const info = answer as { routed: Record<string, number> }
        const { 'threads.pin': _pin, ...rest } = info.routed
        // This computer knows rows at version 1 only, and has no pin.
        return { ...info, routed: { ...rest, 'orchestrator.send': 1 } }
      }
    }))
    await withClient(older, async () => {
      const refusal = await t.refused(t.dispatch('threads.pin', { threadId: id, pinned: true }))
      expect(refusal).toMatchObject({ code: 'computer_outdated', details: { method: 'threads.pin' } })
      expect(refusal.message).toMatch(/^Update Mousse on .* to do this\.$/)
      // Everything else it has keeps working.
      await expect(t.dispatch('threads.rename', { threadId: id, name: 'Still works' })).resolves.toBeDefined()
      // A key only a newer version knows is the one action that says so: a large message needs staging.
      const small = vi.spyOn(t.owner.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
      await t.dispatch('orchestrator.send', { threadId: id, content: 'short', requestId: 'old-1' })
      const needsStaging = await t.refused(
        t.dispatch('orchestrator.send', { threadId: id, content: 'y'.repeat(100 * 1024), requestId: 'old-2' })
      )
      expect(needsStaging).toMatchObject({ code: 'computer_outdated' })
      small.mockRestore()
    })
  }, 60_000)
})

describe('a reply that is lost', () => {
  it('is found again with the same request id: exactly one item, not two', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    let dropped = false
    const lossy = clientWith((real) => ({
      rpc: async (method: string, params: unknown, options: unknown) => {
        const answer = await real.rpc(method, params, options)
        if (method === 'routed.queue.enqueue' && !dropped) {
          // The owner did the work; the link goes before the reply is read.
          dropped = true
          ;(real as unknown as { close(code: string): void }).close('peer_offline')
          throw new NetError('peer_offline')
        }
        return answer
      }
    }))
    const result = await withClient(lossy, () =>
      t.dispatch('queue.enqueue', { threadId: id, content: 'once only', requestId: 'lost-1' })
    )
    expect(dropped).toBe(true)
    expect(t.owner.orchestrator.listQueue(thread.id).filter((row) => row.content === 'once only')).toHaveLength(1)
    expect(result.item).toMatchObject({ content: 'once only' })
  }, 120_000)
})

