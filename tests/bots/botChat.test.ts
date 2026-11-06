/**
 * Bot Phase 1 §5.3.2: the owner's chat is a `chat` lane on the bot's home thread. Each chat
 * activation starts from a cleared home context plus the frozen context pack; a wall shows a card
 * on the bot's reply and its answer continues the same activation on the thread's history. Every
 * chat row is journaled in its own transaction, capture runs after every dispatch, and a journal
 * that cannot be written makes the bot stuck rather than run unrecorded (bot-context.md §4).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { name: 'Inbox Helper', reply: 'Hello, I read your inbox.' }))
})

afterEach(() => f.close())

const home = () => `thread:bot:${botId}`

/** The chat lane's activation that runs (or waits) now. */
const chatActivation = (statuses: Array<'running' | 'queued' | 'waiting_grant'> = ['running']) => f.store.laneActivations(botId, 'chat', statuses)[0]!

async function send(text: string, clientRequestId: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId })
  await flush()
  return message
}

describe('bots.chat.send', () => {
  it('runs on the home thread; each chat activation starts from a cleared context with the chat pack', async () => {
    f.cleared.length = 0
    const message = await send('What came in today?', 'm1')
    expect(message).toMatchObject({ author: 'owner', kind: 'text', text: 'What came in today?' })
    const activation = chatActivation()
    expect(activation).toMatchObject({ lane: 'chat', threadId: home(), trigger: { input: 'What came in today?' } })
    const { payload, prepared } = await start(f, activation.id)
    // Cleared while preparing, before the turn starts.
    expect(f.cleared).toEqual([home()])
    expect(prepared).toMatchObject({ history: 'cleared', lane: 'chat', preamble: `<bot_memory>chat pack ${activation.id}</bot_memory>` })
    expect(f.packs.filter((pack) => pack.activationId === activation.id)).toEqual([{ lane: 'chat', activationId: activation.id }])
    await finish(f, payload, 'completed', { text: 'Two invoices and a meeting.' })
    expect(chatOf(f, botId).slice(-2)).toMatchObject([{ author: 'owner', text: 'What came in today?' }, { author: 'bot', kind: 'text', text: 'Two invoices and a meeting.', activationId: activation.id }])
    // The next chat activation clears again.
    await send('Thanks', 'm2')
    await start(f, chatActivation().id)
    expect(f.cleared).toEqual([home(), home()])
  })

  it('a wall shows a card on the reply; after Allow the continuation keeps the thread history and the same pack', async () => {
    const docs = join(f.base, 'docs')
    mkdirSync(docs)
    writeFileSync(join(docs, 'a.md'), 'notes')
    await send('Read my notes', 'm1')
    const activation = chatActivation()
    const { payload, prepared } = await start(f, activation.id)
    // The folder named by the call is what is asked for.
    expect(prepared.authority.check({ kind: 'builtin', tool: 'list', nativeName: 'ls', args: { path: docs } })).toMatchObject({ ok: false, wall: { kind: 'escalated' } })
    expect(f.store.activation(activation.id)?.status).toBe('waiting_grant')
    await finish(f, payload, 'interrupted', { text: 'Let me look.', outcome: { interruptedBy: 'bot_wall' } })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply).toMatchObject({ author: 'bot', kind: 'text', text: 'Let me look.', ask: { title: `read files in ${docs}`, status: 'open', kind: 'permission' } })
    const { message } = await f.bots.service.answer(botId, reply.ask!.askId, 'allow')
    expect(message.ask?.status).toBe('allowed')
    await flush()
    const continuation = f.store.dispatch(activation.id, 2)!
    expect(continuation).toMatchObject({ kind: 'continue', threadId: home(), prompt: { text: `[Mousse] The owner allowed: read files in ${docs}. Continue.` } })
    const next = await start(f, activation.id, 2)
    expect(next.prepared).toMatchObject({ history: 'thread', preamble: prepared.preamble })
    // The pack was built once for the activation.
    expect(f.packs.filter((pack) => pack.activationId === activation.id)).toHaveLength(1)
    expect(next.prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(docs, 'a.md') } })).toEqual({ ok: true })
  })

  it('a message sent while the chat waits at a wall counts as Not now and continues the walled dispatch with it', async () => {
    const docs = join(f.base, 'docs')
    await send('Read my notes', 'm1')
    const activation = chatActivation()
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(docs, 'a.md') } })
    await finish(f, payload, 'interrupted', { text: '', outcome: { interruptedBy: 'bot_wall' } })
    const askId = chatOf(f, botId).at(-1)!.ask!.askId
    await send('Never mind, just say hi', 'm2')
    expect(f.store.escalation(askId)?.status).toBe('denied')
    expect(chatOf(f, botId).find((message) => message.ask?.askId === askId)?.ask?.status).toBe('not_now')
    // No new activation: the walled one goes on with the owner's message as its input.
    expect(f.store.laneActivations(botId, 'chat', ['queued', 'running', 'waiting_grant']).map((row) => row.id)).toEqual([activation.id])
    expect(f.store.dispatch(activation.id, 2)?.prompt.text).toMatch(/^\[Mousse\] The owner wrote instead of answering, so the answer is not now: read files in .*\n\nNever mind, just say hi$/)
  })

  it('each chat row and its journal row share one transaction; the owner\'s row is journaled before any dispatch starts', async () => {
    const dispatchesAtAppend: Array<{ kind: string; started: number }> = []
    const append = f.host.journal!.appendInTx.bind(f.host.journal)
    f.host.journal!.appendInTx = (tx, row) => {
      dispatchesAtAppend.push({ kind: row.kind, started: Number(f.store.get('SELECT COUNT(*) AS n FROM bot_dispatches WHERE started_at IS NOT NULL')?.n ?? 0) })
      append(tx, row)
    }
    const startedBefore = Number(f.store.get('SELECT COUNT(*) AS n FROM bot_dispatches WHERE started_at IS NOT NULL')?.n ?? 0)
    const message = await send('Hello', 'm1')
    expect(f.journal.find((row) => row.kind === 'owner_msg' && row.sourceKey === `bm:${message.id}`)).toMatchObject({ botId, who: 'owner', text: 'Hello', lane: 'chat' })
    expect(dispatchesAtAppend.find((entry) => entry.kind === 'owner_msg')?.started).toBe(startedBefore)
    await runDispatch(f, chatActivation().id, 1, { text: 'Hi!' })
    const reply = chatOf(f, botId).at(-1)!
    expect(f.journal.find((row) => row.sourceKey === `bm:${reply.id}`)).toMatchObject({ kind: 'bot_msg', who: 'bot', text: 'Hi!' })
    expect(f.outsideTx).toEqual([])
  })

  it('capture runs after every dispatch end: settled, wall, failed and stopped', async () => {
    f.afterDispatch.length = 0
    await send('one', 'm1')
    await runDispatch(f, chatActivation().id, 1, { text: 'ok' })
    await send('two', 'm2')
    const walled = chatActivation()
    const wall = await start(f, walled.id)
    wall.prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'x') } })
    await finish(f, wall.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    await f.bots.service.chatStop(botId)
    await send('three', 'm3')
    await runDispatch(f, chatActivation().id, 1, { status: 'failed', outcome: { error: 'provider_error' } })
    await send('four', 'm4')
    const stopping = chatActivation()
    const stopped = await start(f, stopping.id)
    await f.bots.service.chatStop(botId)
    await finish(f, stopped.payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
    expect(f.afterDispatch.map((entry) => entry.endedBy)).toEqual(['settled', 'wall', 'failed', 'stopped'])
    expect(f.afterDispatch.every((entry) => entry.lane === 'chat' && entry.threadId === home())).toBe(true)
    // A chat failure says so in plain words, without the provider's message.
    expect(chatOf(f, botId).some((message) => message.kind === 'error' && message.error?.text === 'Something went wrong, so I stopped. Try again.')).toBe(true)
  })

  it('a journal that cannot be written makes the bot stuck; nothing more runs until Resume', async () => {
    await send('one', 'm1')
    const first = chatActivation()
    f.journalFails.capture = true
    await runDispatch(f, first.id, 1, { text: 'ok' })
    expect(f.store.activation(first.id)).toMatchObject({ status: 'failed', endReason: 'bot_journal_failed' })
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'stuck', stateText: 'Needs you: I can\'t save my work. Free some disk space.' })
    f.journalFails.capture = false
    await send('two', 'm2')
    const queued = f.store.laneActivations(botId, 'chat', ['queued'])
    expect(queued).toHaveLength(1)
    expect(f.store.dispatch(queued[0]!.id, 1)).toBeUndefined()
    await f.bots.service.resume(botId)
    await flush()
    expect(f.store.activation(queued[0]!.id)?.status).toBe('running')
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
  })

  it('is idempotent on clientRequestId', async () => {
    const one = await send('Hello', 'same')
    const two = await send('Hello', 'same')
    expect(two.id).toBe(one.id)
    expect(chatOf(f, botId).filter((message) => message.author === 'owner')).toHaveLength(1)
    expect(f.store.listActivations(botId).filter((row) => row.idempotencyKey === 'chat:same')).toHaveLength(1)
  })
})

