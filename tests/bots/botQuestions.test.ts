/**
 * A bot's questions in its chat (`ask_owner`, issue #1123), over a real engine and a real `bots.db`: the question is
 * asked through the bot's own tool, shown as its own bubble under the turn's reply, answered by a tap through the
 * registered `bots.questions.answer` handler or by a reply in the owner's words, and moved past by any other message.
 *
 * What each case covers, by what can happen to a question:
 * - states: open, moved on, answered, withdrawn (stopped turn, wall), redacted (Forget)
 * - actors: a tap, a typed reply, another message, a second tap (or another device), Stop, escalate before and after
 * - owner's words: a tapped label never counts as theirs (threads, models); a typed answer does
 * - limits: one per chat turn, six open per bot, twenty a day; work is not offered it
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotMemoryAdmin } from '../../src/mms/bots/memory/admin'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { botTools, USE_MODEL_REFUSED } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { QUESTION_AFTER_ASK_TEXT, QUESTION_ASKED_TEXT, QUESTION_CHAT_ONLY_TEXT, QUESTIONS_ENOUGH_TEXT } from '../../src/shared/bots/personal/questions'
import { BOT_ASK_DEFERRED_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
const OPUS: BotModelOption = { instanceId: 'claude', entry: 'Claude Code', model: 'claude-opus-4-6', label: 'Claude Opus 4.6', efforts: [], credential: 'subscription', names: ['claude-opus-4-6', 'claude opus 4.6', 'opus 4.6', 'opus'] }

let f: BotFixture
let domains: DomainHandlerRegistry
let botId: string

beforeEach(async () => {
  f = botFixture()
  domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  botId = (await createBot(f, { reply: 'Hi, I find flats.' })).botId
})
afterEach(() => f.close())

const call = <T = unknown>(method: string, params: Record<string, unknown>): Promise<T> => domains.dispatch(context, method, params) as Promise<T>

/** The bot's own tools, wired to the engine as the profile wires them; `pickable` is what `use_model` may pick. */
const tools = new Map(botTools(() => ({ host: f.bots.tools, models: { pickable: async () => [OPUS] } })).map((tool) => [tool.name, tool]))
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

const FLATS = { question: 'Which flat should I book a viewing for?', choices: [{ label: 'Flat A', detail: '2 bed, Hackney, £1,900' }, 'Flat B'] }

/** The owner writes; the chat turn their message started, running. */
async function chatTurn(text: string, id: string, replyTo?: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id, ...(replyTo ? { replyTo } : {}) })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { payload, prepared } = await start(f, activation.id)
  return { message, activation, payload, prepared }
}

/** A chat turn that asks `args` with `ask_owner` and ends with `reply`; its question's bubble. */
async function asked(args: Record<string, unknown> = FLATS, reply = 'I found two.', id = 'q1') {
  const turn = await chatTurn('Find me a flat to view this week.', id)
  const answer = await tool('ask_owner', turn.prepared, turn.payload.threadId, args)
  expect(answer.isError).toBeFalsy()
  expect(JSON.parse(answer.text)).toEqual({ asked: true, note: QUESTION_ASKED_TEXT })
  await finish(f, turn.payload, 'completed', { text: reply })
  const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === turn.activation.id)!
  return { turn, bubble }
}

/** A tap through the registered handler, as the app sends it. */
const tap = (questionId: string, choice: string, clientRequestId = `tap-${Math.random().toString(16).slice(2)}`) =>
  call<{ message: BotChatMessage; question?: BotChatMessage }>('bots.questions.answer', { botId, questionId, choice, clientRequestId })

