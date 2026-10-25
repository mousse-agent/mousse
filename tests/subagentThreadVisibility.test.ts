/**
 * Subagent threads in protocol thread lists (plan v3 §2.4): the datastore inventory is complete and
 * one helper decides who sees subagents. The desktop app does; the CLI, tests, unknown clients and
 * remote devices do not. Covers requests, search, mutation replies, pushed `threads.updated`
 * events (live, buffered and replayed), the orphan fallback, and channel lists.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { projectEventFor, visibleThreadsFor } from '../src/mms/protocol/threadVisibility'
import type { ProtocolClientType, ProtocolEvent } from '../src/mms/protocol/types'
import type { Thread } from '../src/shared/types'

const names = (threads: ReadonlyArray<{ name: string }>) => threads.map((thread) => thread.name).sort()

describe('subagent threads in protocol thread lists', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let ownerToken: string
  let endpoint: string
  const open: LocalMmsClient[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-visibility-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
  })

  afterEach(async () => {
    await Promise.all(open.splice(0).map((client) => client.close()))
    await server.stop()
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  async function connect(clientType: ProtocolClientType, subscribe = true): Promise<LocalMmsClient> {
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType })
    await client.connect()
    if (subscribe) await client.subscribe(0)
    open.push(client)
    return client
  }

  /** A parent with a subagent and a nested one, plus a subagent whose parent no longer exists. */
  function seed() {
    const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })
    const parent = mms.threads.createThread('Alpha parent')
    const child = mms.threads.createThread('Alpha child', undefined, undefined, { lineage: subagentOf(parent.id) })
    const grandchild = mms.threads.createThread('Alpha grandchild', undefined, undefined, { lineage: subagentOf(child.id, parent.id) })
    const orphan = mms.threads.createThread('Alpha orphan', undefined, undefined, { lineage: subagentOf('trashed-parent') })
    return { parent, child, grandchild, orphan }
  }

  const all = ['Alpha child', 'Alpha grandchild', 'Alpha orphan', 'Alpha parent']
  const shown = ['Alpha orphan', 'Alpha parent']

  it('lists subagent threads for the desktop app only, and keeps an orphan visible to everyone', async () => {
    seed()
    for (const [clientType, expected] of [['gui', all], ['cli', shown], ['test', shown], ['unknown', shown]] as const) {
      const client = await connect(clientType, false)
      const { threads } = await client.request<{ threads: Thread[] }>('threads.list')
      expect(names(threads), clientType).toEqual(expected)
    }
    // The inventory itself is untouched.
    expect(names(mms.threads.listAllThreads())).toEqual(all)
  })

  it('filters before searching so hidden threads never use up result slots', async () => {
    seed()
    const gui = await connect('gui', false)
    const cli = await connect('cli', false)
    const search = async (client: LocalMmsClient, limit: number) =>
      (await client.request<{ results: Array<{ threadName: string }> }>('threads.search', { query: 'alpha', limit })).results.map((result) => result.threadName)
    expect((await search(gui, 10)).sort()).toEqual(all)
    expect((await search(cli, 10)).sort()).toEqual(shown)
    // "Alpha child" sorts first, so a limit applied before the filter would return nothing for the CLI.
    expect(await search(gui, 1)).toEqual(['Alpha child'])
    expect(await search(cli, 1)).toEqual(['Alpha orphan'])
  })

  it('answers every thread mutation with the list the caller is allowed to see', async () => {
    const { parent } = seed()
    const gui = await connect('gui', false)
    const cli = await connect('cli', false)
    const renamed = await gui.request<{ threads: Thread[] }>('threads.rename', { threadId: parent.id, name: 'Alpha parent' })
    expect(names(renamed.threads)).toEqual(all)
    const pinned = await cli.request<{ threads: Thread[] }>('threads.pin', { threadId: parent.id, pinned: true })
    expect(names(pinned.threads)).toEqual(shown)
    const created = await cli.request<{ threads: Thread[] }>('threads.create', { name: 'Beta' })
    expect(names(created.threads)).toEqual([...shown, 'Beta'].sort())
    // A reorder names every thread of the group, hidden ones included; the reply still hides them from the CLI.
    const reordered = await cli.request<{ threads: Thread[]; all: Thread[] }>('threads.reorder', { threadIds: mms.threads.listThreads().map((thread) => thread.id) })
    expect(names(reordered.threads)).toEqual([...shown, 'Beta'].sort())
    expect(names(reordered.all)).toEqual([...shown, 'Beta'].sort())
    const deleted = await gui.request<{ threads: Thread[] }>('threads.delete', { threadId: created.threads.find((thread) => thread.name === 'Beta')!.id })
    expect(names(deleted.threads)).toEqual(all)
  })

  it('gives channels lists without subagent threads, from the same complete inventory', () => {
    seed()
    expect(names(mms.threads.listAllVisibleThreads())).toEqual(shown)
    // `/threads` and the thread menus read the store directly rather than through a protocol client.
    expect(names(mms.threads.listVisibleThreads())).toEqual(shown)
    expect(names(mms.threads.listThreads())).toEqual(all)
  })

  it('projects pushed threads.updated per client, live', async () => {
    seed()
    const gui = await connect('gui')
    const cli = await connect('cli')
    const test = await connect('test')
    const lists = new Map<string, string[][]>()
    for (const [label, client] of [['gui', gui], ['cli', cli], ['test', test]] as const) {
      lists.set(label, [])
      client.onEvent((event) => {
        if (event.type === 'threads.updated') lists.get(label)!.push(names((event.data as { threads: Thread[] }).threads))
      })
    }
    mms.threads.createThread('Alpha later')
    await vi.waitFor(() => {
      for (const label of ['gui', 'cli', 'test']) expect(lists.get(label)!.length, label).toBeGreaterThan(0)
    })
    expect(lists.get('gui')!.at(-1)).toEqual([...all, 'Alpha later'].sort())
    expect(lists.get('cli')!.at(-1)).toEqual([...shown, 'Alpha later'].sort())
    expect(lists.get('test')!.at(-1)).toEqual([...shown, 'Alpha later'].sort())
    for (const label of ['cli', 'test']) for (const list of lists.get(label)!) expect(list).not.toContain('Alpha child')
  })

  it('projects replayed threads.updated per client, before the byte budget', async () => {
    const { parent } = seed()
    // Events pushed before anyone subscribed sit in the replay ring.
    mms.threads.updateThreadMeta(parent.id, { name: 'Alpha parent' })
    const guiClient = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'gui' })
    const cliClient = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'cli' })
    await guiClient.connect()
    await cliClient.connect()
    open.push(guiClient, cliClient)
    const guiReplay = (await guiClient.subscribe(0)).replay.filter((event) => event.type === 'threads.updated')
    const cliReplay = (await cliClient.subscribe(0)).replay.filter((event) => event.type === 'threads.updated')
    expect(guiReplay.length).toBeGreaterThan(0)
    expect(cliReplay.length).toBe(guiReplay.length)
    expect(names((guiReplay.at(-1)!.data as { threads: Thread[] }).threads)).toEqual(all)
    // Each replayed event is a list as of its moment; none shows a subagent, and the last is the full visible list.
    for (const event of cliReplay) expect(names((event.data as { threads: Thread[] }).threads)).not.toContain('Alpha child')
    expect(names((cliReplay.at(-1)!.data as { threads: Thread[] }).threads)).toEqual(shown)
  })
})

