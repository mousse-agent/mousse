import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import type { ChatMessage } from '../src/shared/types'

const message = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content, timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000).toISOString(), ...extra }) as ChatMessage

const transcript = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => message(`m${i}`, `message ${i}`, i % 10 === 5 ? { hidden: true } : {}))

describe('thread pages from thread.db', () => {
  let dir: string
  let client: ThreadDbClient
  let store: ThreadDbStore

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-paging-')))
    client = new ThreadDbClient({ script: null })
    store = new ThreadDbStore(client)
    client.callSync('create', dir)
    store.save(dir, { messages: transcript(100) })
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const ids = (payloads: string[]): string[] => payloads.map((payload) => (JSON.parse(payload) as ChatMessage).id)

  it('reads the newest page, and the pages before and after a message, without hidden messages', async () => {
    const visible = transcript(100).filter((m) => !m.hidden).map((m) => m.id)
    const newest = await client.call('page', dir, { limit: 20, maxBytes: 1_000_000 })
    expect(ids(newest.messages)).toEqual(visible.slice(-20))
    expect(newest.earlier).toEqual({ before: visible[70], count: 70 })
    expect(newest.later).toBeUndefined()
    const before = await client.call('page', dir, { before: newest.earlier!.before, limit: 10, maxBytes: 1_000_000 })
    expect(ids(before.messages)).toEqual(visible.slice(60, 70))
    expect(before.earlier?.count).toBe(60)
    const after = await client.call('page', dir, { after: visible[60]!, limit: 3, maxBytes: 1_000_000 })
    expect(ids(after.messages)).toEqual(visible.slice(61, 64))
    expect(after.later?.count).toBe(90 - 64)
    expect((await client.call('page', dir, { before: 'nope', limit: 3, maxBytes: 1 })).missing).toBe(true)
  })

  it('keeps a page within its byte budget, always returning at least one message', async () => {
    const page = await client.call('page', dir, { limit: 50, maxBytes: 1 })
    expect(page.messages).toHaveLength(1)
  })

  it('reports what changed since a sequence, removed message ids included', async () => {
    const seq = store.info(dir).seq
    const loaded = store.load(dir).messages
    loaded[98].content = 'edited'
    store.save(dir, { messages: loaded.filter((m) => m.id !== 'm97') })
    const changes = await client.call('messageChanges', dir, seq)
    expect(changes.reset).toBe(false)
    expect(changes.messages.map((row) => (JSON.parse(row.payload) as ChatMessage).content)).toEqual(['edited'])
    expect(changes.removed).toEqual(['m97'])
    expect((await client.call('messageChanges', dir, seq, changes.info.epoch + 1)).reset).toBe(true)
  })

  it('moves a database of the first format to the second when it is opened', async () => {
    client.quiesce(dir)
    const db = new DatabaseSync(join(dir, 'thread.db'))
    db.exec('ALTER TABLE items DROP COLUMN hidden; ALTER TABLE removed DROP COLUMN msg_id; PRAGMA user_version=1;')
    db.close()
    const page = await client.call('page', dir, { limit: 1000, maxBytes: 10_000_000 })
    expect(page.messages).toHaveLength(90)
  })
})

describe('opening a thread kept in thread.db', () => {
  let home: string
  let mms: MousseMainService
  const ctx = () => ({ mms, globalSequence: () => 0 })

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-paging-open-')))
    process.env.MOUSSE_HOME = home
    process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    // Startup queue recovery loads every unsettled thread's session; let it finish before the test makes threads.
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  afterEach(async () => {
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
    delete process.env.MOUSSE_SQLITE_THREAD_STORE
  })

  it('returns the newest page without loading the thread, and pages and changes from there', async () => {
    const thread = mms.threads.createThread('Long', undefined, undefined, { started: true })
    mms.threads.mutateThreadData(thread.id, () => ({ messages: transcript(500) }))
    expect(mms.orchestrator.hasSession(thread.id)).toBe(false)
    const snapshot = await dispatchMethod(ctx(), 'thread.snapshot', { threadId: thread.id, newest: 50 }) as { messages: ChatMessage[]; earlier?: { before: string; count: number }; seq: number; epoch: number }
    expect(snapshot.messages).toHaveLength(50)
    expect(snapshot.earlier?.count).toBe(450 - 50)
    expect(mms.orchestrator.hasSession(thread.id)).toBe(false)
    const page = await dispatchMethod(ctx(), 'thread.messages', { threadId: thread.id, before: snapshot.earlier!.before, limit: 25 }) as { messages: ChatMessage[]; earlier?: { count: number } }
    expect(page.messages).toHaveLength(25)
    expect(page.earlier?.count).toBe(400 - 25)
    mms.threads.mutateThreadData(thread.id, (current) => ({ messages: [...current.messages, message('m900', 'new one')] }))
    const changes = await dispatchMethod(ctx(), 'thread.changesSince', { threadId: thread.id, seq: snapshot.seq, epoch: snapshot.epoch }) as { messages: ChatMessage[]; removed: string[]; reset: boolean }
    expect(changes.reset).toBe(false)
    expect(changes.messages.map((m) => m.id)).toEqual(['m900'])
    // Once the thread is loaded (a turn, say), it answers from memory with the same page shape.
    mms.orchestrator.getOrCreateSession(thread.id)
    const loaded = await dispatchMethod(ctx(), 'thread.snapshot', { threadId: thread.id, newest: 50 }) as { messages: ChatMessage[]; earlier?: { count: number } }
    expect(loaded.messages.at(-1)!.id).toBe('m900')
    expect(loaded.earlier?.count).toBe(451 - 50)
  })

  it('answers a snapshot without newest with the whole visible transcript', async () => {
    const thread = mms.threads.createThread('Whole', undefined, undefined, { started: true })
    mms.threads.mutateThreadData(thread.id, () => ({ messages: transcript(30) }))
    const snapshot = await dispatchMethod(ctx(), 'thread.snapshot', { threadId: thread.id }) as { messages: ChatMessage[]; earlier?: unknown }
    expect(snapshot.messages).toHaveLength(27)
    expect(snapshot.earlier).toBeUndefined()
  })
})