describe('a question in the chat', () => {
  it('shows as its own bubble under the reply, with its answers to tap and, for an app that does not draw them, as text', async () => {
    const { turn, bubble } = await asked()
    const rows = chatOf(f, botId).filter((message) => message.activationId === turn.activation.id && message.author === 'bot')
    expect(rows.map((message) => message.text.split('\n')[0])).toEqual(['I found two.', 'Which flat should I book a viewing for?'])
    expect(bubble.question).toMatchObject({ choices: [{ label: 'Flat A', detail: '2 bed, Hackney, £1,900' }, { label: 'Flat B' }], other: true, status: 'open' })
    // An older app shows the whole text; a new one stops at `plainFrom` and draws the buttons.
    expect(bubble.text.slice(0, bubble.plainFrom)).toBe('Which flat should I book a viewing for?')
    expect(bubble.text.slice(bubble.plainFrom).trim()).toBe('Flat A · Flat B · Something else')
    // The journal (memory, search, the chat pack) has the choices with the question.
    expect(f.journal.find((row) => row.sourceKey === `bm:${bubble.id}`)?.text).toContain('Flat A · Flat B')
  })

  it('a turn that asked and said nothing else shows the question alone', async () => {
    const { turn } = await asked(FLATS, '')
    expect(chatOf(f, botId).filter((message) => message.activationId === turn.activation.id && message.author === 'bot').map((message) => message.id)).toEqual([`bm_${turn.activation.id}_q1`])
  })

  it('a tap is the owner’s reply: it answers the question, the bubble says so, and the next chat turn starts with the question', async () => {
    const { bubble } = await asked()
    const { message, question } = await tap(bubble.question!.questionId, 'Flat B')
    expect(message).toMatchObject({ author: 'owner', text: 'Flat B', replyTo: { id: bubble.id }, answers: { questionId: bubble.question!.questionId, tapped: true } })
    expect(question?.question).toMatchObject({ status: 'answered', answer: 'Flat B', answeredWith: 'choice' })
    const next = f.store.laneActivations(botId, 'chat', ['running', 'queued']).at(-1)!
    expect(next.trigger.kind === 'manual' && next.trigger.input).toBe('(Answering your question: "Which flat should I book a viewing for?")\n\nFlat B')
  })

  it('a tapped answer is not the owner’s own words: its turn reads threads only and cannot switch models; a typed one can', async () => {
    const { bubble } = await asked({ question: 'Which model should I use?', choices: ['Opus 4.6', 'Something cheaper'] })
    await tap(bubble.question!.questionId, 'Opus 4.6')
    const tapped = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const tappedTurn = await start(f, tapped.id)
    expect(f.bots.ownerWords(botId, tapped.id)).toBe('')
    expect(tappedTurn.prepared.authority.threadsReadOnly).toBe('not_owner')
    const refused = JSON.parse((await tool('use_model', tappedTurn.prepared, tappedTurn.payload.threadId, { model: 'Opus 4.6', scope: 'now' })).text)
    expect(refused).toEqual({ ok: false, reason: USE_MODEL_REFUSED })
    await finish(f, tappedTurn.payload, 'completed', { text: 'OK.' })
    // The same words typed by the owner are theirs: the danger is real, and only the tap is held back.
    const typed = await chatTurn('Use Opus 4.6 for this', 'typed')
    expect(typed.prepared.authority.threadsReadOnly).toBeUndefined()
    expect(JSON.parse((await tool('use_model', typed.prepared, typed.payload.threadId, { model: 'Opus 4.6', scope: 'now' })).text)).toMatchObject({ ok: true })
  })

  it('a reply in the owner’s own words on the bubble answers it, and those words are theirs', async () => {
    const { bubble } = await asked()
    const turn = await chatTurn('Neither, find one nearer the park', 'typed', bubble.id)
    expect(f.store.question(bubble.question!.questionId)).toMatchObject({ status: 'answered', answer: { text: 'Neither, find one nearer the park', by: 'owner' }, answerMessage: turn.message.id })
    expect(turn.activation.trigger.kind === 'manual' && turn.activation.trigger.input).toBe('(Answering your question: "Which flat should I book a viewing for?")\n\nNeither, find one nearer the park')
    expect(f.bots.ownerWords(botId, turn.activation.id)).toBe('Neither, find one nearer the park')
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question).toMatchObject({ status: 'answered', answer: 'Neither, find one nearer the park', answeredWith: 'text' })
  })

  it('any other message moves it on, and the bot hears what it had asked; a later tap still answers it', async () => {
    const { bubble } = await asked()
    const other = await chatTurn('Also, what is the weather tomorrow?', 'other')
    expect(f.store.question(bubble.question!.questionId)).toMatchObject({ status: 'moved_on', answerMessage: other.message.id })
    expect(other.activation.trigger.kind === 'manual' && other.activation.trigger.input).toBe(
      '(You had asked: "Which flat should I book a viewing for?" (Flat A · Flat B · Something else). If this message answers it, go on from there; if you still need to know, ask again.)\n\nAlso, what is the weather tomorrow?')
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question?.status).toBe('moved_on')
    await finish(f, other.payload, 'completed', { text: 'Sunny.' })
    const { question } = await tap(bubble.question!.questionId, 'Flat A')
    expect(question?.question).toMatchObject({ status: 'answered', answer: 'Flat A' })
  })

  it('a second answer is refused before anything is written, and so is a question of another bot or none', async () => {
    const { bubble } = await asked()
    const first = await tap(bubble.question!.questionId, 'Flat A', 'tap-1')
    const rows = chatOf(f, botId).length
    // Another tap (a second device, a double click) is refused, whatever it picks.
    await expect(tap(bubble.question!.questionId, 'Flat B')).rejects.toMatchObject({ code: 'question_answered' })
    await expect(tap(bubble.question!.questionId, 'Flat A')).rejects.toMatchObject({ code: 'question_answered' })
    await expect(tap('q_00000000-0000-0000-0000-000000000000', 'Flat A')).rejects.toMatchObject({ code: 'question_not_found' })
    expect(chatOf(f, botId)).toHaveLength(rows)
    // The same request again (the app retrying it) is the first answer, and adds nothing.
    expect((await tap(bubble.question!.questionId, 'Flat A', 'tap-1')).message.id).toBe(first.message.id)
    expect(chatOf(f, botId)).toHaveLength(rows)
    expect(f.store.laneActivations(botId, 'chat', ['queued', 'running', 'done']).filter((row) => row.idempotencyKey.startsWith('answer:'))).toHaveLength(1)
  })

  it('a tap while the chat waits at a permission ask leaves the ask open and waits its turn behind it', async () => {
    const { bubble } = await asked()
    const other = await chatTurn('Book the Hackney one for me', 'b1')
    other.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To book it on the site.' })
    await finish(f, other.payload, 'completed', { text: 'I need the browser for that.' })
    expect(f.store.activation(other.activation.id)?.status).toBe('waiting_grant')
    // The question was moved on by that message, and a tap still answers it.
    const { message } = await tap(bubble.question!.questionId, 'Flat A')
    expect(chatOf(f, botId).find((row) => row.ask)?.ask?.status).toBe('open')
    expect(f.store.activation(other.activation.id)?.status).toBe('waiting_grant')
    const queued = f.store.activation(message.activationId!)!
    expect(queued).toMatchObject({ status: 'queued', lane: 'chat' })
    expect(queued.idempotencyKey.startsWith('answer:')).toBe(true)
  })

  it('a label it does not have is refused', async () => {
    const { bubble } = await asked()
    await expect(tap(bubble.question!.questionId, 'Flat C')).rejects.toMatchObject({ code: 'invalid_params' })
    expect(f.store.question(bubble.question!.questionId)?.status).toBe('open')
  })
})

