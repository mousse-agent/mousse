/**
 * Work that asks its owner a question and waits for the answer (`ask_owner` in work, issue #1123), over a real engine and
 * a real `bots.db`: the question's bubble is posted at once under the owner's message, the rest of the turn is refused so
 * it ends, the work waits without a run slot (`blocked`, `question`), and the answer carries it on in its own thread
 * (`question_answered`, `resumeWork`).
 *
 * What each case covers, by what can happen to work that waits on a question:
 * - answers: a tap, a reply in the owner's words on the bubble, the chat passing on what they wrote there
 *   (`question_answer`, only from a chat turn their own message started), a second answer from another device
 * - ends: Stop, the grant revoked, a full queue, the question's bubble forgotten; each withdraws the question and says so
 * - Forget of the answer: before the work read it (it waits again), after (it stays with the work, and its copies in the
 *   work's prompt, the captured continuation and the chat's relay call go); of the bubble while the asking turn still
 *   runs, or before a restart (the work ends); a relay of words the owner forgot is refused
 * - restarts: while it waits, between the answer and the resume, right after `ask_owner` with its dispatch cut
 * - several pieces each waiting: an answer wakes only its own
 * - where it is never offered: a scheduled run, a consult (subagents: botWorkSubagents.test.ts)
 * - what a tap never does: widen the grant, or let the work act on threads or models
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import { QUESTION_ANSWER_FORGOTTEN_TEXT, QUESTION_END_TURN_TEXT, QUESTION_NOT_OFFERED_TEXT, QUESTION_WORK_ASKED_TEXT, QUESTION_WORK_WAITING_TEXT, QUESTIONS_ENOUGH_TEXT, questionGoneText } from '../../src/shared/bots/personal/questions'
import { capturedRows } from '../../src/mms/bots/memory/capture'
import type { ChatMessage } from '../../src/shared/types'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, start, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext

let f: BotFixture
let domains: DomainHandlerRegistry
let botId: string

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  botId = (await createBot(f, { name: 'Pip', reply: 'Hi, I find flats.' })).botId
})
afterEach(() => f.close())

const call = <T = unknown>(method: string, params: Record<string, unknown>): Promise<T> => domains.dispatch(context, method, params) as Promise<T>

const tools = new Map(botTools(() => ({ host: f.bots.tools })).map((tool) => [tool.name, tool]))
/** One of the bot's tools, called from a running turn as its runtime would. */
async function tool(name: string, prepared: PreparedBotTurn, threadId: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const ctx = {
    caller: { threadId, runId: 'r', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { threadId, bot: prepared.authority },
    toolCallId: `call-${Math.random()}`,
    signal: new AbortController().signal,
    transport: 'mcp'
  } as unknown as ToolCallContext
  return (tools.get(name) as MousseTool).handler(args, ctx)
}

const FLATS = { question: 'Which flat should I book a viewing for?', choices: [{ label: 'Flat A', detail: '2 bed, Hackney' }, 'Flat B'] }
const app = (name: string): NormalisedCall => ({ kind: 'app', tool: name, args: {} })
/** A call every bot's work may make (the starter grant's web). */
const web = app('web_fetch')

/** The owner writes; the chat turn their message started, running. */
async function chat(text: string, id: string, replyTo?: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id, ...(replyTo ? { replyTo } : {}) })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

/** The chat hands off work titled `title`; the owner's message that asked for it, and the work. */
async function handOff(title: string, key: string) {
  const turn = await chat(`Please do: ${title}`, `m-${key}`)
  const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title, brief: `${title}: find two and book a viewing.`, key })
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  return { workId, asked: turn.message }
}

/** Work that runs, asks `args` with `ask_owner`, and ends its turn; its question's bubble. */
async function workThatAsks(title = 'Flat hunt', key = 'w1', args: Record<string, unknown> = FLATS) {
  const { workId, asked } = await handOff(title, key)
  const work = await start(f, workId)
  const answer = await tool('ask_owner', work.prepared, work.payload.threadId, args)
  expect(JSON.parse(answer.text)).toEqual({ asked: true, note: QUESTION_WORK_ASKED_TEXT })
  const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === workId)!
  return { workId, work, asked, bubble, questionId: bubble.question!.questionId }
}

