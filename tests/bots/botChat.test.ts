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
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, runDispatch, start, type BotFixture } from './botFixture'

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
    expect(f.packs.filter((pack) => pack.activationId === activation.id)).toContainEqual({ lane: 'chat', activationId: activation.id })
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
    // Read again for the continuation: the provider keeps it frozen (a forget drops it).
    expect(next.prepared).toMatchObject({ history: 'thread', preamble: prepared.preamble })
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

  it('a message saved just before Mousse stops is still answered: its activation is queued with it', async () => {
    const continueChatWith = f.bots.continueChatWith.bind(f.bots)
    f.bots.continueChatWith = async () => { throw new Error('Mousse stopped') }
    await expect(f.bots.service.chatSend({ botId, text: 'What came in today?', clientRequestId: 'm1' })).rejects.toThrow('Mousse stopped')
    f.bots.continueChatWith = continueChatWith
    const queued = f.store.activationByKey('chat:m1')!
    expect(queued).toMatchObject({ lane: 'chat', status: 'queued', trigger: { input: 'What came in today?' } })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'owner', text: 'What came in today?', activationId: queued.id })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(f.store.activation(queued.id)?.status).toBe('running')
  })

  it('a message that answered a wall just before Mousse stopped continues the walled turn at startup, or when sent again', async () => {
    for (const recover of ['startup', 'resend'] as const) {
      await send('Read my notes', `${recover}-1`)
      const activation = chatActivation()
      const { payload, prepared } = await start(f, activation.id)
      prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'docs', 'a.md') } })
      await finish(f, payload, 'interrupted', { text: '', outcome: { interruptedBy: 'bot_wall' } })
      const continueChatWith = f.bots.continueChatWith.bind(f.bots)
      f.bots.continueChatWith = async () => { throw new Error('Mousse stopped') }
      writeFileSync(join(f.base, 'list.txt'), 'milk, eggs')
      const attachments = [{ name: 'list.txt', path: join(f.base, 'list.txt') }]
      await expect(f.bots.service.chatSend({ botId, text: 'Use this list instead', attachments, clientRequestId: `${recover}-2` })).rejects.toThrow('Mousse stopped')
      f.bots.continueChatWith = continueChatWith
      expect(f.store.activation(activation.id)?.status).toBe('waiting_grant')
      if (recover === 'startup') {
        f.bots.close()
        f.bots = new BotEngine(f.host)
        await f.bots.reconcileOnStartup()
      } else await f.bots.service.chatSend({ botId, text: 'Use this list instead', attachments, clientRequestId: `${recover}-2` })
      await flush()
      expect(f.store.dispatch(activation.id, 2)?.prompt.text).toMatch(/^\[Mousse\] The owner wrote instead of answering, so the answer is not now: .*\n\nUse this list instead\n\nAttached files:\n- list\.txt: /)
      // Once answered, the same request changes nothing.
      await f.bots.service.chatSend({ botId, text: 'Use this list instead', attachments, clientRequestId: `${recover}-2` })
      expect(f.store.dispatch(activation.id, 3)).toBeUndefined()
      await finish(f, payloadOf(f, activation.id, 2), 'completed', { text: 'Done.' })
    }
  })

  it('a reply or run report Mousse stopped before writing is written at startup, once', async () => {
    const engine = f.bots as unknown as { postReply: (...args: unknown[]) => void }
    const postReply = engine.postReply
    engine.postReply = () => {}
    await send('What came in today?', 'm1')
    const chat = chatActivation()
    await runDispatch(f, chat.id, 1, { text: 'Two invoices.' })
    const run = await f.bots.activate({ botId, input: 'Check the inbox', clientRequestId: 'r1' })
    await runDispatch(f, run.id, 1, { text: 'Nothing new.' })
    engine.postReply = postReply
    expect(f.store.activation(chat.id)?.status).toBe('done')
    expect(f.store.message(`bm_${chat.id}_d1`)).toBeUndefined()
    for (let restart = 0; restart < 2; restart++) {
      f.bots.close()
      f.bots = new BotEngine(f.host)
      await f.bots.reconcileOnStartup()
    }
    expect(chatOf(f, botId).filter((message) => message.activationId === chat.id || message.activationId === run.id).map((message) => [message.kind, message.text]))
      .toEqual([['text', 'What came in today?'], ['text', 'Two invoices.'], ['run_report', 'Nothing new.']])
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
    // Chips are kept by dispatch (`bot_dispatches.client_request_id`).
    f.chips.set(f.store.dispatch(activation.id, 1)!.clientRequestId, [{ icon: 'search', text: 'searched the web · 3' }])
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

describe('the final message after capture (review)', () => {
  it('a reply whose final message arrives while capture runs still carries it', async () => {
    const { botId } = await createBot(f, { name: 'Penny', reply: 'Hello.' })
    await f.bots.service.chatSend({ botId, text: 'what is new?', clientRequestId: 'late-1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, activation.id)
    // The run's terminal event settles first (no text); the executor's text follows during capture.
    f.runs.markTerminal(payload.runId, 'completed')
    f.bots.settleRun(payload.runId)
    f.bots.settle(payload, { text: 'Two new invoices.' })
    await flush()
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', kind: 'text', text: 'Two new invoices.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done', result: 'Two new invoices.' })
  })
})

describe('chat turns at their edges (review round 2)', () => {
  /** A chat turn that hit a wall; its run ended, and capture is held until `release`. */
  async function walledWhileCapturing(text: string, id: string) {
    await send(text, id)
    const activation = chatActivation()
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'docs', 'a.md') } })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const capture = f.host.context!.afterDispatch
    f.host.context!.afterDispatch = async (event) => {
      await held
      return capture(event)
    }
    f.runs.markTerminal(payload.runId, 'interrupted', { interruptedBy: 'bot_wall' })
    f.bots.settle(payload, { text: 'I need your notes first.' })
    return { activation, release: async () => { release(); await flush() } }
  }

  it('a message sent while the walled turn is still being recorded keeps that turn\'s reply', async () => {
    const { activation, release } = await walledWhileCapturing('Read my notes', 'm1')
    await f.bots.service.chatSend({ botId, text: 'Never mind, just say hi', clientRequestId: 'm2' })
    expect(f.store.dispatch(activation.id, 2)).toBeUndefined()
    await release()
    expect(chatOf(f, botId).filter((message) => message.activationId === activation.id && message.author === 'bot')).toMatchObject([{ kind: 'text', text: 'I need your notes first.' }])
    expect(f.store.dispatch(activation.id, 2)?.prompt.text).toMatch(/\n\nNever mind, just say hi$/)
  })

  it('that message still continues the turn after a restart', async () => {
    const { activation } = await walledWhileCapturing('Read my notes', 'm1')
    await f.bots.service.chatSend({ botId, text: 'Never mind, just say hi', clientRequestId: 'm2' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(f.store.dispatch(activation.id, 2)?.prompt.text).toMatch(/^\[Mousse\] The owner wrote instead of answering, so the answer is not now: .*\n\nNever mind, just say hi$/)
  })

  it('a chat message dropped from a full queue says so in the chat', async () => {
    await send('First', 'q0')
    const first = chatActivation()
    for (let n = 1; n <= 21; n += 1) {
      f.clock.now += 1
      await f.bots.service.chatSend({ botId, text: `Message ${n}`, clientRequestId: `q${n}` })
    }
    const dropped = f.store.activationByKey('chat:q1')!
    expect(dropped).toMatchObject({ status: 'cancelled', endReason: 'queue_full' })
    expect(chatOf(f, botId).filter((message) => message.kind === 'error')).toMatchObject([
      { activationId: dropped.id, error: { text: 'Too many messages were waiting, so I skipped this one. Send it again if it still matters.' } }
    ])
    expect(f.store.activation(first.id)!.status).toBe('running')
  })

  it('a failed turn\'s provider error is never posted as the bot\'s message', async () => {
    await send('What came in?', 'm1')
    const activation = chatActivation()
    const { payload } = await start(f, activation.id)
    f.runs.tools.start({ invocationId: 'inv-edit', runId: payload.runId, attemptId: f.runs.getRun(payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    await finish(f, payload, 'failed', { text: '[provider_error] 401 from claude-x', outcome: { error: 'provider_error' } })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
    expect(JSON.stringify(chatOf(f, botId))).not.toContain('provider_error')
    expect(f.store.activation(activation.id)!.result ?? '').toBe('')
  })

  it('a depth change on a turn that finishes first ends the turn: no extra Continue', async () => {
    await send('Think hard about this', 'm1')
    const activation = chatActivation()
    await runDispatch(f, activation.id, 1, { text: 'Here is my answer.', during: () => f.bots.tools.setModel(botId, activation.id, 'now', { depth: 'deep' }) })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
    expect(f.store.dispatch(activation.id, 2)).toBeUndefined()
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: 'Here is my answer.' })
  })

  it('a turn the depth change stopped continues on the new depth', async () => {
    await send('Think hard about this', 'm1')
    const activation = chatActivation()
    const { payload, prepared } = await start(f, activation.id)
    f.bots.tools.setModel(botId, activation.id, 'now', { depth: 'deep' })
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(f.base, 'x') } })).toMatchObject({ ok: false })
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.dispatch(activation.id, 2)?.prompt.text).toBe('[Mousse] You now have more time to think. Continue where you left off.')
  })

  it('a run is copied into the journal again after its last write, and at the next tick until a copy works', async () => {
    await f.bots.reconcileOnStartup()
    const synced: string[] = []
    let fail = true
    f.host.journal!.syncThread = async (ref) => {
      if (fail) throw new Error('thread not readable yet')
      synced.push(`${ref.threadId}:${ref.lane}:${ref.activationId}`)
    }
    const activation = await f.bots.activate({ botId, input: 'Report', clientRequestId: 'r1' })
    const { payload } = await start(f, activation.id)
    await finish(f, payload, 'completed', { text: 'Report.' })
    // The executor's settle (after the thread's last write) copies the thread once more.
    f.bots.settle(payload, { text: 'Report.' })
    await flush()
    expect(synced).toEqual([])
    fail = false
    await f.bots.tickSchedules(new Date(f.clock.now))
    await flush()
    const thread = f.store.activation(activation.id)!.threadId!
    expect(synced).toContain(`${thread}:run:${activation.id}`)
    const copies = synced.length
    await f.bots.tickSchedules(new Date(f.clock.now))
    await flush()
    expect(synced).toHaveLength(copies)
  })

  it('a bot whose journal cannot be caught up at startup is stuck; the others go on', async () => {
    const other = await createBot(f, { name: 'Other', reply: 'Hi.' })
    f.host.journal!.catchUp = async () => ({ failedBots: [botId] })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    expect(f.store.registry(botId)!.error).toMatchObject({ code: 'bot_journal_failed' })
    expect(f.store.registry(other.botId)!.error).toBeNull()
  })
})
