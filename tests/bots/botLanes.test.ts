/**
 * Bot Phase 1 §3.1 and §5.3.2: each bot has two lanes, side by side. The chat lane runs the
 * owner's messages in order on the home thread; the run lane runs manual and scheduled runs on
 * threads of their own, each with the run pack of its schedule, and posts a run report.
 */
import { BotEngine, UNANSWERED_REPLY } from '../../src/mms/bots/activation/BotEngine'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { name: 'Ticker', reply: 'Hi.' }))
})

afterEach(() => f.close())

async function send(text: string, clientRequestId: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId })
  await flush()
}

const lane = (which: 'chat' | 'run', statuses: Array<'running' | 'queued'>) => f.store.laneActivations(botId, which, statuses)

describe('two lanes', () => {
  it('a chat message during a run starts at once', async () => {
    const run = await f.bots.activate({ botId, input: 'Tidy the notes', clientRequestId: 'r1' })
    expect(run).toMatchObject({ status: 'running', threadId: `thread:bot:${botId}:act:${run.id}` })
    await send('How is it going?', 'm1')
    const [chat] = lane('chat', ['running'])
    expect(chat).toMatchObject({ threadId: `thread:bot:${botId}` })
    expect(lane('run', ['running']).map((row) => row.id)).toEqual([run.id])
    // Both run at the same time.
    const a = await start(f, run.id)
    const b = await start(f, chat!.id)
    await finish(f, b.payload, 'completed', { text: 'Halfway.' })
    await finish(f, a.payload, 'completed', { text: 'Notes tidied.' })
    expect(chatOf(f, botId).slice(-2)).toMatchObject([{ kind: 'text', text: 'Halfway.' }, { kind: 'run_report', text: 'Notes tidied.', activationId: run.id }])
  })

})

/**
 * Messages the owner sends one after another, while the bot answers the first or before its turn starts, are one
 * conversation: they are answered together, never by a turn that sees the later one alone. The paths a follow-up takes:
 * - the turn runs on a runtime that takes steers: it reads the follow-up as it works, and its one reply answers both;
 * - the runtime can't take steers, or the turn ends first: the turn posts its reply, then answers the follow-up in the
 *   same thread (its history holds the first message);
 * - the turn ends without reading it (a failure, a Stop): the follow-up gets a turn of its own that holds it;
 * - the first message's turn has not started yet: the follow-up joins it, and that turn's request carries both;
 * - another device's message, or a tap on an answer, starts its own turn (it is held to its own limit).
 */