/** The work's turn ends after asking, as its model would once every call is refused. */
const endTurn = (work: Pick<Awaited<ReturnType<typeof start>>, 'payload'>, text = 'I asked which flat.') => finish(f, work.payload, 'completed', { text })

/** A tap through the registered handler, as the app sends it. */
const tap = (questionId: string, choice: string, clientRequestId = `tap-${Math.random().toString(16).slice(2)}`) =>
  call<{ message: BotChatMessage; question?: BotChatMessage }>('bots.questions.answer', { botId, questionId, choice, clientRequestId })

const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

/** What open windows were last sent of a message (`bots.message`), from now on. */
function published(): (id: string) => BotChatMessage | undefined {
  const sent: BotChatMessage[] = []
  f.bots.events.on('message', (payload: unknown) => sent.push((payload as { message: BotChatMessage }).message))
  return (id) => sent.filter((message) => message.id === id).at(-1)
}
const mainDispatches = (workId: string) => f.store.dispatches(workId).filter((dispatch) => dispatch.kind === 'start' || dispatch.kind === 'continue')

/** A real memory store over the fixture's `bots.db` (the fixture's journal is a stand-in). */
const memoryStore = () => new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })

/** A real journal row for a chat message, as `chat.post` writes it, and its ref for Forget. */
function journaled(memory: BotMemoryStore, message: BotChatMessage, kind: 'owner_msg' | 'notice', lane: 'chat' | 'run' = 'run'): string {
  f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind, lane, sourceKey: `bm:${message.id}`, who: kind === 'owner_msg' ? 'owner' : 'bot', text: message.text, ...(message.activationId ? { activationId: message.activationId } : {}) }))
  return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
}

