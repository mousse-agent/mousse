import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
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
    rmSync(home, { recursive: true, force: true })
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
    expect(others.at(-1)?.data).toEqual({ threads: lists[0] })
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
