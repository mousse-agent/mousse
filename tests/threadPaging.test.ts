import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import { messagesAfter, messagesBefore, newestPage } from '../src/mms/protocol/transcriptPaging'
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

  it('measures a page by the JSON it returns, long text kept in blobs included', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-paging-blob-')))
    try {
      client.callSync('create', other)
      store.save(other, { messages: [0, 1, 2].map((i) => message(`b${i}`, `${i}`.repeat(200_000))) })
      const page = await client.call('page', other, { limit: 3, maxBytes: 300_000 })
      expect(ids(page.messages)).toEqual(['b2'])
      expect(page.earlier).toEqual({ before: 'b2', count: 2 })
      const one = await client.call('page', other, { limit: 3, maxBytes: 1 })
      expect(one.messages[0]!.length).toBeGreaterThan(200_000)
    } finally {
      client.quiesce(other)
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('pages through a transcript whose ids repeat, one message at a time, without skipping or cycling', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-paging-dup-')))
    try {
      client.callSync('create', other)
      const list = [message('a', 'a'), message('d', 'first d'), message('x', 'x'), message('d', 'second d'), message('y', 'y')]
      store.save(other, { messages: list })
      const contents = (payloads: string[]) => payloads.map((payload) => (JSON.parse(payload) as ChatMessage).content)
      let page = await client.call('page', other, { limit: 1, maxBytes: 1_000_000 })
      const seen = contents(page.messages)
      for (let step = 0; page.earlier && step < 10; step++) {
        page = await client.call('page', other, { before: page.earlier.before, limit: 1, maxBytes: 1_000_000 })
        seen.unshift(...contents(page.messages))
      }
      expect(seen).toEqual(['a', 'first d', 'x', 'second d', 'y'])
      // Forward from the first copy reaches the second one too.
      let forward = await client.call('page', other, { after: 'a', limit: 1, maxBytes: 1_000_000 })
      const ahead = contents(forward.messages)
      for (let step = 0; forward.later && step < 10; step++) {
        forward = await client.call('page', other, { after: forward.later.after, limit: 1, maxBytes: 1_000_000 })
        ahead.push(...contents(forward.messages))
      }
      expect(ahead).toEqual(['first d', 'x', 'second d', 'y'])
      // The loaded transcript pages the same way.
      const loaded = store.load(other).messages
      let shown = newestPage(loaded, 1, 1_000_000)
      const fromMemory = shown.messages.map((m) => m.content)
      for (let step = 0; shown.earlier && step < 10; step++) {
        shown = messagesBefore(loaded, shown.earlier.before, 1, 1_000_000)!
        fromMemory.unshift(...shown.messages.map((m) => m.content))
      }
      expect(fromMemory).toEqual(['a', 'first d', 'x', 'second d', 'y'])
      expect(messagesAfter(loaded, 'a', 10, 1_000_000)!.messages.map((m) => m.content)).toEqual(['first d', 'x', 'second d', 'y'])
    } finally {
      client.quiesce(other)
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('counts repeated ids among visible messages, so a cursor works in a loaded transcript too', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-paging-hidden-dup-')))
    try {
      client.callSync('create', other)
      store.save(other, { messages: [message('a', 'a'), message('d', 'hidden d', { hidden: true }), message('x', 'x'), message('d', 'shown d'), message('y', 'y')] })
      const newest = await client.call('page', other, { limit: 2, maxBytes: 1_000_000 })
      // Only one visible message has id d, so its cursor is the bare id.
      expect(newest.earlier?.before).toBe('d')
      const cursor = newest.earlier!.before
      const visible = store.load(other).messages.filter((m) => !m.hidden)
      // The same cursor, in the database and in the loaded transcript, names the same message.
      expect(messagesBefore(visible, cursor, 1, 1_000_000)!.messages.map((m) => m.content)).toEqual(['x'])
      const fromDb = await client.call('page', other, { before: cursor, limit: 1, maxBytes: 1_000_000 })
      expect(fromDb.messages.map((payload) => (JSON.parse(payload) as ChatMessage).content)).toEqual(['x'])
      const back = await client.call('page', other, { before: fromDb.earlier!.before, limit: 5, maxBytes: 1_000_000 })
      expect(back.messages.map((payload) => (JSON.parse(payload) as ChatMessage).content)).toEqual(['a'])
    } finally {
      client.quiesce(other)
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('reports a message hidden since as removed, and one removed and written again as present', async () => {
    const seq = store.info(dir).seq
    const loaded = store.load(dir).messages
    loaded[98] = { ...loaded[98]!, hidden: true }
    store.save(dir, { messages: loaded.filter((m) => m.id !== 'm97') })
    const again = store.load(dir).messages
    store.save(dir, { messages: [...again.slice(0, 96), message('m97', 'written again'), ...again.slice(96)] })
    const changes = await client.call('messageChanges', dir, seq)
    expect(changes.removed).toEqual(['m98'])
    expect(changes.messages.map((row) => (JSON.parse(row.payload) as ChatMessage).content)).toEqual(['written again'])
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

  it('settles work a previous daemon left running before a page shows it', async () => {
    const thread = mms.threads.createThread('Interrupted', undefined, undefined, { started: true })
    const compaction = message('c1', '', { role: 'assistant', kind: 'context_compaction', streaming: true } as Partial<ChatMessage>)
    mms.threads.mutateThreadData(thread.id, () => ({ messages: [...transcript(20), compaction] }))
    const snapshot = await dispatchMethod(ctx(), 'thread.snapshot', { threadId: thread.id, newest: 5 }) as { messages: ChatMessage[] }
    const row = snapshot.messages.find((m) => m.id === 'c1')!
    expect(row.streaming).not.toBe(true)
  })

  it('does not load a thread with nothing queued when the daemon starts', async () => {
    const thread = mms.threads.createThread('Idle', undefined, undefined, { started: true })
    mms.threads.mutateThreadData(thread.id, () => ({ messages: transcript(50) }))
    await mms.stop()
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(mms.orchestrator.hasSession(thread.id)).toBe(false)
  })

  it('answers a snapshot without newest with the whole visible transcript', async () => {
    const thread = mms.threads.createThread('Whole', undefined, undefined, { started: true })
    mms.threads.mutateThreadData(thread.id, () => ({ messages: transcript(30) }))
    const snapshot = await dispatchMethod(ctx(), 'thread.snapshot', { threadId: thread.id }) as { messages: ChatMessage[]; earlier?: unknown }
    expect(snapshot.messages).toHaveLength(27)
    expect(snapshot.earlier).toBeUndefined()
  })
})