/** Thread messages copied into the journal as capture copies them (`capturedRows`); their journal rows' seqs. */
function captured(memory: BotMemoryStore, ref: { threadId: string; lane: 'chat' | 'run'; activationId: string }, messages: ChatMessage[]): number[] {
  const rows = messages.flatMap((message) => capturedRows(message, { botId, ...ref }))
  f.store.db.transaction(() => { for (const { at, ...row } of rows) memory.appendInTx(f.store.db, row, at) })
  return rows.map((row) => f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', row.sourceKey)!.seq as number)
}
const journalText = (seq: number) => f.store.get('SELECT text, redacted_at FROM bot_journal WHERE seq = ?', seq) as { text: string; redacted_at: string | null }

/** Restarts Mousse over the same `bots.db` and run database. */
async function restart() {
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
}

describe('work that asks', () => {
  it('shows its question at once under the owner’s message, refuses the rest of its turn, and waits without its slot so queued work starts', async () => {
    const others = [await handOff('Train times', 'w2'), await handOff('Weather', 'w3')]
    const { workId, work, asked, bubble } = await workThatAsks()
    const queued = await handOff('Recipes', 'w4')
    expect(f.store.activation(queued.workId)?.status).toBe('queued')
    // The bubble is the bot's own words from its work, under the message that asked for the work, with its answers.
    expect(bubble).toMatchObject({ kind: 'notice', author: 'bot', replyTo: { id: asked.id }, question: { status: 'open', choices: [{ label: 'Flat A' }, { label: 'Flat B' }] } })
    expect(bubble.text.slice(0, bubble.plainFrom)).toBe(FLATS.question)
    // Every later call of that turn is refused (never a wall), so the turn ends; the same call is allowed once it carries
    // on (below), and in work that asked nothing.
    expect(work.prepared.authority.check(web)).toEqual({ ok: false, refused: { text: QUESTION_END_TURN_TEXT, askId: '' } })
    expect((await start(f, others[0]!.workId)).prepared.authority.check(web)).toEqual({ ok: true })
    expect(work.prepared.authority.check(app('run_report'))).toMatchObject({ ok: false, refused: { text: QUESTION_END_TURN_TEXT } })
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'x' })).toBe(QUESTION_END_TURN_TEXT)
    expect(f.store.escalations({ botId })).toEqual([])
    await endTurn(work)
    // It waits for the answer, holding no run slot: the queued work started in it. Its last words are not posted.
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    expect(f.store.activation(queued.workId)?.status).toBe('running')
    expect(chatOf(f, botId).some((message) => message.activationId === workId && message.text.includes('I asked which flat'))).toBe(false)
    // The owner is needed, and the work line says why it waits; the chat's work list too.
    expect(summary()).toMatchObject({ state: 'needs_you', stateText: `Asked: ${FLATS.question}` })
    expect(summary().work!.find((item) => item.id === workId)).toMatchObject({ status: 'paused', waitsFor: 'answer' })
    expect(f.bots.listWork(botId).now.find((item) => item.workId === workId)).toMatchObject({ status: 'paused', waitsFor: 'answer', question: { questionId: bubble.question!.questionId, question: FLATS.question } })
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question?.waits).toBe(true)
    // The owner's Continue is not a way on, and it takes no notes while it waits.
    await expect(f.bots.continueActivation(workId)).rejects.toMatchObject({ code: 'bot_work_waiting', message: QUESTION_WORK_WAITING_TEXT })
    expect(f.bots.noteWork(botId, workId, 'Also check pets are allowed')).toBe('question')
    expect(others.every((other) => f.store.activation(other.workId)?.status === 'running')).toBe(true)
  })

  it('a tap carries it on in the same thread with the answer, and its report answers the owner’s message; no chat turn starts', async () => {
    const { workId, work, asked, questionId } = await workThatAsks()
    await endTurn(work)
    const chatTurns = f.store.listActivations(botId).filter((row) => row.lane === 'chat').length
    const { message, question } = await tap(questionId, 'Flat B')
    await flush()
    expect(message).toMatchObject({ author: 'owner', text: 'Flat B', activationId: workId, answers: { questionId, tapped: true } })
    expect(question?.question).toMatchObject({ status: 'answered', answer: 'Flat B', answeredWith: 'choice' })
    expect(f.store.listActivations(botId).filter((row) => row.lane === 'chat')).toHaveLength(chatTurns)
    // It goes on in its own thread, told the answer once.
    const [first, next] = mainDispatches(workId)
    expect(next).toMatchObject({ kind: 'continue', threadId: first!.threadId })
    expect(next!.prompt.text).toBe(`[Mousse] Your owner answered your question "${FLATS.question}": Flat B. Carry on where you left off.`)
    expect(f.store.question(questionId)?.readAt).not.toBeNull()
    expect(summary().state).not.toBe('needs_you')
    const resumed = await start(f, workId, next!.n)
    // A tap widens nothing: the same tools, the owner's threads still read-only, and no model of the owner's to switch to.
    expect(resumed.prepared.policy.tools?.allow).toEqual(work.prepared.policy.tools?.allow)
    expect(resumed.prepared.authority.threadsReadOnly).toBe(work.prepared.authority.threadsReadOnly)
    expect(resumed.prepared.authority.threadsReadOnly).toBeDefined()
    expect(await tool('use_model', resumed.prepared, resumed.payload.threadId, { model: 'Flat B', scope: 'now' })).toMatchObject({ isError: true })
    // The resumed turn is not refused: the refusal was the asking turn's alone.
    expect(resumed.prepared.authority.check(web)).toEqual({ ok: true })
    await finish(f, resumed.payload, 'completed', { text: 'I booked a viewing of Flat B for Saturday.' })
    expect(f.store.activation(workId)?.status).toBe('done')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'I booked a viewing of Flat B for Saturday.', replyTo: { id: asked.id } })
  })

  it('a reply in the owner’s words on its bubble answers it; any other message leaves the work waiting', async () => {
    const { workId, work, bubble, questionId } = await workThatAsks()
    await endTurn(work)
    const other = await chat('What is the weather tomorrow?', 'other')
    await finish(f, other.payload, 'completed', { text: 'Sunny.' })
    expect(f.store.question(questionId)?.status).toBe('open')
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    const chatTurns = f.store.listActivations(botId).filter((row) => row.lane === 'chat').length
    const { message } = await f.bots.service.chatSend({ botId, text: 'Neither, find one nearer the park', clientRequestId: 'typed', replyTo: bubble.id })
    await flush()
    expect(message).toMatchObject({ activationId: workId, answers: { questionId, tapped: false } })
    expect(f.store.listActivations(botId).filter((row) => row.lane === 'chat')).toHaveLength(chatTurns)
    expect(mainDispatches(workId).at(-1)!.prompt.text).toBe(`[Mousse] Your owner answered your question "${FLATS.question}": Neither, find one nearer the park. Carry on where you left off.`)
    // Once it is answered, a reply on the bubble is an ordinary message to the chat.
    await f.bots.service.chatSend({ botId, text: 'Thanks', clientRequestId: 'after', replyTo: bubble.id })
    expect(f.store.listActivations(botId).filter((row) => row.lane === 'chat')).toHaveLength(chatTurns + 1)
  })

  it('answering one piece of work’s question carries on only that one', async () => {
    const flats = await workThatAsks('Flat hunt', 'w1')
    await endTurn(flats.work)
    const movers = await workThatAsks('Movers', 'w2', { question: 'Shall I book the cheaper movers?', yesNo: true })
    await endTurn(movers.work, 'I asked about the movers.')
    await tap(movers.questionId, 'Yes')
    await flush()
    expect(f.store.activation(movers.workId)?.status).toBe('running')
    expect(f.store.activation(flats.workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    expect(mainDispatches(flats.workId)).toHaveLength(1)
    expect(summary()).toMatchObject({ state: 'needs_you', stateText: `Asked: ${FLATS.question}` })
  })

  it('a second answer is refused before anything is written, and one piece of work asks one question at a time', async () => {
    const { work, questionId } = await workThatAsks()
    expect(await tool('ask_owner', work.prepared, work.payload.threadId, { question: 'And which day?', yesNo: true })).toEqual({ text: QUESTIONS_ENOUGH_TEXT, isError: true })
    await endTurn(work)
    await tap(questionId, 'Flat A', 'tap-1')
    const rows = chatOf(f, botId).length
    await expect(tap(questionId, 'Flat B')).rejects.toMatchObject({ code: 'question_answered' })
    expect(chatOf(f, botId)).toHaveLength(rows)
    // The same request again is the first answer.
    expect((await tap(questionId, 'Flat A', 'tap-1')).message.text).toBe('Flat A')
    expect(chatOf(f, botId)).toHaveLength(rows)
  })
})

