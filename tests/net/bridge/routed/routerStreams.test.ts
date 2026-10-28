/**
 * Threads of another computer that a window keeps in view: the stream they travel on, the leases that
 * hold it, the order of what arrives, the copy kept for when the computer is offline.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupAll, linked } from './routerFixture'

afterAll(cleanupAll)

const message = (id: string, content: string) => ({
  id,
  role: 'user',
  content,
  timestamp: new Date().toISOString()
})

describe('a thread in view', () => {
  let t: Awaited<ReturnType<typeof linked>>
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  it('attaches on focus, shares one stream between windows, and lets go after the idle time', async () => {
    const thread = t.thread('Streamed')
    const id = t.qualified(thread.id)
    const here = () =>
      t.router.attached.state().find((row) => row.threadId === thread.id)
    await t.dispatch('threads.focus', { threadId: id }, t.connection('w1'))
    await t.dispatch('threads.focus', { threadId: id }, t.connection('w2'))
    expect(here()).toEqual({ node: t.node, threadId: thread.id, focused: true, attached: true })
    // Two windows, one stream: the owner holds a single one for this computer.
    expect(t.ownerThreads().privateHead(t.callerNode, thread.id)).toBeDefined()
    expect(t.router.attached.state().filter((row) => row.threadId === thread.id)).toHaveLength(1)
    await t.dispatch('threads.focus', { threadId: id, focused: false }, t.connection('w1'))
    expect(here()?.focused).toBe(true)
    // The lease of a window that closes ends with it.
    ;(t.caller.domains as { notifyConnectionClosed(id: string): void }).notifyConnectionClosed('w2')
    expect(here()).toMatchObject({ focused: false, attached: true })
    // Nobody has it in view for the idle time: the stream is let go on both sides.
    ;(t.router.attached as unknown as { options: { idleMs?: number } }).options.idleMs = 20
    await t.dispatch('threads.focus', { threadId: id }, t.connection('w3'))
    await t.dispatch('threads.focus', { threadId: id, focused: false }, t.connection('w3'))
    await vi.waitFor(() => expect(here()).toBeUndefined(), { timeout: 5000 })
    await vi.waitFor(() => expect(t.ownerThreads().privateHead(t.callerNode, thread.id)).toBeUndefined(), {
      timeout: 5000
    })
    ;(t.router.attached as unknown as { options: { idleMs?: number } }).options.idleMs = undefined
  }, 60_000)

  it('brings the events in order with qualified ids, and the snapshot is the same transcript', async () => {
    const thread = t.thread('Events')
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id })
    const opening = await t.dispatch('thread.snapshot', { threadId: id })
    expect(opening).toMatchObject({ thread: { id }, messages: [], queue: [] })
    const from = t.events.length
    for (const n of [1, 2, 3])
      t.owner.orchestrator.emit('thread-message', {
        threadId: thread.id,
        message: message(`m${n}`, `message ${n}`)
      })
    t.owner.orchestrator.emit('turn-started', { threadId: thread.id })
    await vi.waitFor(
      () => expect(t.events.slice(from).filter((event) => event.threadId === id).length).toBe(4),
      { timeout: 10_000 }
    )
    const mine = t.events.slice(from).filter((event) => event.threadId === id)
    expect(mine.map((event) => event.type)).toEqual([
      'thread.message',
      'thread.message',
      'thread.message',
      'turn.started'
    ])
    expect(mine.map((event) => event.data.message?.id)).toEqual(['m1', 'm2', 'm3', undefined])
    expect(mine[3].data).toEqual({ threadId: id })
    const after = await t.dispatch('thread.snapshot', { threadId: id })
    expect(after.messages.map((row: { id: string }) => row.id)).toEqual(['m1', 'm2', 'm3'])
    expect(after.activeTurn).toMatchObject({ active: true })
    // Events up to the revision are in the snapshot; nothing the ring pushed later is.
    expect(after.revision).toBe(t.caller.protocolSequence())
    // No event named a thread of the owner by its own id.
    for (const event of t.events.slice(from)) expect(JSON.stringify(event)).not.toContain(`"${thread.id}"`)
  }, 60_000)

  it('gives the same transcript whether the routed read or the stream arrives last', async () => {
    const thread = t.thread('Orders')
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id })
    await t.dispatch('thread.snapshot', { threadId: id })
    const real = t.client().call.bind(t.client())
    const slow = vi.spyOn(t.client(), 'call').mockImplementation(async (...args) => {
      const answer = await real(...args)
      await new Promise((resolve) => setTimeout(resolve, 400))
      return answer
    })
    const reading = t.dispatch('thread.snapshot', { threadId: id })
    // The stream's record lands while the routed read is still on its way.
    t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message('x1', 'first') })
    const during = await reading
    // And another lands after the read has returned.
    t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message('x2', 'second') })
    await vi.waitFor(
      async () => {
        const later = await t.dispatch('thread.snapshot', { threadId: id })
        expect(later.messages.map((row: { id: string }) => row.id)).toEqual(['x1', 'x2'])
      },
      { timeout: 10_000 }
    )
    // Whichever side was first, no message is missing and none is there twice.
    const ids = during.messages.map((row: { id: string }) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    slow.mockRestore()
  }, 60_000)

  it('forwards only settled records for a thread nobody has in view, never the streaming notes', async () => {
    const thread = t.thread('Quiet')
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id })
    await t.dispatch('threads.focus', { threadId: id, focused: false })
    const from = t.events.length
    // A streaming message is a note, not a record.
    t.owner.orchestrator.emit('thread-message-updated', {
      threadId: thread.id,
      message: { ...message('s1', 'partial'), streaming: true }
    })
    t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message('s2', 'done') })
    await vi.waitFor(
      () => expect(t.events.slice(from).some((event) => event.threadId === id)).toBe(true),
      { timeout: 10_000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(t.events.slice(from).filter((event) => event.threadId === id).map((event) => event.type)).toEqual([
      'thread.message'
    ])
  }, 60_000)
})

describe('the stream limits', () => {
  it('keeps 16 threads per computer attached, and lets the oldest go for the 17th', async () => {
    const t = await linked()
    const threads = Array.from({ length: 17 }, (_, i) => t.thread(`T${i}`))
    for (const thread of threads)
      await t.dispatch('threads.focus', { threadId: t.qualified(thread.id) }, t.connection('lru'))
    const attached = t.router.attached.state().filter((row) => row.node === t.node)
    expect(attached).toHaveLength(16)
    expect(attached.map((row) => row.threadId)).not.toContain(threads[0].id)
    // The owner was told, so the room is free for the new stream.
    await vi.waitFor(() => expect(t.ownerThreads().privateHead(t.callerNode, threads[0].id)).toBeUndefined(), {
      timeout: 5000
    })
    expect(t.ownerThreads().privateHead(t.callerNode, threads[16].id)).toBeDefined()
  }, 180_000)
})

describe('a computer that goes offline', () => {
  it('keeps its thread readable from the copy on disk, and fails actions as offline', async () => {
    const t = await linked()
    const thread = t.thread('Away')
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id })
    await t.dispatch('thread.snapshot', { threadId: id })
    t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message('a1', 'before it left') })
    await vi.waitFor(async () => {
      const seen = await t.dispatch('thread.snapshot', { threadId: id })
      expect(seen.messages).toHaveLength(1)
    })
    // Let the thread go, then lose the computer.
    ;(t.router.attached as unknown as { options: { idleMs?: number } }).options.idleMs = 1
    await t.dispatch('threads.focus', { threadId: id, focused: false })
    await vi.waitFor(() => expect(t.router.attached.state()).toHaveLength(0), { timeout: 5000 })
    await t.owner.net.request('net.disable', {})
    await vi.waitFor(() => expect(() => t.caller.net.session(t.node)).toThrow(), { timeout: 15_000 })

    const offline = await t.dispatch('thread.snapshot', { threadId: id })
    expect(offline.messages.map((row: { id: string }) => row.id)).toEqual(['a1'])
    expect(offline.offline).toMatchObject({ node: t.node })
    const refusal = await t.refused(t.dispatch('threads.rename', { threadId: id, name: 'nope' }))
    expect(refusal).toMatchObject({ code: 'computer_offline' })
    expect(refusal.message).toMatch(/offline/)
  }, 180_000)
})
