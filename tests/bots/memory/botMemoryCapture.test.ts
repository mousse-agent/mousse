import { afterEach, describe, expect, it } from 'vitest'
import { BotJournalError, BotMemoryStore } from '../../../src/mms/bots/memory/BotMemoryStore'
import { botThreadsForCatchUp, createBotJournal, type BotThreadRef } from '../../../src/mms/bots/memory/capture'
import type { ChatMessage } from '../../../src/shared/types'
import { disposeFixtures, memoryFixture, type MemoryFixture } from './memoryFixture'

/**
 * Capture (bot-context.md §4): every dispatch's assistant and tool rows reach the journal, through
 * `loadThreadData`, once each, from a per-thread cursor, and after a crash by the startup catch-up.
 */

afterEach(disposeFixtures)

const at = (n: number) => new Date(Date.parse('2026-11-07T10:00:00.000Z') + n * 1000).toISOString()

function threads() {
  const data = new Map<string, ChatMessage[]>()
  const reads: string[] = []
  return {
    data,
    reads,
    readThread: (threadId: string) => {
      reads.push(threadId)
      return { messages: structuredClone(data.get(threadId) ?? []) }
    }
  }
}

const user = (id: string, content: string, n = 0): ChatMessage => ({ id, role: 'user', content, timestamp: at(n) })
const assistant = (id: string, content: string, n = 0): ChatMessage => ({ id, role: 'assistant', content, timestamp: at(n) })
const toolCall = (id: string, toolName: string, input: Record<string, unknown>, response?: string, status: 'processing' | 'complete' = 'complete', n = 0): ChatMessage => ({
  id, role: 'assistant', kind: 'tool_call', content: '', timestamp: at(n),
  toolCall: { title: toolName, summary: '', details: [], toolName, input, status, ...(response === undefined ? {} : { response }) }
})

function setup(fx: MemoryFixture, refs: BotThreadRef[] = []) {
  const t = threads()
  const logged: string[] = []
  const journal = createBotJournal({ store: fx.store, readThread: t.readThread, listThreads: () => refs, log: (message) => logged.push(message) })
  return { t, journal, logged }
}

const kinds = (fx: MemoryFixture, botId = 'ada') => fx.store.journal(botId).map((row) => [row.kind, row.who, row.text])