describe('startup', () => {
  it('catch-up runs before anything is admitted, and no schedule ticks before the startup pass', async () => {
    const g = botFixture()
    try {
      const { botId: id } = await createBot(g, { name: 'Ticker', reply: 'hi' })
      g.bots.addSchedule(id, { when: { kind: 'interval', minutes: 5 }, prompt: 'check' }, 'owner')
      const fresh = new (g.bots.constructor as new (host: typeof g.host) => typeof g.bots)(g.host)
      g.journal.length = 0
      expect(await fresh.tickSchedules(new Date(g.clock.now))).toEqual({ inserted: [] })
      expect(g.store.scheduleStates(id)).toEqual([])
      await fresh.reconcileOnStartup()
      expect(g.journal[0]).toMatchObject({ sourceKey: 'catchUp' })
      await fresh.tickSchedules(new Date(g.clock.now))
      expect(g.store.scheduleStates(id)).toHaveLength(1)
      fresh.close()
    } finally {
      g.close()
    }
  })
})

describe('bots.chat.list, chips and read markers', () => {
  it('pages with beforeSeq, shows the live chip of a working turn, and rolls the chips onto the reply', async () => {
    await send('one', 'm1')
    const activation = chatActivation()
    const { payload } = await start(f, activation.id)
    f.bots.publishActivity({ botId, activationId: activation.id, chip: { icon: 'search', text: 'searching the web', live: true } })
    expect(f.bots.service.chatList(botId).live).toEqual({ activationId: activation.id, chip: { icon: 'search', text: 'searching the web', live: true } })
    const events: unknown[] = []
    f.bots.events.on('activity', (event) => events.push(event))
    f.chips.set(payload.runId, [{ icon: 'search', text: 'searched the web · 3' }])
    await finish(f, payload, 'completed', { text: 'Found three.' })
    expect(events).toEqual([{ botId, activationId: activation.id, chip: null }])
    expect(f.bots.service.chatList(botId).live).toBeUndefined()
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: 'Found three.', chips: [{ icon: 'search', text: 'searched the web · 3' }] })
    const all = chatOf(f, botId)
    const page = f.bots.service.chatList(botId, { limit: 2 }).messages
    expect(page.map((message) => message.seq)).toEqual(all.slice(-2).map((message) => message.seq))
    const before = f.bots.service.chatList(botId, { beforeSeq: page[0]!.seq, limit: 100 }).messages
    expect(before.map((message) => message.seq)).toEqual(all.slice(0, -2).map((message) => message.seq))
  })

  it('markRead lowers the unread count', async () => {
    await send('one', 'm1')
    await runDispatch(f, chatActivation().id, 1, { text: 'reply' })
    expect(f.bots.service.get(botId).summary.unread).toBe(2)
    f.bots.service.markRead(botId, chatOf(f, botId).at(-1)!.seq)
    expect(f.bots.service.get(botId).summary.unread).toBe(0)
  })

  it('no message or summary names a model or an instance', async () => {
    await send('one', 'm1')
    await runDispatch(f, chatActivation().id, 1, { text: 'reply' })
    const payloads = JSON.stringify([f.bots.service.list(), f.bots.service.get(botId), f.bots.service.chatList(botId)])
    expect(payloads).not.toContain('some/model')
    expect(payloads).not.toContain('pi:openrouter')
  })
})
