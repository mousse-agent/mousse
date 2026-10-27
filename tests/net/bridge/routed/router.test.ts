/**
 * The caller's router, over two real daemons: a window of one computer works on a thread the other
 * computer runs. The actions arrive on the owner as the owner's own handlers run them, the answers
 * come back with qualified ids, and the thread's events reach the caller's windows in order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseQualifiedId } from '../../../../src/shared/threadRef'
import { cleanupAll, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)
afterAll(cleanupAll)

describe('what a window sends', () => {
  it('renames a thread on the owner and gets back qualified ids and the local lists', async () => {
    const thread = t.thread('Before')
    const result = await t.dispatch('threads.rename', { threadId: t.qualified(thread.id), name: 'After' })
    expect(t.owner.threads.getThread(thread.id)!.name).toBe('After')
    expect(result.thread).toMatchObject({ id: t.qualified(thread.id), name: 'After' })
    // The owner's own lists are not sent; the caller rebuilds the ones that are its own.
    expect(result.threads).toEqual(t.caller.threads.listAllThreads())
    expect(parseQualifiedId(result.thread.id)).toEqual({ node: t.node, id: thread.id })
  }, 60_000)

  it('sends a message with an image, and stages one too large for a request', async () => {
    const thread = t.thread()
    const send = vi
      .spyOn(t.owner.orchestrator, 'send')
      .mockResolvedValue({ message: '', actions: [], runId: 'run-1', accepted: true } as never)
    const small = { name: 'a.png', mimeType: 'image/png', data: 'AAAA' }
    await t.dispatch('orchestrator.send', {
      threadId: t.qualified(thread.id),
      content: 'look',
      requestId: 'req-small',
      images: [small],
      source: 'gui'
    })
    expect(send.mock.calls[0][2]).toMatchObject({
      threadId: thread.id,
      source: 'gui',
      sentFrom: { node: t.callerNode }
    })
    expect(send.mock.calls[0][0]).toBeDefined()
    const big = { name: 'b.png', mimeType: 'image/png', data: 'B'.repeat(200 * 1024) }
    await t.dispatch('orchestrator.send', {
      threadId: t.qualified(thread.id),
      content: 'look again',
      requestId: 'req-big',
      images: [big]
    })
    const input = send.mock.calls[1][0] as { images?: Array<{ data: string }> } | string
    expect(typeof input === 'string' ? undefined : input.images?.[0].data.length).toBe(200 * 1024)
    send.mockRestore()
  }, 120_000)

  it('refuses what a window may not route: a CLI, two computers in one call, and the CLI-only paths', async () => {
    const thread = t.thread()
    const id = t.qualified(thread.id)
    // The CLI and the agents of the caller never route.
    for (const clientType of ['cli', 'test', 'bridge'] as const)
      expect(
        await t.refused(t.dispatch('threads.rename', { threadId: id, name: 'x' }, t.connection('c', clientType)))
      ).toMatchObject({ code: 'forbidden' })
    // A call that reaches the daemon with no connection at all (the Bridge's own backend) does not route either.
    expect(await t.refused(t.dispatch('threads.rename', { threadId: id, name: 'x' }, null as never))).toMatchObject({ code: 'forbidden' })
    expect(t.owner.threads.getThread(thread.id)!.name).not.toBe('x')
    // One call cannot span a computer and this one.
    const local = t.caller.threads.createThread('Local')
    expect(
      await t.refused(t.dispatch('pullRequests.create', { threadId: id, originThreadId: local.id, title: 't' }))
    ).toMatchObject({ code: 'mixed_computers' })
    // Permanent delete stays on the computer that runs the thread.
    expect(await t.refused(t.dispatch('threads.purge', { threadId: id }))).toMatchObject({
      code: 'not_available_remotely'
    })
    // A thread of this computer is not routed to itself.
    expect(
      await t.refused(t.dispatch('threads.rename', { threadId: `${t.callerNode}:${local.id}`, name: 'x' }))
    ).toMatchObject({ code: 'invalid_params' })
  }, 60_000)

  it('does not route with the flag off, and nothing about a plain id changes', async () => {
    t.routing(false)
    try {
      const thread = t.thread()
      // The name is a colon-separated id no thread of this computer has: refused locally, as before.
      await expect(t.dispatch('threads.rename', { threadId: t.qualified(thread.id), name: 'x' })).rejects.toBeDefined()
      expect(t.owner.threads.getThread(thread.id)!.name).not.toBe('x')
      await expect(t.dispatch('threads.focus', { threadId: t.qualified(thread.id) })).resolves.toEqual({
        routed: false,
        focused: false
      })
      const local = t.caller.threads.createThread('Local')
      const renamed = await t.dispatch('threads.rename', { threadId: local.id, name: 'Still local' })
      expect(renamed.thread.id).toBe(local.id)
    } finally {
      t.routing(true)
    }
  }, 60_000)

  it('reads from the owner and qualifies what it finds', async () => {
    const thread = t.thread('Readable')
    const got = await t.dispatch('threads.get', { threadId: t.qualified(thread.id) })
    expect(got.thread).toMatchObject({ id: t.qualified(thread.id), name: 'Readable' })
    expect(await t.refused(t.dispatch('threads.get', { threadId: t.qualified('missing') }))).toMatchObject({
      code: 'thread_not_found'
    })
  }, 60_000)
})
