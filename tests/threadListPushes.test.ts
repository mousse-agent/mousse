import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsRemoteBackend } from '../src/mms/bridge/remote/MmsBackend'
import type { Thread } from '../src/shared/types'

type Event = { type: string; data?: unknown; threadId?: string }

describe('windows hear of list changes once, as pushes', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let window: LocalMmsClient
  let other: LocalMmsClient
  let seen: Event[]
  let seenByOther: Event[]

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-list-pushes-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    seen = []
    seenByOther = []
    window = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
    other = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
    window.onEvent((event) => seen.push(event as Event))
    other.onEvent((event) => seenByOther.push(event as Event))
    for (const client of [window, other]) {
      await client.connect()
      await client.subscribe()
    }
  }, 30_000)

  afterEach(async () => {
    await window?.close()
    await other?.close()
    await server?.stop()
    await mms?.stop()
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows can hold a thread database open a moment after stop; the temporary folder is left behind.
    }
    delete process.env.MOUSSE_HOME
  })

  const listsAfter = async (events: Event[], run: () => Promise<unknown>): Promise<Thread[][]> => {
    const from = events.length
    await run()
    // Pushes go out after the turn of the event loop that made the change; wait well past it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return events.slice(from).filter((event) => event.type === 'threads.updated').map((event) => (event.data as { threads: Thread[] }).threads)
  }

  it('sends one thread list for a create, with the new thread, to every window', async () => {
    let created: Thread | undefined
    const lists = await listsAfter(seen, async () => {
      created = (await window.request<{ thread: Thread }>('threads.create', { name: 'Fix the build' })).thread
    })
    expect(lists).toHaveLength(1)
    expect(lists[0].map((thread) => thread.id)).toContain(created!.id)
    const others = seenByOther.filter((event) => event.type === 'threads.updated')
    expect((others.at(-1)?.data as { threads: Thread[] }).threads).toEqual(lists[0])
  })

  it('sends one thread list for a rename, a pin and a settle, each with the change made', async () => {
    const thread = (await window.request<{ thread: Thread }>('threads.create', { name: 'Before', started: true })).thread
    await new Promise((resolve) => setTimeout(resolve, 100))
    const renamed = await listsAfter(seen, () => window.request('threads.rename', { threadId: thread.id, name: 'After' }))
    expect(renamed).toHaveLength(1)
    expect(renamed[0].find((entry) => entry.id === thread.id)?.name).toBe('After')
    const pinned = await listsAfter(seen, () => window.request('threads.pin', { threadId: thread.id, pinned: true }))
    expect(pinned).toHaveLength(1)
    expect(pinned[0].find((entry) => entry.id === thread.id)?.pinnedAt).toBeTruthy()
    const settled = await listsAfter(seen, () => window.request('threads.settle', { threadId: thread.id, settled: true }))
    expect(settled).toHaveLength(1)
    expect(settled[0].find((entry) => entry.id === thread.id)?.settledAt).toBeTruthy()
  })

  it('still tells windows about a thread made without a request (an agent, the CLI, a schedule)', async () => {
    const lists = await listsAfter(seen, async () => { mms.threads.createThread('Made by an agent', undefined, undefined, { started: true }) })
    expect(lists).toHaveLength(1)
    expect(lists[0].some((thread) => thread.name === 'Made by an agent')).toBe(true)
  })

  it('versions every list it sends, so a list read before a change is older than the push after it', async () => {
    const read = await window.request<{ threads: Thread[]; version: { epoch: string; seq: number } }>('threads.list', {})
    expect(read.version).toMatchObject({ epoch: expect.any(String), seq: expect.any(Number) })
    const from = seen.length
    await window.request('threads.create', { name: 'After the read', started: true })
    await vi.waitFor(() => expect(seen.slice(from).some((event) => event.type === 'threads.updated')).toBe(true))
    const pushed = seen.slice(from).filter((event) => event.type === 'threads.updated').at(-1)!.data as { version: { epoch: string; seq: number } }
    expect(pushed.version.epoch).toBe(read.version.epoch)
    expect(pushed.version.seq).toBeGreaterThan(read.version.seq)
  })

  it('tells windows when an expired thread is deleted, with no request behind it', async () => {
    const thread = mms.threads.createThread('Expiring', undefined, undefined, { started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 100))
    mms.threads.updateThreadMeta(thread.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    const lists = await listsAfter(seen, () => mms.threadExpiry.pass())
    expect(lists.length).toBeGreaterThanOrEqual(1)
    expect(lists.at(-1)!.some((entry) => entry.id === thread.id)).toBe(false)
  })

  it('tells windows of a pin and a delete a phone made through its backend', async () => {
    const thread = mms.threads.createThread('From the phone', undefined, undefined, { started: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const backend = new MmsRemoteBackend(mms)
    const pinned = await listsAfter(seen, () => backend.execute('threads.pin' as never, { threadId: thread.id, pinned: true }))
    expect(pinned).toHaveLength(1)
    expect(pinned[0].find((entry) => entry.id === thread.id)?.pinnedAt).toBeTruthy()
    const settled = await listsAfter(seen, () => backend.execute('threads.settle' as never, { threadId: thread.id, settled: true }))
    expect(settled).toHaveLength(1)
    // The delete's reply carries the trash's file identity, which an NTFS file id can push past what the phone's JSON
    // allows; what is checked here is the push, made before the reply is encoded.
    const deleted = await listsAfter(seen, () => backend.execute('threads.delete' as never, { threadId: thread.id }).catch(() => undefined))
    expect(deleted.length).toBeGreaterThanOrEqual(1)
    expect(deleted.at(-1)!.some((entry) => entry.id === thread.id)).toBe(false)
  })

  it("tells windows of a change only the service bus announced, and of a store write with no request", async () => {
    const quiet = mms.threads.createThread('Quiet', undefined, undefined, { started: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const bus = await listsAfter(seen, async () => { mms.events.broadcast('threads:updated', mms.threads.listAllThreads()) })
    expect(bus).toHaveLength(1)
    const store = await listsAfter(seen, async () => { mms.threads.setThreadPinned(quiet.id, true) })
    expect(store).toHaveLength(1)
    expect(store[0].find((entry) => entry.id === quiet.id)?.pinnedAt).toBeTruthy()
  })

  it('sends a save that moved only a thread time as a small, throttled push, and at once when a turn ends', async () => {
    const thread = mms.threads.createThread('Busy', undefined, undefined, { started: true })
    const message = (id: string) => ({ id, role: 'assistant' as const, content: id, timestamp: new Date().toISOString() })
    mms.threads.saveThreadData(thread.id, { messages: [message('m1')], agents: [], tasks: [] })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const from = seen.length
    const lists = () => seen.slice(from).filter((event) => event.type === 'threads.updated').length
    const touches = () => seen.slice(from).filter((event) => event.type === 'threads.touched').map((event) => (event.data as { touches: Array<{ id: string; updatedAt: string }> }).touches)
    mms.threads.saveThreadData(thread.id, { messages: [message('m1'), message('m2')], agents: [], tasks: [] })
    await vi.waitFor(() => expect(touches().length).toBe(1), { timeout: 2000 })
    expect(touches()[0]).toEqual([{ id: thread.id, updatedAt: mms.threads.getThread(thread.id)!.updatedAt }])
    // More saves within the interval wait: no second push yet, and never the whole list.
    await new Promise((resolve) => setTimeout(resolve, 20))
    mms.threads.saveThreadData(thread.id, { messages: [message('m1'), message('m2'), message('m3')], agents: [], tasks: [] })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(touches().length).toBe(1)
    // The turn ends: its held time goes out at once.
    mms.orchestrator.emit('turn-completed', { threadId: thread.id })
    await vi.waitFor(() => expect(touches().length).toBe(2), { timeout: 1000 })
    expect(touches()[1][0].updatedAt).toBe(mms.threads.getThread(thread.id)!.updatedAt)
    expect(lists()).toBe(0)
  })

  it('tells windows when a chat changes, once for several changes together', async () => {
    const chats = mms.platform.chats as unknown as { changeListeners: Set<() => void> }
    const from = seen.length
    for (const listener of chats.changeListeners) listener()
    for (const listener of chats.changeListeners) listener()
    await vi.waitFor(() => expect(seen.slice(from).some((event) => event.type === 'chats.changed')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen.slice(from).filter((event) => event.type === 'chats.changed')).toHaveLength(1)
    expect(seenByOther.some((event) => event.type === 'chats.changed')).toBe(true)
  })
})