describe('the chat passes on an answer (question_answer)', () => {
  it('only from a chat turn the owner’s own message started: never from one a tap started', async () => {
    const { workId, work, bubble, questionId } = await workThatAsks()
    await endTurn(work)
    // The chat knows what its work waits on, with the id to pass an answer on with.
    expect(f.bots.questionLines(botId)).toEqual([`"Flat hunt" waits for the owner's answer to your question "${FLATS.question}" (Flat A · Flat B · Something else) [${questionId}]. If the owner answers it in the chat, pass it on with question_answer.`])
    // A chat question the owner taps: the turn it starts is not their own words, so it can't pass anything on.
    const asking = await chat('Anything else?', 'c1')
    await tool('ask_owner', asking.prepared, asking.payload.threadId, { question: 'Shall I also look at parking?', yesNo: true })
    await finish(f, asking.payload, 'completed', { text: 'One thing.' })
    const chatBubble = chatOf(f, botId).find((message) => message.question && message.activationId === asking.activation.id)!
    await tap(chatBubble.question!.questionId, 'Yes')
    const tapped = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const tappedTurn = await start(f, tapped.id)
    expect(tappedTurn.prepared.authority.appTools.has('question_answer')).toBe(true)
    expect(await tool('question_answer', tappedTurn.prepared, tappedTurn.payload.threadId, { questionId, answer: 'Flat A' })).toMatchObject({ isError: true })
    await finish(f, tappedTurn.payload, 'completed', { text: 'OK.' })
    expect(f.store.question(questionId)?.status).toBe('open')
    // The owner's own words in the chat are passed on, and the bubble says it was answered in the chat.
    const own = await chat('Go with the second one', 'c2')
    expect(JSON.parse((await tool('question_answer', own.prepared, own.payload.threadId, { questionId, answer: 'The second one, Flat B' })).text)).toMatchObject({ ok: true })
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { text: 'The second one, Flat B', by: 'chat' }, answerMessage: own.message.id })
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question).toMatchObject({ status: 'answered', by: 'chat', answer: 'The second one, Flat B' })
    await finish(f, own.payload, 'completed', { text: 'Got it, carrying on with the flats.' })
    await flush()
    expect(mainDispatches(workId).at(-1)!.prompt.text).toBe(`[Mousse] Your owner answered your question "${FLATS.question}" in the chat: The second one, Flat B. Carry on where you left off.`)
    // Once answered, it can't be answered again.
    const again = await chat('Actually the first', 'c3')
    expect(await tool('question_answer', again.prepared, again.payload.threadId, { questionId, answer: 'Flat A' })).toMatchObject({ isError: true })
  })

  it('never passes on what the owner forgot, even from the turn their message started and while it still runs', async () => {
    const memory = memoryStore()
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    const own = await chat('Go with the second one', 'c1')
    // The owner forgets their message while the turn that holds it still runs (its model already read it).
    memory.forget(botId, { refs: [journaled(memory, own.message, 'owner_msg', 'chat')], by: 'owner_ui' })
    expect(await tool('question_answer', own.prepared, own.payload.threadId, { questionId, answer: 'The second one' })).toEqual({ text: QUESTION_ANSWER_FORGOTTEN_TEXT, isError: true })
    expect(f.store.question(questionId)).toMatchObject({ status: 'open', answer: null })
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    // The control: the same relay from a turn whose message is kept goes through.
    await finish(f, own.payload, 'completed', { text: 'OK.' })
    const kept = await chat('Go with the second one', 'c2')
    expect(JSON.parse((await tool('question_answer', kept.prepared, kept.payload.threadId, { questionId, answer: 'The second one' })).text)).toMatchObject({ ok: true })
  })
})