describe('messages sent one after another', () => {
  const ownerRows = () => chatOf(f, botId).filter((message) => message.author === 'owner')
  const botTexts = () => chatOf(f, botId).filter((message) => message.author === 'bot').map((message) => message.text)

  it('a follow-up sent while the bot answers reaches its turn, and one reply answers both', async () => {
    await send("wdym you can't reach the thread? It's right there and moves", 'm1')
    const [turn] = lane('chat', ['running'])
    const { payload, prepared } = await start(f, turn!.id)
    prepared.steer!.attached()
    await send('mousse', 'm2')
    // No turn of its own: the follow-up belongs to the turn that is answering.
    expect(lane('chat', ['queued'])).toEqual([])
    expect(ownerRows().at(-1)).toMatchObject({ text: 'mousse', activationId: turn!.id })
    const taken = prepared.steer!.take()!
    // The owner's own words, in one block that asks for an answer, then what to do with them.
    expect(taken.text.startsWith('<mousse_message from="owner" reply="required">\nmousse\n</mousse_message>\n\n')).toBe(true)
    expect(taken.text).toContain('answer both in the one reply you are writing')
    prepared.steer!.accepted(taken.token)
    await finish(f, payload, 'completed', { text: 'You were right: I told the acrylic thread in mousse to retake the screenshots.' })
    expect(f.store.activation(turn!.id)).toMatchObject({ status: 'done' })
    expect(f.store.dispatch(turn!.id, 2)).toBeUndefined()
    expect(botTexts().slice(-1)).toEqual(['You were right: I told the acrylic thread in mousse to retake the screenshots.'])
    expect(lane('chat', ['queued', 'running'])).toEqual([])
  })

  /**
   * The follow-up cuts the reply, and Claude Code resumes the session with its own "No response requested." line, which
   * the turn then ends on (the runtime's result, or a model that copied it from its history). Inputs: the placeholder
   * alone / after a partial reply / again on the retry / in an owner's turn vs a wake-up.
   */
  describe('a reply that ends on the runtime\'s "No response requested."', () => {
    /** The owner's turn reads their second message as a steer while it answers; `tool`: a call it made before. */
    async function cutTurn(tool?: string): Promise<{ turn: string; payload: Awaited<ReturnType<typeof start>>['payload']; follow: string }> {
      await send('what changed in the release?', 'm1')
      const [turn] = lane('chat', ['running'])
      const { payload, prepared } = await start(f, turn!.id)
      if (tool) expect(prepared.authority.check({ kind: 'app', tool, args: {} })).toMatchObject({ ok: true })
      prepared.steer!.attached()
      const follow = (await f.bots.service.chatSend({ botId, text: 'and is it merged?', clientRequestId: 'm2' })).message.id
      const taken = prepared.steer!.take()!
      prepared.steer!.accepted(taken.token)
      return { turn: turn!.id, payload, follow }
    }
    const placeholderRows = () => chatOf(f, botId).filter((message) => message.author === 'bot' && /No response requested/i.test(message.text))
    const botRows = (turn: string) => chatOf(f, botId).filter((message) => message.activationId === turn && message.author === 'bot')

    // Seen the runtime's way (`TurnResult.steerUnanswered`, carried to `settle` as `unanswered`) or by its placeholder
    // anywhere in the reply; after a call that changed something too, the cut reply is held back, never posted.
    it.each([
      ['the runtime says the steer went unanswered', { text: 'Two fixes landed.', unanswered: true }, 'Two fixes landed.', undefined],
      ['the runtime says so after a memory_save', { text: 'Saved it.', unanswered: true }, 'Saved it.', 'memory_save'],
      ['the placeholder alone', { text: 'No response requested.' }, undefined, undefined],
      ['the placeholder after a partial reply', { text: 'Two fixes landed.\n\nNo response requested.' }, 'Two fixes landed.', undefined],
      ['the placeholder before more words', { text: 'No response requested.\n\nTwo fixes landed.' }, 'Two fixes landed.', undefined],
      ['the placeholder without its full stop', { text: 'Two fixes landed.\n\nno response requested' }, 'Two fixes landed.', undefined]
    ] as const)('%s: nothing is posted, and the turn goes on once to answer the owner', async (_name, end, draft, tool) => {
      const { turn, payload, follow } = await cutTurn(tool)
      await finish(f, payload, 'completed', end)
      expect(botRows(turn)).toEqual([])
      expect(f.store.activation(turn)?.status).toBe('running')
      const { payload: next, prepared } = await start(f, turn, 2)
      expect(prepared.prompt).toContain('Your reply never reached your owner')
      expect(prepared.prompt).toContain('what changed in the release?')
      expect(prepared.prompt).toContain('and is it merged?')
      if (draft) expect(prepared.prompt).toContain(`«${draft}»`)
      await finish(f, next, 'completed', { text: 'Two fixes landed, and yes, it merged.' })
      expect(chatOf(f, botId).filter((message) => message.activationId === turn && message.author === 'bot')).toMatchObject([
        { kind: 'text', text: 'Two fixes landed, and yes, it merged.', replyTo: { id: follow } }
      ])
      expect(f.store.activation(turn)?.status).toBe('done')
    })

    it('cut off again: it says so once, with what it had, and goes on no further', async () => {
      const { turn, payload } = await cutTurn()
      await finish(f, payload, 'completed', { text: 'Two fixes landed.\n\nNo response requested.' })
      const { payload: next } = await start(f, turn, 2)
      await finish(f, next, 'completed', { text: 'No response requested.' })
      expect(placeholderRows()).toEqual([])
      expect(f.store.dispatch(turn, 3)).toBeUndefined()
      expect(f.store.activation(turn)?.status).toBe('done')
      expect(chatOf(f, botId).filter((message) => message.activationId === turn && message.author === 'bot').map((message) => message.text))
        .toEqual([`Two fixes landed.\n\n${UNANSWERED_REPLY}`])
    })

    it('cut off again with a few words: what it held back and those words go out with the line asking to send it again', async () => {
      const { turn, payload } = await cutTurn()
      await finish(f, payload, 'completed', { text: 'Two fixes landed.', unanswered: true })
      const { payload: next, prepared } = await start(f, turn, 2)
      // The owner writes a third time, and that cuts the answer too.
      prepared.steer!.attached()
      await f.bots.service.chatSend({ botId, text: 'and the notes?', clientRequestId: 'm3' })
      prepared.steer!.accepted(prepared.steer!.take()!.token)
      await finish(f, next, 'completed', { text: 'And it merged', unanswered: true })
      expect(f.store.dispatch(turn, 3)).toBeUndefined()
      expect(botRows(turn).map((message) => message.text)).toEqual([`Two fixes landed.\n\nAnd it merged\n\n${UNANSWERED_REPLY}`])
    })

    it('the run ends before its words arrive: nothing is posted until they do, and then the cut is seen', async () => {
      const { turn, payload } = await cutTurn()
      f.runs.markTerminal(payload.runId, 'completed')
      f.bots.settle(payload, {})
      await flush()
      expect(botRows(turn)).toEqual([])
      f.bots.settle(payload, { text: 'Two fixes landed.', unanswered: true })
      await flush()
      expect(botRows(turn)).toEqual([])
      expect(f.store.activation(turn)?.status).toBe('running')
      const { prepared } = await start(f, turn, 2)
      expect(prepared.prompt).toContain('Your reply never reached your owner')
      expect(prepared.prompt).toContain('«Two fixes landed.»')
    })

    it('a steer that carried no message of the owner\'s (the pack again after a compaction) is no cut: the reply is posted', async () => {
      await send('what changed in the release?', 'm1')
      const [turn] = lane('chat', ['running'])
      const { payload } = await start(f, turn!.id)
      await finish(f, payload, 'completed', { text: 'Two fixes landed.', unanswered: true })
      expect(botRows(turn!.id).map((message) => message.text)).toEqual(['Two fixes landed.'])
      expect(f.store.activation(turn!.id)?.status).toBe('done')
    })

    it('a turn that read the follow-up and answered it posts its reply as written', async () => {
      const { turn, payload } = await cutTurn()
      await finish(f, payload, 'completed', { text: 'Two fixes landed.\n\nAnd yes, it merged.' })
      expect(botRows(turn).map((message) => message.text)).toEqual(['Two fixes landed.\n\nAnd yes, it merged.'])
      expect(f.store.activation(turn)?.status).toBe('done')
    })
  })

  // Inputs: no calls / reads / mutations; success / Stop / failure / restart; third message.
  it.each(['none', 'read', 'memory_list', 'work_start', 'memory_save', 'set_profile'])('unread follow-up after %s keeps the right replies and quotes', async (tool) => {
    const first = await f.bots.service.chatSend({ botId, text: 'hi', clientRequestId: 'm1' })
    const turn = first.message.activationId!
    const { payload, prepared: firstPrepared } = await start(f, turn)
    if (tool !== 'none') expect(firstPrepared.authority.check(tool === 'read'
      ? { kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: `${firstPrepared.authority.workspace!.scratch}/note.txt` } }
      : { kind: 'app', tool, args: {} })).toMatchObject({ ok: true })
    if (tool === 'read') f.chips.set(`${turn}:d1`, [{ icon: 'read', text: 'read your threads' }])
    const second = await f.bots.service.chatSend({ botId, text: 'check the flat', clientRequestId: 'm2' })
    f.bots.service.markRead(botId, second.message.seq)
    await finish(f, payload, 'completed', { text: 'Hi! What can I do?' })
    const held = ['none', 'read', 'memory_list'].includes(tool)
    const replies = () => chatOf(f, botId).filter((m) => m.activationId === turn && m.author === 'bot' && m.kind === 'text')
    expect(replies()).toHaveLength(held ? 0 : 1)
    expect(f.bots.service.get(botId).summary.unread).toBe(held ? 0 : 1)
    expect(f.store.activation(turn)?.status).toBe('running')
    const { payload: next, prepared } = await start(f, turn, 2)
    expect(prepared.history).toBe('thread')
    expect(prepared.prompt).toContain(held ? 'Your draft, not sent: «Hi! What can I do?»' : 'your reply so far was already sent')
    expect(prepared.prompt).toContain('check the flat')
    await finish(f, next, 'completed', { text: 'Hi — checking the flat.' })
    expect(replies()).toHaveLength(held ? 1 : 2)
    if (tool === 'read') expect(replies().at(-1)?.chips).toContainEqual({ icon: 'read', text: 'read your threads' })
    expect(replies().at(-1)).toMatchObject({ text: 'Hi — checking the flat.', replyTo: { id: second.message.id } })
    if (!held) expect(replies()[0]).toMatchObject({ replyTo: { id: first.message.id } })
    expect(replies().at(-1)!.seq).toBeGreaterThan(second.message.seq)
    expect(f.bots.service.get(botId).summary.unread).toBe(held ? 1 : 2)
  })

  it.each(['stop', 'fail', 'restart-cancelled', 'restart-failed', 'restart-running', 'restart-done', 'third'] as const)('a held reply survives %s, once', async (end) => {
    const first = await f.bots.service.chatSend({ botId, text: 'hi', clientRequestId: 'm1' })
    const turn = first.message.activationId!
    const { payload } = await start(f, turn)
    await send('check the flat', 'm2')
    await finish(f, payload, 'completed', { text: 'Hi! What can I do?' })
    const replies = () => chatOf(f, botId).filter((m) => m.activationId === turn && m.kind === 'text' && m.author === 'bot')
    expect(replies()).toHaveLength(0)
    if (end.startsWith('restart')) {
      f.bots.close()
      if (end === 'restart-done') {
        f.store.run('UPDATE bot_dispatches SET ended_at = ? WHERE activation_id = ? AND n = 2', new Date(f.clock.now).toISOString(), turn)
        f.store.moveActivation(turn, ['running'], 'done', { result: 'Hi — checking the flat.' })
      } else if (end !== 'restart-running') f.store.moveActivation(turn, ['running'], end === 'restart-failed' ? 'failed' : 'cancelled', { endReason: 'stopped' })
      f.bots = new BotEngine(f.host)
      await f.bots.reconcileOnStartup()
      await flush()
      if (f.store.activation(turn)?.status === 'running') {
        const dispatch = f.store.lastMainDispatch(turn)!
        await finish(f, (await start(f, turn, dispatch.n)).payload, 'completed', { text: 'Hi — checking the flat.' })
      }
      await f.bots.reconcileOnStartup()
      expect(replies()).toHaveLength(1)
      if (end === 'restart-done') expect(replies()[0]?.text).toBe('Hi — checking the flat.')
    } else {
      const { payload: next } = await start(f, turn, 2)
      if (end === 'third') {
        const third = await f.bots.service.chatSend({ botId, text: 'and the roof', clientRequestId: 'm3' })
        await finish(f, next, 'completed', { text: 'Checking the flat.' })
        expect(replies()).toHaveLength(1)
        expect(replies()[0]).toMatchObject({ replyTo: { text: 'check the flat' } })
        const last = await start(f, turn, 3)
        expect(last.prepared.prompt).toContain('already sent')
        await finish(f, last.payload, 'completed', { text: 'The roof too.' })
        expect(replies().at(-1)).toMatchObject({ replyTo: { id: third.message.id } })
      } else {
        if (end === 'stop') await f.bots.service.chatStop(botId)
        await finish(f, next, end === 'stop' ? 'interrupted' : 'failed', { outcome: { error: 'boom' } })
        expect(replies()).toHaveLength(1)
        expect(replies()[0]).toMatchObject({ text: 'Hi! What can I do?', replyTo: { id: first.message.id } })
      }
    }
    expect(f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `draft:${turn}`)).toBeUndefined()
  })

  it.each([true, false])('late final words are held; combined reply arrives=%s', async (arrives) => {
    const first = await f.bots.service.chatSend({ botId, text: 'hi', clientRequestId: 'm1' })
    const turn = first.message.activationId!
    const one = await start(f, turn)
    await send('check the flat', 'm2')
    f.runs.markTerminal(one.payload.runId, 'completed')
    f.bots.settle(one.payload, {})
    await flush()
    f.bots.settle(one.payload, { text: 'Hi! What can I do?' })
    await flush()
    const two = await start(f, turn, 2)
    expect(two.prepared.prompt).toContain('Your draft, not sent: «Hi! What can I do?»')
    f.runs.markTerminal(two.payload.runId, 'completed')
    f.bots.settle(two.payload, {})
    await flush()
    const replies = () => chatOf(f, botId).filter((m) => m.activationId === turn && m.author === 'bot' && m.kind === 'text')
    expect(replies()).toHaveLength(0)
    if (arrives) f.bots.settle(two.payload, { text: 'Hi — checking the flat.' })
    else f.timers.filter((timer) => timer.ms === 5000).at(-1)!.fn()
    await flush()
    expect(replies().map((m) => m.text)).toEqual([arrives ? 'Hi — checking the flat.' : 'Hi! What can I do?'])
  })

  it('a follow-up the turn never read before it failed gets a turn of its own that holds it', async () => {
    await send('first', 'm1')
    const [turn] = lane('chat', ['running'])
    const { payload } = await start(f, turn!.id)
    const second = await f.bots.service.chatSend({ botId, text: 'second', clientRequestId: 'm2' })
    await finish(f, payload, 'failed', { outcome: { error: 'boom' } })
    expect(f.store.activation(turn!.id)?.status).toBe('failed')
    const [again] = lane('chat', ['running'])
    expect(again).toMatchObject({ trigger: { input: 'second' } })
    expect(ownerRows().at(-1)).toMatchObject({ id: second.message.id, activationId: again!.id })
    // It is the owner's own message: the turn may act on their threads, as any turn their message started.
    expect(f.bots.ownerTurn(again!.id)).toEqual({})
    await runDispatch(f, again!.id, 1, { text: 'two' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: 'two', replyTo: { id: second.message.id } })
  })

  it('a follow-up the turn never read before a Stop still gets its answer', async () => {
    await send('first', 'm1')
    const [turn] = lane('chat', ['running'])
    const { payload } = await start(f, turn!.id)
    await send('second', 'm2')
    await f.bots.service.chatStop(botId)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
    expect(f.store.activation(turn!.id)?.status).toBe('cancelled')
    expect(lane('chat', ['running', 'queued']).map((row) => row.trigger.input)).toEqual(['second'])
  })

  it("messages sent before the first one's turn starts are one request", async () => {
    const g = botFixture()
    try {
      // The bot's first message still runs: the owner's messages wait behind it.
      const { botId: id, firstActivation } = await createBot(g, { name: 'Ticker' })
      await g.bots.service.chatSend({ botId: id, text: 'first', clientRequestId: 'm1' })
      await g.bots.service.chatSend({ botId: id, text: 'second', clientRequestId: 'm2' })
      const queued = g.store.laneActivations(id, 'chat', ['queued'])
      expect(queued).toHaveLength(1)
      await runDispatch(g, firstActivation, 1, { text: 'Hi.' })
      const { prepared } = await start(g, queued[0]!.id)
      expect(prepared.prompt).toBe('first\n\nThe owner also wrote:\n\nsecond')
    } finally {
      g.close()
    }
  })

  // Identity and limit are independent: equal limits do not make two devices the same sender.
  it.each([
    ['running', 'phone', 'ask', true],
    ['running', 'laptop', 'ask', false],
    ['running', 'phone', 'full', false],
    ['queued', 'phone', 'ask', true],
    ['queued', 'laptop', 'ask', false],
    ['queued', 'phone', 'full', false]
  ] as const)('%s turn: follow-up from %s with %s joins=%s', async (status, node, limit, joins) => {
    if (status === 'queued') await send('Hold the chat lane', 'hold')
    const first = await f.bots.service.chatSend({ botId, text: 'first', clientRequestId: 'first', from: { node: 'phone', limit: 'ask' } })
    const second = await f.bots.service.chatSend({ botId, text: 'second', clientRequestId: 'second', from: { node, limit } })
    expect(second.message.activationId === first.message.activationId).toBe(joins)
    expect(f.store.activation(second.message.activationId!)?.status).toBe(joins ? status : 'queued')
  })

  it("withdrawing a device reaches all its queued messages, including joined follow-ups", async () => {
    await send('Hold the chat lane', 'hold')
    const messages = []
    for (const [id, node] of [['l1', 'laptop'], ['p1', 'phone'], ['p2', 'phone']] as const) {
      messages.push((await f.bots.service.chatSend({ botId, text: id, clientRequestId: id, from: { node, limit: 'ask' } })).message)
    }
    expect(await f.bots.service.withdrawQueued((_id, node) => node === 'phone')).toBe(1)
    expect(f.store.activation(messages[0]!.activationId!)?.status).toBe('queued')
    for (const message of messages.slice(1)) expect(f.store.activation(message.activationId!)?.status).toBe('cancelled')
  })

  it("another device's message starts a turn of its own", async () => {
    await send('first', 'm1')
    const [turn] = lane('chat', ['running'])
    await f.bots.service.chatSend({ botId, text: 'From my phone', clientRequestId: 'p1', from: { limit: 'ask' } })
    expect(ownerRows().at(-1)?.activationId).not.toBe(turn!.id)
    expect(lane('chat', ['queued']).map((row) => row.trigger.input)).toEqual(['From my phone'])
  })
})