describe('thread visibility helpers', () => {
  const at = '2026-10-25T10:00:00.000Z'
  const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({ id, name: id, createdAt: at, updatedAt: at, order: 0, ...extra })
  const sub = (id: string, parent: string): Thread => thread(id, { lineage: { parentThreadId: parent, rootThreadId: parent, relationship: 'subagent' } })
  const inventory = [thread('parent'), sub('child', 'parent'), sub('orphan', 'trashed')]

  it('shows subagents to the desktop app and nobody else, including a caller with no connection', () => {
    expect(visibleThreadsFor({ clientType: 'gui' }, inventory).map((entry) => entry.id)).toEqual(['parent', 'child', 'orphan'])
    for (const clientType of ['cli', 'test', 'unknown', undefined] as const)
      expect(visibleThreadsFor({ clientType }, inventory).map((entry) => entry.id), String(clientType)).toEqual(['parent', 'orphan'])
    expect(visibleThreadsFor(undefined, inventory).map((entry) => entry.id)).toEqual(['parent', 'orphan'])
  })

  it('judges a slice against the complete inventory', () => {
    const slice = [inventory[1], inventory[2]]
    expect(visibleThreadsFor({ clientType: 'cli' }, slice, inventory).map((entry) => entry.id)).toEqual(['orphan'])
  })

  it('projects only threads.updated events, and leaves the shared event alone', () => {
    const event: ProtocolEvent = { kind: 'event', sequence: 7, type: 'threads.updated', ts: at, data: { threads: inventory, extra: 1 } }
    const forCli = projectEventFor('cli', event)
    expect(forCli).not.toBe(event)
    expect(forCli).toMatchObject({ sequence: 7, type: 'threads.updated' })
    expect((forCli.data as { threads: Thread[]; extra: number }).extra).toBe(1)
    expect((forCli.data as { threads: Thread[] }).threads.map((entry) => entry.id)).toEqual(['parent', 'orphan'])
    // The ring's copy still carries the complete inventory for the next client.
    expect((event.data as { threads: Thread[] }).threads).toHaveLength(3)
    expect(projectEventFor('gui', event)).toBe(event)
    const other: ProtocolEvent = { kind: 'event', sequence: 8, type: 'turn.started', ts: at, data: {} }
    expect(projectEventFor('cli', other)).toBe(other)
    const bare: ProtocolEvent = { ...event, data: inventory }
    expect((projectEventFor('cli', bare).data as Thread[]).map((entry) => entry.id)).toEqual(['parent', 'orphan'])
  })
})