describe('what a question never does', () => {
  it('ask_owner after escalate in the same turn is refused: a tap at the wall would count as Not now', async () => {
    const turn = await chatTurn('Book the viewing for me', 'w1')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To book it on the site.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    expect(await tool('ask_owner', turn.prepared, turn.payload.threadId, FLATS)).toEqual({ text: QUESTION_AFTER_ASK_TEXT, isError: true })
    await finish(f, turn.payload, 'completed', { text: 'I need the browser.' })
    expect(chatOf(f, botId).some((message) => message.question)).toBe(false)
  })

  it('escalate after ask_owner wins: the question is withdrawn unshown, and the wall’s answer tells the bot to ask again', async () => {
    const turn = await chatTurn('Book a viewing', 'w2')
    expect(JSON.parse((await tool('ask_owner', turn.prepared, turn.payload.threadId, FLATS)).text).asked).toBe(true)
    turn.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To book it.' })
    await finish(f, turn.payload, 'completed', { text: 'I need the browser first.' })
    expect(chatOf(f, botId).some((message) => message.question)).toBe(false)
    expect(f.store.activationQuestions(turn.activation.id)).toMatchObject([{ status: 'withdrawn', messageId: null }])
    const ask = chatOf(f, botId).find((message) => message.ask?.status === 'open')!
    await f.bots.service.answer(botId, ask.ask!.askId, 'not_now')
    await flush()
    const continued = f.store.lastMainDispatch(turn.activation.id)!
    expect(continued.kind).toBe('continue')
    expect(continued.prompt.text).toContain('Your question "Which flat should I book a viewing for?" was not shown to the owner, because you also asked for a permission. Ask it again with ask_owner if you still need to know.')
  })

  it('a turn the owner stopped shows no question', async () => {
    const turn = await chatTurn('Find me a flat', 's1')
    await tool('ask_owner', turn.prepared, turn.payload.threadId, FLATS)
    await f.bots.service.chatStop(botId)
    await finish(f, turn.payload, 'interrupted', { text: '' })
    expect(chatOf(f, botId).some((message) => message.question)).toBe(false)
    expect(f.store.activationQuestions(turn.activation.id)[0]?.status).toBe('withdrawn')
  })

  it('keeps to one question per chat turn, six open per bot and twenty a day', async () => {
    const turn = await chatTurn('Find me a flat', 'c1')
    expect(JSON.parse((await tool('ask_owner', turn.prepared, turn.payload.threadId, FLATS)).text).asked).toBe(true)
    expect(await tool('ask_owner', turn.prepared, turn.payload.threadId, { question: 'And when?', yesNo: true })).toEqual({ text: QUESTIONS_ENOUGH_TEXT, isError: true })
    await finish(f, turn.payload, 'completed', { text: 'Two options.' })
    const seed = (n: number, status: 'open' | 'answered') => {
      for (let i = 0; i < n; i += 1) {
        const id = `q_seed-${status}-${i}`
        f.store.insertQuestion({ id, botId, activationId: `act-seed-${status}-${i}`, dispatchN: 1, lane: 'chat', spec: { question: 'Q', choices: [{ label: 'A' }, { label: 'B' }], other: false }, createdAt: f.store.now() })
        if (status === 'answered') f.store.answerQuestion(id, { choice: 'A', by: 'owner' }, 'bm_x')
      }
    }
    // The owner's next message moves the first one on; six others still open are the most.
    seed(6, 'open')
    const sixth = await chatTurn('Anything else?', 'c2')
    expect(await tool('ask_owner', sixth.prepared, sixth.payload.threadId, FLATS)).toEqual({ text: QUESTIONS_ENOUGH_TEXT, isError: true })
    await finish(f, sixth.payload, 'completed', { text: 'No.' })
    // Answered ones free their places, but twenty in a day is the most (7 so far).
    f.store.run("UPDATE bot_questions SET status = 'answered' WHERE bot_id = ?", botId)
    seed(13, 'answered')
    const many = await chatTurn('And now?', 'c3')
    expect(await tool('ask_owner', many.prepared, many.payload.threadId, FLATS)).toEqual({ text: QUESTIONS_ENOUGH_TEXT, isError: true })
    await finish(f, many.payload, 'completed', { text: 'Nothing more.' })
    // A day later it may ask again.
    f.clock.now += 25 * 60 * 60_000
    const later = await chatTurn('Today?', 'c4')
    expect(JSON.parse((await tool('ask_owner', later.prepared, later.payload.threadId, FLATS)).text).asked).toBe(true)
  })

  it('is offered to a chat turn, never to work, and work that calls it is told to ask in its report', async () => {
    const turn = await chatTurn('Look into flats', 'o1')
    expect(turn.prepared.authority.appTools.has('ask_owner')).toBe(true)
    const started = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Flats', brief: 'Find flats.', key: 'k1' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    const work = await start(f, started.workId)
    expect(work.prepared.authority.appTools.has('ask_owner')).toBe(false)
    expect(await tool('ask_owner', work.prepared, work.payload.threadId, FLATS)).toEqual({ text: QUESTION_CHAT_ONLY_TEXT, isError: true })
    expect(f.store.countQuestions(botId, {})).toBe(0)
  })
})