describe('nothing is left waiting', () => {
  it('Stop ends the work and withdraws its question: its buttons go, and a tap is refused', async () => {
    const { workId, work, bubble, questionId } = await workThatAsks()
    await endTurn(work)
    const sent = published()
    expect(await f.bots.stopWork(botId, workId)).toBe('stopped')
    expect(f.store.activation(workId)?.status).toBe('cancelled')
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
    // Open windows are told at once, not only the next read.
    expect(sent(bubble.id)?.question?.status).toBe('withdrawn')
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question?.status).toBe('withdrawn')
    await expect(tap(questionId, 'Flat A')).rejects.toMatchObject({ code: 'question_closed' })
    expect(summary().state).not.toBe('needs_you')
    expect(summary().work ?? []).toEqual([])
  })

  it('Stop while its asking turn is still ending withdraws the question too', async () => {
    const { workId, work, questionId } = await workThatAsks()
    await f.bots.stopWork(botId, workId)
    await finish(f, work.payload, 'interrupted', { text: '' })
    expect(f.store.activation(workId)?.status).toBe('cancelled')
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
  })

  it('revoking the grant ends waiting work with its line and withdraws its question', async () => {
    const { workId, work, questionId, asked, bubble } = await workThatAsks()
    await endTurn(work)
    const sent = published()
    f.bots.revoke(botId)
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
    expect(sent(bubble.id)?.question?.status).toBe('withdrawn')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: 'I stopped "Flat hunt": my permissions changed.', replyTo: { id: asked.id } })
  })

  it('a full queue drops the oldest waiting work with its line, and withdraws its question', async () => {
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    for (let i = 0; i < 20; i += 1) {
      f.clock.now += 1_000
      await f.bots.activate({ botId, input: `Run ${i}`, clientRequestId: `q${i}` })
    }
    expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'queue_full' })
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
    expect(chatOf(f, botId).some((message) => message.text === 'I had too much waiting, so I dropped "Flat hunt". Ask me again when I\'m less busy.')).toBe(true)
  })
})