describe('syncThread', () => {
  it('copies the prompt, assistant text, tool calls with input and result heads; skips presentation rows', async () => {
    const fx = memoryFixture()
    const { t, journal } = setup(fx)
    t.data.set('run-1', [
      user('u1', 'Find three AI headlines'),
      { id: 'th', role: 'assistant', kind: 'thinking', content: 'hidden reasoning', timestamp: at(1), thinking: { content: 'hidden reasoning' } },
      toolCall('c1', 'web_search', { query: 'AI news' }, 'Result A\nResult B', 'complete', 2),
      { id: 'p', role: 'assistant', kind: 'progress', content: 'working…', timestamp: at(3) },
      assistant('a1', 'Here are three headlines.', 4)
    ])
    await journal.syncThread({ botId: 'ada', threadId: 'run-1', lane: 'run', activationId: 'act-1' })
    expect(kinds(fx)).toEqual([
      ['notice', 'mousse', 'Find three AI headlines'],
      ['tool_call', 'bot', 'web_search {"query":"AI news"}'],
      ['tool_result', 'tool', 'Result A\nResult B'],
      ['bot_msg', 'bot', 'Here are three headlines.']
    ])
    const [, call, result] = fx.store.journal('ada')
    expect(call).toMatchObject({ sourceKey: 'run-1:c1', lane: 'run', activationId: 'act-1', threadId: 'run-1', at: at(2), external: false, json: { tool: 'web_search', input: { query: 'AI news' } } })
    expect(result).toMatchObject({ sourceKey: 'run-1:c1:result', external: true })
    expect(fx.store.search('ada', { query: 'headlines', kinds: ['run'] }).map((hit) => hit.ref).sort()).toEqual(['j1', 'j4'])
    expect(fx.store.search('ada', { query: 'headlines', kinds: ['chat'] })).toEqual([])
  })

  it('is idempotent, and its cursor copies only what is new', async () => {
    const fx = memoryFixture()
    const { t, journal } = setup(fx)
    t.data.set('home', [user('u1', 'hi'), assistant('a1', 'Hello!')])
    const ref = { botId: 'ada', threadId: 'home', lane: 'chat' as const, activationId: 'act-1' }
    expect(journal.syncNow(ref)).toBe(2)
    expect(journal.syncNow(ref)).toBe(0)
    await journal.syncThread(ref)
    expect(fx.store.journal('ada')).toHaveLength(2)
    expect(fx.store.getState('ada', 'cursor:home')).toEqual({ n: 2, lastId: 'a1' })
    t.data.get('home')!.push(user('u2', 'and now?'), assistant('a2', 'Now this.'))
    expect(journal.syncNow({ ...ref, activationId: 'act-2' })).toBe(2)
    expect(fx.store.journal('ada').map((row) => [row.sourceKey, row.activationId])).toEqual([
      ['home:u1', 'act-1'], ['home:a1', 'act-1'], ['home:u2', 'act-2'], ['home:a2', 'act-2']
    ])
  })

  it('a rewritten transcript is copied again from the start without duplicates', () => {
    const fx = memoryFixture()
    const { t, journal } = setup(fx)
    const ref = { botId: 'ada', threadId: 'home', lane: 'chat' as const }
    t.data.set('home', [user('u1', 'one'), assistant('a1', 'two')])
    journal.syncNow(ref)
    // The cursor's message is no longer where it was: everything is looked at again, and only new rows are added.
    t.data.set('home', [user('u1', 'one'), user('x1', 'other'), assistant('a1', 'two'), assistant('a3', 'three')])
    expect(journal.syncNow(ref)).toBe(4)
    expect(fx.store.journal('ada').map((row) => row.sourceKey)).toEqual(['home:u1', 'home:a1', 'home:x1', 'home:a3'])
    expect(fx.store.getState('ada', 'cursor:home')).toEqual({ n: 4, lastId: 'a3' })
  })

  it('an unreadable thread is logged and retried, not a journal failure', async () => {
    const fx = memoryFixture()
    const logged: string[] = []
    const journal = createBotJournal({ store: fx.store, readThread: () => { throw new Error('EIO') }, listThreads: () => [], log: (message) => logged.push(message) })
    await expect(journal.syncThread({ botId: 'ada', threadId: 'home', lane: 'chat', activationId: 'act' })).resolves.toBeUndefined()
    expect(logged).toEqual(['bot memory: thread home could not be read for capture'])
    expect(fx.store.getState('ada', 'cursor:home')).toBeUndefined()
  })

  it('a journal that cannot be written fails with bot_journal_failed', async () => {
    const fx = memoryFixture()
    const full = new BotMemoryStore({
      db: {
        inTransaction: false,
        transaction: (work) => fx.db.transaction(work),
        statement: (sql) => {
          if (sql.startsWith('INSERT INTO bot_journal(')) throw new Error('database or disk is full')
          return fx.db.statement(sql)
        }
      },
      checkIndexes: false
    })
    const journal = createBotJournal({ store: full, readThread: () => ({ messages: [assistant('a1', 'done')] }), listThreads: () => [] })
    await expect(journal.syncThread({ botId: 'ada', threadId: 'home', lane: 'chat', activationId: 'act' })).rejects.toBeInstanceOf(BotJournalError)
    expect(fx.store.getState('ada', 'cursor:home')).toBeUndefined()
  })
})

