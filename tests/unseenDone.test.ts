/**
 * Done means "finished, and nobody has seen it": a thread that finishes shows Done until a window opens it, the
 * mark outlives a service restart, clearing it in one window clears it in every window, and none of it moves the
 * thread in the list.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { UNSEEN_DONE_FILE } from '../src/mms/runtime/UnseenDoneStore'
import type { Thread, ThreadActivitySnapshot } from '../src/shared/types'

describe('Done until seen', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string
  const open: LocalMmsClient[] = []

  async function startService(): Promise<void> {
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  }

  async function stopService(): Promise<void> {
    for (const client of open.splice(0)) await client.close().catch(() => undefined)
    await server.stop()
    await mms.stop()
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-unseen-done-'))
    process.env.MOUSSE_HOME = home
    await startService()
  })

  afterEach(async () => {
    await stopService()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* Windows EPERM when handles linger */
    }
    delete process.env.MOUSSE_HOME
  })

  /** A window: a GUI connection that keeps the last status map it was sent. */
  async function window(): Promise<{ client: LocalMmsClient; activity: () => ThreadActivitySnapshot }> {
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    await client.connect()
    let latest: ThreadActivitySnapshot = {}
    client.onEvent((event) => {
      if (event.type !== 'activity' && event.type !== 'activity.snapshot') return
      const activity = (event.data as { activity?: ThreadActivitySnapshot } | null)?.activity
      if (activity) latest = activity
    })
    await client.subscribe(0)
    open.push(client)
    return { client, activity: () => latest }
  }

  /** What the orchestrator does when a turn runs and ends. */
  function finishTurn(threadId: string): void {
    mms.threadRuntimes.setActivity(threadId, 'processing')
    mms.threadRuntimes.setActivity(threadId, 'completed')
  }

  /** The threads marked Done in the profile's file (the profile home is a folder of the installation home). */
  const marked = (): string[] => {
    const found = (readdirSync(home, { recursive: true }) as string[]).find((path) => path.endsWith(UNSEEN_DONE_FILE))
    return found ? (JSON.parse(readFileSync(join(home, found), 'utf-8')) as { threads: string[] }).threads : []
  }

  it('shows Done for a thread that finished in the background until a window opens it', async () => {
    const thread = mms.threads.createThread('Background')
    const { client, activity } = await window()
    finishTurn(thread.id)
    await vi.waitFor(() => expect(activity()[thread.id]).toBe('completed'))
    expect(marked()).toEqual([thread.id])

    await expect(client.request('threads.markSeen', { threadId: thread.id })).resolves.toEqual({ seen: true })
    await vi.waitFor(() => expect(activity()[thread.id]).toBe('idle'))
    expect(marked()).toEqual([])
    expect((await client.request<{ activity: ThreadActivitySnapshot }>('activity.snapshot')).activity[thread.id]).toBe('idle')
    // Seen again: nothing to clear.
    await expect(client.request('threads.markSeen', { threadId: thread.id })).resolves.toEqual({ seen: false })
  })

  it('keeps every unseen Done across a service restart', async () => {
    const unseen = mms.threads.createThread('Unseen')
    const seen = mms.threads.createThread('Seen')
    finishTurn(unseen.id)
    finishTurn(seen.id)
    mms.threadRuntimes.markSeen(seen.id)
    await stopService()

    await startService()
    const { client } = await window()
    const after = (await client.request<{ activity: ThreadActivitySnapshot }>('activity.snapshot')).activity
    expect(after[unseen.id]).toBe('completed')
    expect(after[seen.id] ?? 'idle').toBe('idle')

    await client.request('threads.markSeen', { threadId: unseen.id })
    await stopService()
    await startService()
    const { client: reopened } = await window()
    expect((await reopened.request<{ activity: ThreadActivitySnapshot }>('activity.snapshot')).activity[unseen.id] ?? 'idle').toBe('idle')
  })

  it('clears Done in every window when one window sees the thread', async () => {
    const thread = mms.threads.createThread('Shared')
    const first = await window()
    const second = await window()
    finishTurn(thread.id)
    await vi.waitFor(() => {
      expect(first.activity()[thread.id]).toBe('completed')
      expect(second.activity()[thread.id]).toBe('completed')
    })
    await first.client.request('threads.markSeen', { threadId: thread.id })
    await vi.waitFor(() => expect(second.activity()[thread.id]).toBe('idle'))
  })

  it('does not move the thread or its list when Done is set or cleared', async () => {
    const older = mms.threads.createThread('Older')
    const newer = mms.threads.createThread('Newer')
    const { client } = await window()
    const listed = async () => await client.request<{ threads: Thread[] }>('threads.list', {})
    const before = await listed()
    const lists: unknown[] = []
    client.onEvent((event) => {
      if (event.type === 'threads.updated') lists.push(event.data)
    })

    finishTurn(older.id)
    await client.request('threads.markSeen', { threadId: older.id })
    // A list push would arrive soon after the change it follows.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const after = await listed()
    expect(after.threads.map((thread) => [thread.id, thread.updatedAt])).toEqual(before.threads.map((thread) => [thread.id, thread.updatedAt]))
    // No list was pushed to the windows for it.
    expect(lists).toEqual([])
    expect(after.threads.map((thread) => thread.id).indexOf(newer.id)).toBe(before.threads.map((thread) => thread.id).indexOf(newer.id))
  })

  it('clears a subagent\'s Done with its parent, whose row shows it rolled up', async () => {
    const parent = mms.threads.createThread('Parent')
    const child = mms.threads.createThread('Child', undefined, undefined, {
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' }
    })
    const other = mms.threads.createThread('Other')
    finishTurn(child.id)
    finishTurn(other.id)
    expect(marked().sort()).toEqual([child.id, other.id].sort())

    expect(mms.threadRuntimes.markSeen(parent.id)).toBe(true)
    expect(mms.threadRuntimes.getActivity(child.id)).toBe('idle')
    expect(marked()).toEqual([other.id])
  })

  it('drops the mark when the next turn starts, and keeps Done off a thread whose work still runs', async () => {
    const thread = mms.threads.createThread('Again')
    finishTurn(thread.id)
    mms.threadRuntimes.setActivity(thread.id, 'processing')
    expect(marked()).toEqual([])
    mms.threadRuntimes.setActivity(thread.id, 'idle')
    expect(marked()).toEqual([])

    // A turn that ends while its delegated work still runs is Waiting, not Done; seeing it changes nothing.
    mms.threadRuntimes.setActivity(thread.id, 'processing')
    mms.threadRuntimes.setPendingDelegations(thread.id, true)
    mms.threadRuntimes.setActivity(thread.id, 'completed')
    expect(mms.threadRuntimes.getActivity(thread.id)).toBe('waiting')
    expect(mms.threadRuntimes.markSeen(thread.id)).toBe(false)
    mms.threadRuntimes.setPendingDelegations(thread.id, false)
    expect(mms.threadRuntimes.getActivity(thread.id)).toBe('completed')
    expect(marked()).toEqual([thread.id])
  })

  it('never marks a personal bot\'s chat', () => {
    const thread = mms.threads.createThread('Bot chat')
    mms.threads.markBotOwned([thread.id])
    finishTurn(thread.id)
    expect(marked()).toEqual([])
  })
})