describe('Forget', () => {
  /** Fills the bot's three run slots, so answered work waits for one. */
  const fillSlots = async () => [await handOff('Train times', 'f1'), await handOff('Weather', 'f2'), await handOff('Recipes', 'f3')]

  it('of the answer before the work read it: the question is open again and the work waits for an answer again', async () => {
    const memory = memoryStore()
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    const busy = await fillSlots()
    const { message } = await tap(questionId, 'Flat B')
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question_answered' })
    memory.forget(botId, { refs: [journaled(memory, message, 'owner_msg')], by: 'owner_ui' })
    expect(f.store.question(questionId)).toMatchObject({ status: 'open', answer: null })
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    // A free slot now does not carry it on: it has no answer.
    await finish(f, payloadOf(f, busy[0]!.workId), 'completed', { text: 'Trains at 9.' })
    await f.bots.maintain()
    expect(mainDispatches(workId)).toHaveLength(1)
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
  })

  it('of a tapped answer the work already read: the line that carried it goes from the work’s prompt and its captured copy, the rest stays', async () => {
    const memory = memoryStore()
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    const { message } = await tap(questionId, 'Flat B')
    await flush()
    const resumed = mainDispatches(workId).at(-1)!
    expect(resumed.prompt.text).toContain(': Flat B.')
    // Capture copies the continuation from the work's thread, as it does after every dispatch, and the report that follows.
    const ref = { threadId: resumed.threadId, lane: 'run' as const, activationId: workId }
    const [copy, report] = captured(memory, ref, [
      { id: 'cont', role: 'user', content: resumed.prompt.text, timestamp: f.store.now() } as ChatMessage,
      { id: 'rep', role: 'assistant', content: 'I booked a viewing of Flat B for Saturday.', timestamp: f.store.now() } as ChatMessage
    ])
    expect(journalText(copy!).text).toContain('Flat B')
    memory.forget(botId, { refs: [journaled(memory, message, 'owner_msg')], by: 'owner_ui' })
    // "Flat B" is short; the copies are found by the question, not by their length.
    const scrubbed = f.store.dispatch(workId, resumed.n)!.prompt.text
    expect(scrubbed).not.toContain('Flat B')
    expect(scrubbed).toContain('Carry on where you left off.')
    expect(journalText(copy!).text).not.toContain('Flat B')
    expect(journalText(copy!).text).toContain('Carry on where you left off.')
    expect(JSON.stringify(f.store.question(questionId)!.answer)).not.toContain('Flat B')
    // What the bot wrote itself is not a copy of the answer: it stays, as with notes.
    expect(journalText(report!).text).toBe('I booked a viewing of Flat B for Saturday.')
  })

  it('of the owner’s words the chat passed on: the chat’s question_answer call and the work’s copy go; of the question’s bubble: its ask_owner call and the line that quoted it', async () => {
    const memory = memoryStore()
    const { workId, work, questionId, bubble } = await workThatAsks()
    await endTurn(work)
    const own = await chat('Go with the second one', 'c1')
    await tool('question_answer', own.prepared, own.payload.threadId, { questionId, answer: 'The second one, Flat B' })
    await finish(f, own.payload, 'completed', { text: 'Got it.' })
    await flush()
    const resumed = mainDispatches(workId).at(-1)!
    const [askCall] = captured(memory, { threadId: mainDispatches(workId)[0]!.threadId, lane: 'run', activationId: workId }, [
      { id: 'ask', role: 'assistant', kind: 'tool_call', content: '', timestamp: f.store.now(), toolCall: { title: 'ask_owner', summary: '', details: [], status: 'complete', toolName: 'mcp__mousse__ask_owner', input: { question: FLATS.question, choices: FLATS.choices } } } as ChatMessage
    ])
    const [relayCall] = captured(memory, { threadId: own.payload.threadId, lane: 'chat', activationId: own.activation.id }, [
      { id: 'relay', role: 'assistant', kind: 'tool_call', content: '', timestamp: f.store.now(), toolCall: { title: 'question_answer', summary: '', details: [], status: 'complete', toolName: 'mcp__mousse__question_answer', input: { questionId, answer: 'The second one, Flat B' } } } as ChatMessage
    ])
    const [copy] = captured(memory, { threadId: resumed.threadId, lane: 'run', activationId: workId }, [{ id: 'cont', role: 'user', content: resumed.prompt.text, timestamp: f.store.now() } as ChatMessage])
    memory.forget(botId, { refs: [journaled(memory, own.message, 'owner_msg', 'chat')], by: 'owner_ui' })
    expect(journalText(relayCall!)).toMatchObject({ redacted_at: expect.any(String) })
    expect(journalText(relayCall!).text).not.toContain('Flat B')
    expect(f.store.dispatch(workId, resumed.n)!.prompt.text).not.toContain('Flat B')
    expect(journalText(copy!).text).not.toContain('Flat B')
    // The question itself is not forgotten yet: its ask_owner call stays.
    expect(journalText(askCall!).redacted_at).toBeNull()
    memory.forget(botId, { refs: [journaled(memory, bubble, 'notice')], by: 'owner_ui' })
    expect(journalText(askCall!)).toMatchObject({ redacted_at: expect.any(String) })
    expect(journalText(askCall!).text).not.toMatch(/flat/i)
  })

  it('of the bubble while the work’s asking turn still runs: the work ends with its line when the turn ends, and never reports', async () => {
    const memory = memoryStore()
    const { workId, work, bubble, asked } = await workThatAsks()
    memory.forget(botId, { refs: [journaled(memory, bubble, 'notice')], by: 'owner_ui' })
    await endTurn(work)
    expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'question_gone' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: questionGoneText('Flat hunt'), replyTo: { id: asked.id } })
    expect(chatOf(f, botId).some((message) => message.text.includes('I asked which flat'))).toBe(false)
  })

  it('of the bubble, then a restart cut the asking turn: the work ends with its line instead of carrying on', async () => {
    const memory = memoryStore()
    const { workId, work, bubble } = await workThatAsks()
    memory.forget(botId, { refs: [journaled(memory, bubble, 'notice')], by: 'owner_ui' })
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await restart()
    expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'question_gone' })
    expect(mainDispatches(workId)).toHaveLength(1)
    expect(chatOf(f, botId).at(-1)?.text).toBe(questionGoneText('Flat hunt'))
  })

  it('of the answer after the work read it: it stays with the work, and the bubble keeps no copy of it', async () => {
    const memory = memoryStore()
    const { workId, work, questionId, bubble } = await workThatAsks()
    await endTurn(work)
    const { message } = await tap(questionId, 'Flat B')
    await flush()
    expect(f.store.question(questionId)?.readAt).not.toBeNull()
    memory.forget(botId, { refs: [journaled(memory, message, 'owner_msg')], by: 'owner_ui' })
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { tapped: true, redacted: true } })
    expect(f.store.activation(workId)?.status).toBe('running')
    expect(chatOf(f, botId).find((row) => row.id === bubble.id)?.question?.answer).toBeUndefined()
  })

  it('of the question’s bubble: the work it waited on ends and says so, at once from the app and on the next tick otherwise', async () => {
    const memory = memoryStore()
    const { workId, work, bubble, questionId, asked } = await workThatAsks()
    await endTurn(work)
    // The app's Forget goes through the service, which settles the work at once.
    const forget = f.host.memory!.forget
    f.host.memory!.forget = (id, ref) => memory.forget(id, { refs: [ref], by: 'owner_ui' }) as ReturnType<typeof forget>
    f.bots.service.memoryForget(botId, journaled(memory, bubble, 'notice'))
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
    expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'question_gone' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: questionGoneText('Flat hunt'), replyTo: { id: asked.id } })
    expect(JSON.stringify(f.store.question(questionId)!.spec)).not.toMatch(/flat/i)

    // The bot's own memory_forget does not go through the service: the next tick ends the work.
    const second = await workThatAsks('Movers', 'w2', { question: 'Shall I book the cheaper movers?', yesNo: true })
    await endTurn(second.work)
    memory.forget(botId, { refs: [journaled(memory, second.bubble, 'notice')], by: 'chat' })
    expect(f.store.activation(second.workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    await f.bots.maintain()
    expect(f.store.activation(second.workId)).toMatchObject({ status: 'failed', endReason: 'question_gone' })
  })
})