describe('crash catch-up', () => {
  it('after a kill mid-dispatch, catchUp copies every bot thread past its cursor and finishes partial rows once', async () => {
    const fx = memoryFixture()
    const refs = botThreadsForCatchUp([
      { threadId: 'home', botId: 'ada', role: 'home', activationId: null },
      { threadId: 'run-1', botId: 'ada', role: 'activation', activationId: 'act-1' },
      { threadId: 'bob-home', botId: 'bob', role: 'home', activationId: null }
    ])
    expect(refs.map((ref) => ref.lane)).toEqual(['chat', 'run', 'chat'])
    const { t, journal } = setup(fx, refs)
    // The dispatch on run-1 was copied once while its fetch was still running…
    t.data.set('run-1', [user('u1', 'Check the feed'), toolCall('c1', 'web_fetch', { url: 'https://example.com' }, undefined, 'processing', 1)])
    journal.syncNow(refs[1]!)
    expect(fx.store.getState('ada', 'cursor:run-1')).toEqual({ n: 1, lastId: 'u1' })
    expect(fx.store.journal('ada')[1]).toMatchObject({ kind: 'tool_call', json: expect.objectContaining({ partial: true }) })
    // …then the daemon died: the call finished and the bot replied, and nobody ran afterDispatch.
    t.data.set('run-1', [user('u1', 'Check the feed'), toolCall('c1', 'web_fetch', { url: 'https://example.com' }, 'Feed body', 'complete', 1), assistant('a1', 'The feed has 3 new posts.', 2)])
    t.data.set('home', [assistant('h1', 'Morning!')])
    t.data.set('bob-home', [assistant('b1', 'Bob here')])
    await journal.catchUp()
    expect(fx.store.journal('ada').filter((row) => row.threadId === 'run-1').map((row) => [row.kind, row.who, row.text])).toEqual([
      ['notice', 'mousse', 'Check the feed'],
      ['tool_call', 'bot', 'web_fetch {"url":"https://example.com"}'],
      ['tool_result', 'tool', 'Feed body'],
      ['bot_msg', 'bot', 'The feed has 3 new posts.']
    ])
    expect(fx.store.journal('ada').filter((row) => row.threadId === 'home').map((row) => [row.lane, row.text])).toEqual([['chat', 'Morning!']])
    expect(fx.store.journal('ada')[1]!.json).not.toHaveProperty('partial')
    expect(kinds(fx, 'bob')).toEqual([['bot_msg', 'bot', 'Bob here']])
    // Running it again adds nothing.
    const before = fx.store.journal('ada').length
    await journal.catchUp()
    expect(fx.store.journal('ada')).toHaveLength(before)
    expect(fx.store.getState('ada', 'cursor:run-1')).toEqual({ n: 3, lastId: 'a1' })
  })

  it('nothing is lost: owner and bot messages, run reports, asks, answers, tool calls and model changes are all in the journal', async () => {
    const fx = memoryFixture()
    const { t, journal } = setup(fx)
    fx.message({ botId: 'ada', id: 'o1', author: 'owner', text: 'Tidy ~/Notes please', activationId: 'act-1' })
    fx.store.append({ botId: 'ada', kind: 'ask', lane: 'chat', activationId: 'act-1', sourceKey: 'bm:ask-1', who: 'bot', text: 'change files in ~/Notes', json: { askId: 'ask-1' } })
    fx.store.append({ botId: 'ada', kind: 'answer', lane: 'chat', activationId: 'act-1', sourceKey: 'ask:ask-1:answer', who: 'owner', text: 'allow' })
    fx.store.append({ botId: 'ada', kind: 'model_change', activationId: 'act-1', sourceKey: 'act:act-1:model:1', who: 'mousse', text: 'deeper' })
    t.data.set('home', [toolCall('c1', 'edit', { path: '/home/o/Notes/a.md', old: 'x', new: 'y' }, 'ok'), assistant('a1', 'Tidied 3 notes.')])
    await journal.syncThread({ botId: 'ada', threadId: 'home', lane: 'chat', activationId: 'act-1' })
    fx.message({ botId: 'ada', id: 'b1', author: 'bot', text: 'Tidied 3 notes.', activationId: 'act-1' })
    fx.store.append({ botId: 'ada', kind: 'run_start', lane: 'run', activationId: 'act-2', sourceKey: 'act:act-2:start', who: 'mousse', text: 'run started', json: { scheduleId: 's1' } })
    fx.message({ botId: 'ada', id: 'r1', author: 'bot', kind: 'run_report', text: 'Three headlines today.', activationId: 'act-2' })
    const got = new Set(fx.store.journal('ada').map((row) => row.kind))
    for (const kind of ['owner_msg', 'bot_msg', 'run_report', 'ask', 'answer', 'tool_call', 'tool_result', 'model_change', 'run_start'])
      expect(got.has(kind as never)).toBe(true)
    expect(fx.store.journal('ada').find((row) => row.kind === 'tool_call')?.json).toMatchObject({ input: { path: '/home/o/Notes/a.md' } })
    // A model change is in the record but never in search, so the bot never sees model names.
    expect(fx.store.search('ada', { query: 'deeper' })).toEqual([])
  })
})

