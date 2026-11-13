/**
 * A thread of another computer opens in one step at its newest state: what the stream replays to catch up
 * (the copy on disk, then what the owner has that the copy lacks) reaches the view, not the windows one record
 * at a time. Records that arrive once it has caught up still reach them as they come.
 *
 * The ways a window opens such a thread, as rows:
 * - reopened after its stream was let go, with records kept on disk after the copy's snapshot;
 * - reopened while the thread ran on: the owner has records the copy lacks;
 * - the link to the computer drops and comes back while the window has the thread in view.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BridgeHub } from '../../../../src/mms/bridge/hub'
import { cleanupAll, linked, type ProtocolEvent } from './routerFixture'

afterAll(cleanupAll)

const STORED = 120

const message = (id: string, content: string) => ({
  id,
  role: 'assistant',
  content,
  timestamp: new Date().toISOString()
})

const ids = (snapshot: { messages: Array<{ id: string }> }) => snapshot.messages.map((row) => row.id)

describe('opening a thread of another computer', () => {
  let t: Awaited<ReturnType<typeof linked>>
  beforeAll(async () => {
    t = await linked()
  }, 120_000)

  /**
   * A thread this computer read before, with `STORED` records after its snapshot on disk, then let go. With
   * `ownerKeepsIt` the owner is not told, as when this computer's service stops, and keeps the stream open.
   */
  async function readBeforeAndLetGo(name: string, { ownerKeepsIt = false } = {}) {
    const thread = t.thread(name)
    const id = t.qualified(thread.id)
    await t.dispatch('threads.focus', { threadId: id }, t.connection('earlier'))
    await t.dispatch('thread.snapshot', { threadId: id }, t.connection('earlier'))
    t.owner.orchestrator.emit('turn-started', { threadId: thread.id })
    for (let n = 0; n < STORED; n++)
      t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message(`m${n}`, `line ${n}`) })
    await vi.waitFor(
      async () => expect(ids(await t.dispatch('thread.snapshot', { threadId: id }, t.connection('earlier')))).toHaveLength(STORED),
      { timeout: 20_000 }
    )
    const options = (t.router.attached as unknown as { options: { idleMs?: number } }).options
    options.idleMs = 10
    const untold = ownerKeepsIt ? vi.spyOn(t.client(), 'closeStream').mockResolvedValue(undefined as never) : undefined
    await t.dispatch('threads.focus', { threadId: id, focused: false }, t.connection('earlier'))
    await vi.waitFor(() => expect(t.router.attached.state().some((row) => row.threadId === thread.id)).toBe(false), {
      timeout: 5000
    })
    if (untold) {
      untold.mockRestore()
      expect(t.ownerThreads().privateHead(t.callerNode, thread.id)).toBeDefined()
    } else
      await vi.waitFor(() => expect(t.ownerThreads().privateHead(t.callerNode, thread.id)).toBeUndefined(), {
        timeout: 5000
      })
    options.idleMs = undefined
    return { thread, id }
  }

  /** Opens it the way a window does (`selectThread`): the lease, then the snapshot. */
  async function open(id: string, window = 'window-1') {
    const from = t.events.length
    const started = performance.now()
    // When the window last heard of the thread: the time it holds what it will show.
    let lastHeard = started
    const heard = (event: ProtocolEvent) => {
      if (event.threadId === id) lastHeard = performance.now()
    }
    t.caller.events.on('protocol:event', heard as (data: unknown) => void)
    await t.dispatch('threads.focus', { threadId: id }, t.connection(window))
    const snapshot = await t.dispatch('thread.snapshot', { threadId: id }, t.connection(window))
    const answered = performance.now()
    return {
      snapshot,
      events: () => t.events.slice(from).filter((event) => event.threadId === id),
      /** How long until the window had the snapshot, and until it had the last thing it was sent for the open. */
      timing: () => {
        t.caller.events.off('protocol:event', heard as (data: unknown) => void)
        return `snapshot after ${Math.round(answered - started)} ms, settled after ${Math.round(Math.max(answered, lastHeard) - started)} ms`
      }
    }
  }

  const transcriptEvents = (events: ProtocolEvent[]) =>
    events.filter((event) => event.type === 'thread.message' || event.type === 'thread.message-updated')

  it('shows a thread reopened with records on disk at its newest state, without replaying them', async () => {
    const { thread, id } = await readBeforeAndLetGo('Reopened', { ownerKeepsIt: true })
    const opened = await open(id)
    expect(ids(opened.snapshot)).toHaveLength(STORED)
    expect(opened.snapshot.activeTurn).toMatchObject({ active: true })
    // Let anything still on its way arrive.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const events = opened.events()
    console.info(`[measure] reopen with ${STORED} stored records: ${events.length} events to the window, ${opened.timing()}`)
    expect(transcriptEvents(events)).toEqual([])
    // A record that arrives after the open still reaches the window by itself.
    const from = t.events.length
    t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message('live', 'after the open') })
    await vi.waitFor(
      () =>
        expect(transcriptEvents(t.events.slice(from).filter((event) => event.threadId === id)).map((event) => event.data.message?.id)).toEqual([
          'live'
        ]),
      { timeout: 10_000 }
    )
  }, 120_000)

  it('shows what the thread printed while nobody read it in the first view, not record by record after it', async () => {
    const { thread, id } = await readBeforeAndLetGo('Ran on')
    // The owner holds a stream of the thread open for this computer that the copy on disk has not seen the end of.
    await t.client().openStream(t.node, { kind: 'thread', threadId: thread.id })
    for (let n = 0; n < 40; n++)
      t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message(`later${n}`, `later ${n}`) })
    const opened = await open(id)
    // The owner's new snapshot has none of the messages it was sent here (they are not saved), then the 40 records.
    const newest = Array.from({ length: 40 }, (_, n) => `later${n}`)
    await vi.waitFor(async () => expect(ids(await t.dispatch('thread.snapshot', { threadId: id }))).toEqual(newest), {
      timeout: 20_000
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const events = opened.events()
    console.info(`[measure] reopen with ${STORED} stored + 40 new records: ${events.length} events to the window, ${opened.timing()}`)
    expect(transcriptEvents(events)).toEqual([])
    // What the window holds is the newest transcript: the first view, or the one replacement after it.
    const replaced = events.filter((event) => event.type === 'thread.messages' && event.data.replace === true)
    expect(replaced.length).toBeLessThanOrEqual(1)
    const last = replaced.at(-1)?.data.messages ?? opened.snapshot.messages
    expect(last.map((row: { id: string }) => row.id)).toEqual(newest)
  }, 120_000)

  it('puts a thread in view right in one step when the link to its computer comes back', async () => {
    const thread = t.thread('Relinked')
    const id = t.qualified(thread.id)
    await open(id)
    for (let n = 0; n < 60; n++)
      t.owner.orchestrator.emit('thread-message', { threadId: thread.id, message: message(`r${n}`, `line ${n}`) })
    await vi.waitFor(async () => expect(ids(await t.dispatch('thread.snapshot', { threadId: id }))).toHaveLength(60), {
      timeout: 20_000
    })
    const from = t.events.length
    // The session comes back: the hub opens every stream of that computer again, from the copy on disk.
    await (t.caller.bridge as unknown as { hub: BridgeHub }).hub.reconnect(t.node)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const events = t.events.slice(from).filter((event) => event.threadId === id)
    console.info(`[measure] relink with 60 stored records: ${events.length} events to the window`)
    expect(transcriptEvents(events)).toEqual([])
    const replaced = events.filter((event) => event.type === 'thread.messages' && event.data.replace === true)
    // Never an older transcript over the one the window holds: every replacement is the whole, newest one.
    for (const event of replaced) expect(event.data.messages).toHaveLength(60)
    expect(ids(await t.dispatch('thread.snapshot', { threadId: id }))).toHaveLength(60)
  }, 120_000)
})