describe('restarts', () => {
  it('while it waits: it still waits, and nothing is sent', async () => {
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    await restart()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    expect(mainDispatches(workId)).toHaveLength(1)
    // And the answer still carries it on after the restart.
    await tap(questionId, 'Flat A')
    await flush()
    expect(f.store.activation(workId)?.status).toBe('running')
  })

  it('between the answer and the resume: it carries on once, with the answer', async () => {
    const { workId, work, questionId } = await workThatAsks()
    await endTurn(work)
    // Answered, then Mousse stopped before the continuation was written (no run engine to send it).
    const runs = f.host.runs
    f.host.runs = () => null
    await tap(questionId, 'Flat A')
    await flush()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question_answered' })
    f.host.runs = runs
    await restart()
    expect(mainDispatches(workId)).toHaveLength(2)
    expect(mainDispatches(workId)[1]!.prompt.text).toContain('Your owner answered your question')
    await restart()
    expect(mainDispatches(workId)).toHaveLength(2)
  })

  it('right after ask_owner, its turn cut by the restart: it waits for the answer instead of carrying on', async () => {
    const { workId, work } = await workThatAsks()
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await restart()
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    expect(mainDispatches(workId)).toHaveLength(1)

    // The control: work cut the same way without a question carries on as before.
    const { workId: plain } = await handOff('Weather', 'w2')
    const running = await start(f, plain)
    f.runs.markTerminal(running.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    await restart()
    expect(mainDispatches(plain).at(-1)!.prompt.text).toContain('Mousse restarted while you were working.')
  })
})

describe('where it is never offered', () => {
  it('a scheduled run is not offered it, and is told to ask in its report', async () => {
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Check new listings.', occurrenceAt: new Date(f.clock.now).toISOString() })
    if (scheduled.kind !== 'started') throw new Error(scheduled.kind)
    await flush()
    const run = await start(f, scheduled.activationId)
    expect(run.prepared.authority.appTools.has('ask_owner')).toBe(false)
    expect(f.bots.askOwner(botId, scheduled.activationId, { question: 'Which?', choices: [{ label: 'A' }, { label: 'B' }], other: true })).toEqual({ asked: false, text: QUESTION_NOT_OFFERED_TEXT })
    expect(f.store.countQuestions(botId, {})).toBe(0)
  })

  it('work is offered ask_owner but not question_answer; a consult is offered neither', async () => {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
    const { workId } = await handOff('Flat hunt', 'w1')
    const work = await start(f, workId)
    expect(work.prepared.authority.appTools.has('ask_owner')).toBe(true)
    expect(work.prepared.authority.appTools.has('question_answer')).toBe(false)
    const asked = work.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await flush()
    const consultN = f.store.dispatches(workId).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = f.bots.prepare(payloadOf(f, workId, consultN))
    if ('refused' in consult) throw new Error(consult.refused)
    expect(consult.authority.appTools.has('ask_owner')).toBe(false)
    expect(consult.authority.appTools.has('question_answer')).toBe(false)
    void asked.catch(() => undefined)
  })
})