describe('the run lane', () => {
  it('a scheduled run gets the run pack of its schedule, and its final text is a run report', async () => {
    const { scheduleId } = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'check' }, 'owner')
    await f.bots.reconcileOnStartup()
    await f.tickSchedules(new Date(f.clock.now))
    f.clock.now += 5 * 60_000
    const { inserted } = await f.tickSchedules(new Date(f.clock.now))
    expect(inserted).toHaveLength(1)
    const activation = f.store.activation(inserted[0]!)!
    expect(activation).toMatchObject({ lane: 'run', status: 'running', trigger: { kind: 'schedule', scheduleId, input: 'check' } })
    const { payload, prepared } = await start(f, activation.id)
    expect(prepared).toMatchObject({ history: 'none', lane: 'run', preamble: `<bot_memory>run pack ${scheduleId}</bot_memory>` })
    expect(f.packs.at(-1)).toEqual({ lane: 'run', activationId: activation.id, scheduleId })
    await finish(f, payload, 'completed', { text: 'All quiet.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', kind: 'run_report', text: 'All quiet.', activationId: activation.id })
    expect(f.journal.find((row) => row.kind === 'run_start' && row.activationId === activation.id)).toMatchObject({ json: { scheduleId } })
  })

  it('a manual run\'s pack has no schedule id', async () => {
    const run = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    const { prepared } = await start(f, run.id)
    expect(f.packs.at(-1)).toEqual({ lane: 'run', activationId: run.id })
    expect(prepared.preamble).toBe('<bot_memory>run pack manual</bot_memory>')
  })

  it('activationOf answers each thread\'s lane, and nothing once the work ended; scratch goes at each run\'s end', async () => {
    const run = await f.bots.activate({ botId, input: 'go', clientRequestId: 'r1' })
    await send('hi', 'm1')
    const [chat] = lane('chat', ['running'])
    expect(f.bots.tools.activationOf(`thread:bot:${botId}`)).toMatchObject({ botId, activationId: chat!.id, lane: 'chat', role: 'home' })
    expect(f.bots.tools.activationOf(run.threadId!)).toMatchObject({ botId, activationId: run.id, lane: 'run', role: 'activation' })
    expect(f.bots.tools.activationOf('thread:someone-else')).toBeUndefined()
    const prepared = await runDispatch(f, run.id, 1, { text: 'done' })
    expect(existsSync(prepared.scratch)).toBe(false)
    expect(f.bots.tools.activationOf(run.threadId!)).toBeUndefined()
    await runDispatch(f, chat!.id, 1, { text: 'hello' })
    expect(f.bots.tools.activationOf(`thread:bot:${botId}`)).toBeUndefined()
    // Startup capture gives each thread's new rows to the latest activation that ran there.
    expect(f.store.captureThreads().filter((thread) => thread.botId === botId).map((thread) => [thread.role, thread.lastActivation])).toEqual(expect.arrayContaining([
      ['home', { id: chat!.id, lane: 'chat' }],
      ['activation', { id: run.id, lane: 'run' }]
    ]))
  })
})