describe('review round 2', () => {
  it('a memory call is copied by its refs only: no saved text, query or reason, and no result', async () => {
    const fx = memoryFixture()
    const { t, journal } = setup(fx)
    t.data.set('home', [
      toolCall('c1', 'mcp__mousse__memory_save', { text: 'The owner\'s sister is called Maria Lopez.', kind: 'owner', replaces: 'm3v2' }, '{"id":"m3","version":3}'),
      toolCall('c2', 'memory_forget', { id: 'm4', refs: ['j12', 'not a ref'], reason: 'Forget that Maria Lopez is my sister' }, '{"forgotten":"m4"}'),
      toolCall('c3', 'memory_search', { query: 'Maria Lopez sister' }, '{"hits":[{"snippet":"Maria Lopez"}]}')
    ])
    await journal.syncThread({ botId: 'ada', threadId: 'home', lane: 'chat', activationId: 'act-1' })
    expect(kinds(fx)).toEqual([
      ['tool_call', 'bot', 'memory_save m3v2'],
      ['tool_call', 'bot', 'memory_forget m4 j12'],
      ['tool_call', 'bot', 'memory_search']
    ])
    expect(JSON.stringify(fx.store.journal('ada'))).not.toContain('Maria')
  })

  it('catch-up goes on past a thread it cannot copy, and returns the bots whose journal failed', async () => {
    const fx = memoryFixture()
    const full = new BotMemoryStore({
      db: {
        inTransaction: false,
        transaction: (work) => fx.db.transaction(work),
        statement: (sql) => {
          if (sql.startsWith('INSERT INTO bot_journal(') && full.failing) throw new Error('database or disk is full')
          return fx.db.statement(sql)
        }
      },
      checkIndexes: false
    }) as BotMemoryStore & { failing?: boolean }
    const logged: string[] = []
    const data: Record<string, ChatMessage[]> = { 'ada-home': [assistant('a1', 'Ada here')], 'bob-home': [assistant('b1', 'Bob here')] }
    const journal = createBotJournal({
      store: full,
      readThread: (threadId) => {
        full.failing = threadId === 'ada-home'
        return { messages: data[threadId] ?? [] }
      },
      listThreads: () => [{ botId: 'ada', threadId: 'ada-home', lane: 'chat' }, { botId: 'bob', threadId: 'bob-home', lane: 'chat' }],
      log: (message) => logged.push(message)
    })
    await expect(journal.catchUp()).resolves.toEqual({ failedBots: ['ada'] })
    expect(kinds(fx, 'bob')).toEqual([['bot_msg', 'bot', 'Bob here']])
    expect(kinds(fx, 'ada')).toEqual([])
    expect(logged).toEqual(['bot memory: thread ada-home could not be caught up'])
  })

  it('a home or context thread\'s new rows belong to the latest dispatch that ran there', () => {
    expect(botThreadsForCatchUp([
      { threadId: 'home', botId: 'ada', role: 'home', activationId: null, lastActivation: { id: 'act-chat', lane: 'chat' } },
      { threadId: 'ctx', botId: 'ada', role: 'context', activationId: null, lastActivation: { id: 'act-chat', lane: 'chat' } },
      { threadId: 'ctx-2', botId: 'ada', role: 'context', activationId: null, lastActivation: null },
      { threadId: 'run-1', botId: 'ada', role: 'activation', activationId: 'act-1', lastActivation: { id: 'act-1', lane: 'run' } }
    ])).toEqual([
      { botId: 'ada', threadId: 'home', lane: 'chat', activationId: 'act-chat' },
      { botId: 'ada', threadId: 'ctx', lane: 'chat', activationId: 'act-chat' },
      { botId: 'ada', threadId: 'ctx-2', lane: 'run', activationId: null },
      { botId: 'ada', threadId: 'run-1', lane: 'run', activationId: 'act-1' }
    ])
  })
})
