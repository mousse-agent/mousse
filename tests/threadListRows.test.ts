/**
 * A change to one thread reaches a window as that thread's row (`threads.row`), not as the whole list, so a turn's end
 * costs one row whatever the number of threads. A session that cannot apply rows still gets the whole list; a
 * personal bot's threads reach no window at all.
 */
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { THREAD_ROWS_CAPABILITY } from '../src/mms/protocol/types'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread, ThreadListVersion } from '../src/shared/types'

type Event = { type: string; data?: unknown; threadId?: string; sequence?: number }
type Row = { thread?: Thread; removed?: string; version: ThreadListVersion }

const THREADS = 30

describe('a change to one thread reaches windows as one row', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let endpoint: Awaited<ReturnType<MmsProtocolServer['start']>>
  let ownerToken: string
  let rows: LocalMmsClient
  let lists: LocalMmsClient
  let seenByRows: Event[]
  let seenByLists: Event[]
  let threads: Thread[]

  const client = (capabilities?: string[]) =>
    new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui', ...(capabilities ? { requestedCapabilities: capabilities } : {}) })

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-list-rows-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    endpoint = await server.start()
    threads = Array.from({ length: THREADS }, (_, index) => mms.threads.createThread(`Thread ${index}`, undefined, undefined, { started: true }))
    seenByRows = []
    seenByLists = []
    // A window of this version asks for rows; one of an older version does not.
    rows = client([ERROR_INFO_CAPABILITY, THREAD_ROWS_CAPABILITY])
    lists = client()
    rows.onEvent((event) => seenByRows.push(event as Event))
    lists.onEvent((event) => seenByLists.push(event as Event))
    for (const each of [rows, lists]) {
      await each.connect()
      await each.subscribe()
    }
    // The creates' own pushes go out first.
    await new Promise((resolve) => setTimeout(resolve, 300))
  }, 60_000)

  afterEach(async () => {
    await rows?.close()
    await lists?.close()
    await server?.stop()
    await mms?.stop()
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows can hold a thread database open a moment after stop; the temporary folder is left behind.
    }
    delete process.env.MOUSSE_HOME
  })

  const after = async (run: () => unknown): Promise<{ rows: Event[]; lists: Event[] }> => {
    const fromRows = seenByRows.length
    const fromLists = seenByLists.length
    await run()
    // Pushes go out after the turn of the event loop that made the change; wait well past it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const listEvents = (events: Event[]) => events.filter((event) => event.type === 'threads.updated' || event.type === 'threads.row')
    return { rows: listEvents(seenByRows.slice(fromRows)), lists: listEvents(seenByLists.slice(fromLists)) }
  }
  /** Thread rows an event carries: the whole list's, or one. */
  const rowsSent = (events: Event[]) => events.reduce((sum, event) => sum + (event.type === 'threads.row' ? 1 : (event.data as { threads: Thread[] }).threads.length), 0)

  it("sends a turn's end as that thread's row, the same row the whole list has, newer than the list before it", async () => {
    const before = await rows.request<{ threads: Thread[]; version: ThreadListVersion }>('threads.list', {})
    const thread = threads[7]
    const pushed = await after(() => {
      mms.threads.setThreadLastReply(thread.id, 'All done')
      mms.threads.setThreadLastRun(thread.id, 'done')
    })
    expect(pushed.rows.map((event) => event.type)).toEqual(['threads.row'])
    expect(rowsSent(pushed.rows)).toBe(1)
    const row = pushed.rows[0].data as Row
    expect(row.thread).toMatchObject({ id: thread.id, lastReply: 'All done', lastRun: 'done' })
    expect(row.version.epoch).toBe(before.version.epoch)
    expect(row.version.seq).toBeGreaterThan(before.version.seq)
    // A window that cannot apply rows gets the whole list, which holds that same row.
    expect(pushed.lists.map((event) => event.type)).toEqual(['threads.updated'])
    expect(rowsSent(pushed.lists)).toBeGreaterThanOrEqual(THREADS)
    const whole = (pushed.lists[0].data as { threads: Thread[] }).threads
    expect(whole.find((entry) => entry.id === thread.id)).toEqual(row.thread)
  })

  it('sends a thread that left the list as its removal, and changes to several threads as the whole list', async () => {
    const thread = threads[2]
    // An archive and a pin of two threads in one turn of the event loop: the whole list, as before.
    const both = await after(() => {
      mms.threads.setThreadPinned(threads[3].id, true)
      mms.threads.setThreadPinned(threads[4].id, true)
    })
    expect(both.rows.map((event) => event.type)).toEqual(['threads.updated'])
    const trashed = await after(() => mms.threads.discardUnusedThread(thread.id))
    expect(trashed.rows).toEqual([expect.objectContaining({ type: 'threads.row', data: expect.objectContaining({ removed: thread.id }) })])
  })

  it("sends no window a personal bot's thread changes, and tells windows once when a listed thread becomes a bot's", async () => {
    const bot = mms.threads.ensureExecutionThread('bot:helper', 'Helper', undefined, undefined, { botOwned: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const quiet = await after(() => {
      mms.threads.setThreadLastReply(bot.id, 'A bot reply')
      mms.threads.setThreadLastRun(bot.id, 'done')
    })
    expect(quiet).toEqual({ rows: [], lists: [] })
    const marked = await after(() => mms.threads.markBotOwned([threads[9].id]))
    expect(marked.rows).toEqual([expect.objectContaining({ type: 'threads.row', data: expect.objectContaining({ removed: threads[9].id }) })])
    expect(marked.rows[0].data).not.toHaveProperty('thread')
    // The window holding whole lists is sent one without it.
    expect((marked.lists.at(-1)!.data as { threads: Thread[] }).threads.some((entry) => entry.id === threads[9].id)).toBe(false)
    const later = await after(() => mms.threads.setThreadLastRun(threads[9].id, 'done'))
    expect(later).toEqual({ rows: [], lists: [] })
  })

  it("reads no thread list for a thread's activity", async () => {
    const services = await mms.getProfileServices(mms.profileId)
    services.threadRuntimes.emit('activity', { threadId: threads[0].id, state: 'working', activity: { [threads[0].id]: 'working' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const listAll = vi.spyOn(mms.threads, 'listAllThreads')
    for (let index = 0; index < 50; index += 1) {
      const threadId = threads[index % THREADS].id
      services.threadRuntimes.emit('activity', { threadId, state: index % 2 ? 'working' : 'idle', activity: { [threadId]: 'working' } })
    }
    expect(listAll).not.toHaveBeenCalled()
  })

  it("replays to a window that cannot apply rows the whole list once, not a list per row", async () => {
    const from = (await lists.request<{ sequence?: number }>('events.subscribe', { afterSequence: 0 })).sequence ?? 0
    await after(() => mms.threads.setThreadLastReply(threads[0].id, 'One'))
    await after(() => mms.threads.setThreadLastReply(threads[1].id, 'Two'))
    const late = client()
    await late.connect()
    const replay = (await late.subscribe(from)).replay.filter((event) => event.type === 'threads.updated' || event.type === 'threads.row')
    await late.close()
    expect(replay.map((event) => event.type)).toEqual(['threads.updated'])
    const whole = (replay[0].data as { threads: Thread[] }).threads
    expect(whole.find((entry) => entry.id === threads[1].id)?.lastReply).toBe('Two')
  })
})