describe('forgetting, deleting and exporting', () => {
  /** A real journal over the same `bots.db` (the fixture's is a stand-in), with one chat row in it. */
  const journaled = (memory: BotMemoryStore, message: BotChatMessage, kind: 'owner_msg' | 'bot_msg') => {
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind, lane: 'chat', sourceKey: `bm:${message.id}`, who: kind === 'owner_msg' ? 'owner' : 'bot', text: message.text }))
    return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
  }

  it('forgetting the bubble removes the question and its answers and withdraws it; forgetting a typed answer removes the answer', async () => {
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    const { bubble } = await asked()
    expect(memory.forget(botId, { refs: [journaled(memory, bubble, 'bot_msg')], by: 'owner_ui' })).not.toHaveProperty('error')
    const forgotten = f.store.question(bubble.question!.questionId)!
    expect(forgotten.status).toBe('withdrawn')
    expect(JSON.stringify(forgotten.spec)).not.toMatch(/Flat|flat/)
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.text).not.toMatch(/Flat/)

    f.clock.now += 60_000
    const second = await asked({ question: 'Shall I add the Hackney one to your list?', yesNo: true }, 'Found it.', 'q2')
    const answer = await chatTurn('Yes, and note the 4th floor walk-up', 'a2', second.bubble.id)
    await finish(f, answer.payload, 'completed', { text: 'Added.' })
    memory.forget(botId, { refs: [journaled(memory, answer.message, 'owner_msg')], by: 'owner_ui' })
    const kept = f.store.question(second.bubble.question!.questionId)!
    expect(JSON.stringify(kept.answer)).not.toContain('walk-up')
    expect(chatOf(f, botId).find((message) => message.id === second.bubble.id)?.question).toMatchObject({ status: 'answered' })
    expect(chatOf(f, botId).find((message) => message.id === second.bubble.id)?.question?.answer).toBeUndefined()
  })

  it('deleting the bot withdraws its open questions, and the purge removes them', async () => {
    const { bubble } = await asked()
    await f.bots.remove(botId)
    expect(f.store.question(bubble.question!.questionId)?.status).toBe('withdrawn')
    f.store.deleteBotRows(botId)
    expect(f.store.question(bubble.question!.questionId)).toBeUndefined()
  })

  it('an export of the bot’s memory carries its questions and their answers', async () => {
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    const { bubble } = await asked()
    await tap(bubble.question!.questionId, 'Flat B')
    const dir = mkdtempSync(join(tmpdir(), 'bot-export-'))
    try {
      const { files } = await createBotMemoryAdmin({ store: memory }).export(botId, dir)
      const file = files.find((path) => path.endsWith('questions.jsonl'))!
      expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({ question: 'Which flat should I book a viewing for?', status: 'answered', answer: { choice: 'Flat B', by: 'owner' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
