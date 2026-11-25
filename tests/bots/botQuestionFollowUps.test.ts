/**
 * Follow-ups when the owner doesn't answer a bot's question (issue #1123, PR 3), over a real engine and a real `bots.db`
 * on a fake clock: the bot picks one when it asks (`ifNoAnswer`), and the reminders' timer (`armDue`,
 * `deliverDueReminders`, the startup pass) carries it out from `next_at`, so it survives a restart.
 *
 * What each case covers:
 * - a nudge: a fixed line from Mousse with no model call, the question's buttons again, at most two, at its time
 * - limits: the bot's nudges an hour apart across its questions; nothing is held for the night (a default too)
 * - a default: work carries on with "…so go with "A"…" (no owner row, same grant); a chat question queues a turn that is
 *   not the owner's (threads read-only, no owner's words)
 * - races: the owner writes in the chat first (no chat follow-up after it); a default that falls due while a chat turn
 *   the owner's message started runs waits for it, and that turn's `question_answer` wins
 * - questions that never follow up: answered, stopped (withdrawn), bubble forgotten, answer forgotten before it was read
 * - restarts: an overdue default is applied once and says how late it is; an overdue nudge is posted once
 * - a late answer: a note to work that still runs, the answer itself while the default is unread, a chat turn after the
 *   work ended
 * - Forget: the default's line goes from the work's prompt and from the chat turn it queued
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_JOURNAL_ERROR, BotEngine, noteSteerText } from '../../src/mms/bots/activation/BotEngine'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { capturedRows } from '../../src/mms/bots/memory/capture'
import type { ChatMessage } from '../../src/shared/types'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { clockTime } from '../../src/mms/bots/chat/projection'
import { botNotificationContent, botNotificationKind } from '../../src/main/notifications/threadNotification'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import { defaultChatInput, defaultWorkLine, lateAnsweringLine, lateWorkNote, NUDGE_TEXT } from '../../src/shared/bots/personal/questions'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, start, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
const MIN = 60_000
const HOUR = 60 * MIN

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

const FLATS = { question: 'Which flat should I book a viewing for?', choices: ['Flat A', 'Flat B'] }
/** A minor choice the bot may settle itself after half an hour. */
const DEFAULT_A = { ...FLATS, ifNoAnswer: 'default', default: 'Flat A', after: 30 }

/** The owner writes; the chat turn their message started, running. */
async function chat(text: string, id: string, replyTo?: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id, ...(replyTo ? { replyTo } : {}) })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

/** A chat turn that asks `args` and ends; its question's bubble. */
async function chatAsks(args: Record<string, unknown>, id = 'c-ask') {
  const turn = await chat('Find me a flat to view this week.', id)
  expect(JSON.parse((await tool('ask_owner', turn.prepared, turn.payload.threadId, args)).text)).toMatchObject({ asked: true })
  await finish(f, turn.payload, 'completed', { text: 'I found two.' })
  const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === turn.activation.id)!
  return { bubble, questionId: bubble.question!.questionId }
}

/** Work the chat hands off, which asks `args` and ends its turn, as its model would once every call is refused. */
async function workAsks(args: Record<string, unknown>, title = 'Flat hunt', key = 'w1') {
  const turn = await chat(`Please do: ${title}`, `m-${key}`)
  const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title, brief: `${title}: find two and book a viewing.`, key })
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  const work = await start(f, workId)
  expect(JSON.parse((await tool('ask_owner', work.prepared, work.payload.threadId, args)).text)).toMatchObject({ asked: true })
  await finish(f, work.payload, 'completed', { text: 'I asked which flat.' })
  const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === workId)!
  return { workId, work, asked: turn.message, bubble, questionId: bubble.question!.questionId }
}

/** The clock reaches `ms`, and the reminders' timer fires, as its timer would. */
async function reach(ms: number) {
  f.clock.now = ms
  await f.bots.deliverDueReminders()
  await flush()
}

const tap = (questionId: string, choice: string) => call<{ message: BotChatMessage; question?: BotChatMessage }>('bots.questions.answer', { botId, questionId, choice, clientRequestId: `tap-${Math.random().toString(16).slice(2)}` })
const nudgesOf = (questionId: string) => chatOf(f, botId).filter((message) => message.question?.questionId === questionId && message.question.nudge)
const bubbleNow = (id: string) => chatOf(f, botId).find((message) => message.id === id)!
const mainDispatches = (workId: string) => f.store.dispatches(workId).filter((dispatch) => dispatch.kind === 'start' || dispatch.kind === 'continue')

async function restart(advance = 0) {
  f.bots.close()
  f.clock.now += advance
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
}

describe('a nudge', () => {
  it("of a question asked with others still comes after the owner taps one of them, and so does its sibling's default", async () => {
    const turn = await chat('Plan the viewings.', 'c-batch')
    const asked = JSON.parse((await tool('ask_owner', turn.prepared, turn.payload.threadId, { questions: [
      { question: 'Which day?', yesNo: true },
      { question: 'Which flat?', choices: ['Flat A', 'Flat B'], ifNoAnswer: 'default', default: 'Flat A', after: 30 },
      { question: 'Book the movers?', yesNo: true }
    ] })).text) as { questionIds: string[] }
    await finish(f, turn.payload, 'completed', { text: 'A few things first.' })
    const [day, flat, movers] = asked.questionIds as [string, string, string]
    const shown = Date.parse(chatOf(f, botId).find((message) => message.question?.questionId === movers)!.at)
    await tap(day, 'Yes')
    await flush()
    const answering = f.store.laneActivations(botId, 'chat', ['running'])[0]
    if (answering) await finish(f, (await start(f, answering.id)).payload, 'completed', { text: 'Noted.' })
    expect([f.store.question(flat)?.status, f.store.question(movers)?.status]).toEqual(['open', 'open'])
    await reach(shown + 30 * MIN)
    expect(f.store.question(flat)?.status).toBe('defaulted')
    await reach(shown + HOUR)
    expect(nudgesOf(movers)).toHaveLength(1)
  })

  it('comes at its time as a fixed line under the question, with its buttons and no model call; a second a day later, never a third', async () => {
    const { bubble, questionId } = await chatAsks(FLATS)
    const shown = Date.parse(bubble.at)
    // The timer waits for it: an hour, the default.
    expect(f.timers.at(-1)!.ms).toBe(HOUR)
    const models = f.resolved.length
    const activations = f.store.listActivations(botId).length
    await reach(shown + HOUR - 1)
    expect(nudgesOf(questionId)).toEqual([])
    const sent: BotChatMessage[] = []
    f.bots.events.on('message', (payload: unknown) => sent.push((payload as { message: BotChatMessage }).message))
    await reach(shown + HOUR)
    const [first] = nudgesOf(questionId)
    expect(first).toMatchObject({ author: 'bot', text: `${NUDGE_TEXT}\n\nFlat A · Flat B · Something else`, plainFrom: NUDGE_TEXT.length, replyTo: { id: bubble.id }, question: { questionId, status: 'open', nudge: true, choices: [{ label: 'Flat A' }, { label: 'Flat B' }] } })
    expect(first!.question?.nudged).toBeUndefined()
    expect(f.store.message(first!.id)?.tell).toBe('soon')
    expect(botNotificationKind(first!, Date.parse(first!.at))).toBe('question')
    expect(f.resolved.length).toBe(models)
    expect(f.store.listActivations(botId)).toHaveLength(activations)
    // The nudge takes the buttons over: the bubble shows them no more, in open windows too.
    expect(bubbleNow(bubble.id).question?.nudged).toBe(true)
    expect(sent.filter((message) => message.id === bubble.id).at(-1)?.question?.nudged).toBe(true)
    await reach(shown + HOUR + 24 * HOUR)
    expect(nudgesOf(questionId)).toHaveLength(2)
    expect(nudgesOf(questionId).map((nudge) => nudge.question?.nudged)).toEqual([true, undefined])
    await reach(shown + 10 * 24 * HOUR)
    expect(nudgesOf(questionId)).toHaveLength(2)
    expect(f.store.question(questionId)).toMatchObject({ status: 'open', nudges: 2, nextAt: null })
  })

  it('a tap on the nudge answers the question, and both show it', async () => {
    const { bubble, questionId } = await chatAsks(FLATS)
    await reach(Date.parse(bubble.at) + HOUR)
    const [nudge] = nudgesOf(questionId)
    // "Other…" on the nudge replies to it: the owner's words answer the question too.
    const { message } = await f.bots.service.chatSend({ botId, text: 'Neither, nearer the park', clientRequestId: 'typed', replyTo: nudge!.id })
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { text: 'Neither, nearer the park', by: 'owner' }, answerMessage: message.id })
    expect(f.store.activation(f.store.laneActivations(botId, 'chat', ['running'])[0]!.id)!.trigger).toMatchObject({ input: expect.stringContaining('(Answering your question: "Which flat should I book a viewing for?")') })
    expect(bubbleNow(bubble.id).question?.status).toBe('answered')
    expect(bubbleNow(nudge!.id).question?.status).toBe('answered')
  })

  it('a bot’s nudges are an hour apart across its questions, and are not held for the night', async () => {
    const one = await workAsks(FLATS, 'Flat hunt', 'w1')
    const two = await workAsks({ question: 'Shall I book the cheaper movers?', yesNo: true }, 'Movers', 'w2')
    const due = Date.parse(two.bubble.at) + HOUR
    await reach(due)
    expect(nudgesOf(one.questionId)).toHaveLength(1)
    expect(nudgesOf(two.questionId)).toEqual([])
    expect(f.store.question(two.questionId)?.nextAt).toBe(new Date(Date.parse(nudgesOf(one.questionId)[0]!.at) + HOUR).toISOString())
    await reach(Date.parse(nudgesOf(one.questionId)[0]!.at) + HOUR)
    expect(nudgesOf(two.questionId)).toHaveLength(1)
    // A question asked at 21:30 (this computer's time) nudges at 22:30.
    f.clock.now = new Date(2026, 10, 7, 21, 30).getTime()
    const late = await workAsks({ question: 'Shall I order the boxes?', yesNo: true }, 'Boxes', 'w3')
    const nudgeAt = Date.parse(late.bubble.at) + HOUR
    expect(f.store.question(late.questionId)?.nextAt).toBe(new Date(nudgeAt).toISOString())
    await reach(nudgeAt)
    expect(nudgesOf(late.questionId)).toHaveLength(1)
  })
})

describe('a default', () => {
  it('carries work on at its time with the bot’s own choice: no owner row, the same grant, and the bubble says it went with it', async () => {
    const { workId, work, bubble, questionId } = await workAsks(DEFAULT_A)
    const at = Date.parse(bubble.at) + 30 * MIN
    expect(bubble.question).toMatchObject({ default: 'Flat A', defaultAt: new Date(at).toISOString() })
    expect(f.bots.questionLines(botId)[0]).toContain(`If they haven't answered by ${clockTime(new Date(at).toISOString())}, it goes with "Flat A".`)
    await reach(at - 1)
    expect(mainDispatches(workId)).toHaveLength(1)
    const rows = chatOf(f, botId).length
    await reach(at)
    expect(f.store.question(questionId)).toMatchObject({ status: 'defaulted', answer: { choice: 'Flat A', by: 'default' }, answerMessage: null })
    expect(bubbleNow(bubble.id).question).toMatchObject({ status: 'defaulted', by: 'default', answer: 'Flat A' })
    // Nothing the owner said is written: the bubble changed, no row was added.
    expect(chatOf(f, botId)).toHaveLength(rows)
    expect(mainDispatches(workId).at(-1)!.prompt.text).toBe(`[Mousse] ${defaultWorkLine(FLATS.question, 'Flat A', 30 * MIN)} Carry on where you left off.`)
    const resumed = await start(f, workId, mainDispatches(workId).at(-1)!.n)
    expect(resumed.prepared.policy.tools?.allow).toEqual(work.prepared.policy.tools?.allow)
    expect(resumed.prepared.authority.threadsReadOnly).toBe(work.prepared.authority.threadsReadOnly)
    await finish(f, resumed.payload, 'completed', { text: 'No answer, so I went with Flat A and booked Saturday.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'No answer, so I went with Flat A and booked Saturday.' })
  })

  it('queues a chat turn of its own for a chat question, not the owner’s: it may act on their threads (#1359) but has none of their words', async () => {
    const { bubble, questionId } = await chatAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    expect(f.store.question(questionId)?.status).toBe('defaulted')
    const turn = f.store.activationByKey(`question:${questionId}:default`)!
    expect(turn).toMatchObject({ lane: 'chat', trigger: { kind: 'manual', input: defaultChatInput(FLATS.question, 'Flat A', 30 * MIN) } })
    expect(turn.trigger).not.toHaveProperty('owner')
    const running = await start(f, turn.id)
    // It carries on the owner's work, so it may act on their threads like a wake or a thread's notice.
    expect(running.prepared.authority).not.toHaveProperty('threadsReadOnly')
    expect(f.bots.ownerWords(botId, turn.id)).toBe('')
    await finish(f, running.payload, 'completed', { text: 'No answer, so I went with Flat A.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: 'No answer, so I went with Flat A.' })
    expect(bubbleNow(bubble.id).question).toMatchObject({ status: 'defaulted', answer: 'Flat A' })
  })

  it('is not held for the night: one due at 22:15 (this computer\'s time) goes ahead at 22:15', async () => {
    f.clock.now = new Date(2026, 10, 7, 21, 45).getTime()
    const { workId, questionId, bubble } = await workAsks(DEFAULT_A)
    const at = Date.parse(bubble.at) + 30 * MIN
    expect(bubble.question?.defaultAt).toBe(new Date(at).toISOString())
    await reach(at)
    expect(f.store.question(questionId)?.status).toBe('defaulted')
    expect(mainDispatches(workId).at(-1)!.prompt.text).toContain('so go with "Flat A"')
  })
})

describe('the owner first', () => {
  it('any message from the owner moves a chat question on: no nudge and no default after it', async () => {
    const { bubble, questionId } = await chatAsks(DEFAULT_A)
    const other = await chat('Actually, what is the weather tomorrow?', 'other')
    await finish(f, other.payload, 'completed', { text: 'Sunny.' })
    await reach(Date.parse(bubble.at) + 3 * 24 * HOUR)
    expect(f.store.question(questionId)?.status).toBe('moved_on')
    expect(f.store.activationByKey(`question:${questionId}:default`)).toBeUndefined()
    expect(nudgesOf(questionId)).toEqual([])
  })

  it('a work default due while a chat turn the owner’s message started runs waits for it to end', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    const at = Date.parse(bubble.at) + 30 * MIN
    const own = await chat('Hmm, let me think about the flats', 'c1')
    await reach(at)
    expect(f.store.question(questionId)?.status).toBe('open')
    expect(mainDispatches(workId)).toHaveLength(1)
    await finish(f, own.payload, 'completed', { text: 'Take your time.' })
    await reach(at + 60_000)
    expect(f.store.question(questionId)?.status).toBe('defaulted')
  })

  it('…and when that turn passes on the owner’s answer, the answer wins and no default is applied', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    const at = Date.parse(bubble.at) + 30 * MIN
    const own = await chat('Go with the second one', 'c1')
    await reach(at)
    expect(JSON.parse((await tool('question_answer', own.prepared, own.payload.threadId, { questionId, answer: 'The second one, Flat B' })).text)).toMatchObject({ ok: true })
    await finish(f, own.payload, 'completed', { text: 'Got it.' })
    await reach(at + 60_000)
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { by: 'chat' } })
    expect(mainDispatches(workId).at(-1)!.prompt.text).toContain('in the chat: The second one, Flat B.')
  })
})

describe('a question that never follows up', () => {
  const memoryStore = () => new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  function journaled(memory: BotMemoryStore, message: BotChatMessage, kind: 'owner_msg' | 'notice'): string {
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind, lane: 'run', sourceKey: `bm:${message.id}`, who: kind === 'owner_msg' ? 'owner' : 'bot', text: message.text, ...(message.activationId ? { activationId: message.activationId } : {}) }))
    return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
  }

  it.each([
    ['answered with a tap', 'answered', async (q: Awaited<ReturnType<typeof workAsks>>) => { await tap(q.questionId, 'Flat B') }],
    ['withdrawn by Stop', 'withdrawn', async (q: Awaited<ReturnType<typeof workAsks>>) => { await f.bots.stopWork(botId, q.workId) }],
    ['withdrawn when its bubble is forgotten', 'withdrawn', async (q: Awaited<ReturnType<typeof workAsks>>) => {
      const memory = memoryStore()
      memory.forget(botId, { refs: [journaled(memory, q.bubble, 'notice')], by: 'owner_ui' })
    }],
    ['open again, with no follow-up, when its answer is forgotten before the work read it', 'open', async (q: Awaited<ReturnType<typeof workAsks>>) => {
      // Nothing starts while the bot's journal cannot be written: the answer waits, unread.
      f.store.setError(botId, { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
      const { message } = await tap(q.questionId, 'Flat B')
      const memory = memoryStore()
      memory.forget(botId, { refs: [journaled(memory, message, 'owner_msg')], by: 'owner_ui' })
    }]
  ])('%s', async (_name, status, end) => {
    const q = await workAsks(DEFAULT_A)
    await end(q)
    await reach(Date.parse(q.bubble.at) + 3 * 24 * HOUR)
    expect(f.store.question(q.questionId)).toMatchObject({ status, nextAt: null })
    expect(nudgesOf(q.questionId)).toEqual([])
    expect(f.store.dispatches(q.workId).some((dispatch) => dispatch.prompt.text.includes('so go with'))).toBe(false)
  })
})

describe('restarts', () => {
  it('a default that fell due while Mousse was off is applied once, and says when it was due', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    const due = new Date(Date.parse(bubble.at) + 30 * MIN).toISOString()
    await restart(3 * HOUR)
    expect(f.store.question(questionId)).toMatchObject({ status: 'defaulted', answer: { dueAt: due } })
    expect(mainDispatches(workId)).toHaveLength(2)
    expect(mainDispatches(workId)[1]!.prompt.text).toContain(`This was due at ${clockTime(due)}; Mousse was off then. Check "Flat A" still makes sense.`)
    await restart(HOUR)
    expect(mainDispatches(workId)).toHaveLength(2)
  })

  it('nudges that fell due while Mousse was off are posted once, never as a backlog; the next counts from then', async () => {
    const { questionId } = await chatAsks(FLATS)
    await restart(3 * 24 * HOUR)
    expect(nudgesOf(questionId)).toHaveLength(1)
    expect(f.store.question(questionId)).toMatchObject({ nudges: 1, nextAt: new Date(f.clock.now + 24 * HOUR).toISOString() })
    await restart(HOUR)
    expect(nudgesOf(questionId)).toHaveLength(1)
  })
})

describe('a late answer, after the bot went with its default', () => {
  it('reaches work that still runs as a note, and the bubble shows both; a second is refused', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    await start(f, workId, mainDispatches(workId).at(-1)!.n)
    const { message } = await tap(questionId, 'Flat B')
    expect(message).toMatchObject({ author: 'owner', activationId: workId, answers: { questionId, tapped: true } })
    expect(f.store.pendingWorkNotes(workId).map((note) => note.text)).toEqual([lateWorkNote('Flat B')])
    expect(bubbleNow(bubble.id).question).toMatchObject({ status: 'defaulted', answer: 'Flat A', late: 'Flat B' })
    await expect(tap(questionId, 'Flat A')).rejects.toMatchObject({ code: 'question_answered' })
  })

  it('becomes the answer while the work has not gone on with its default yet', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    // Nothing starts while the bot's journal cannot be written, so the work does not go on with its default yet.
    f.store.setError(botId, { code: 'bot_journal_failed', error: BOT_JOURNAL_ERROR })
    await reach(Date.parse(bubble.at) + 30 * MIN)
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question_answered' })
    await tap(questionId, 'Flat B')
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { choice: 'Flat B', by: 'owner' } })
    f.store.setError(botId, null)
    await f.bots.maintain()
    expect(mainDispatches(workId).at(-1)!.prompt.text).toContain(`"${FLATS.question}": Flat B.`)
  })

  it('after the work ended, is a reply to the chat, which hears that it had gone ahead', async () => {
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    const resumed = await start(f, workId, mainDispatches(workId).at(-1)!.n)
    await finish(f, resumed.payload, 'completed', { text: 'I booked Flat A.' })
    expect(f.store.activation(workId)?.status).toBe('done')
    const { message } = await tap(questionId, 'Flat B')
    const turn = f.store.laneActivations(botId, 'chat', ['running', 'queued']).at(-1)!
    expect(turn.idempotencyKey.startsWith('answer:')).toBe(true)
    expect(turn.trigger).toMatchObject({ input: `${lateAnsweringLine(FLATS.question, 'Flat A')}\n\nFlat B` })
    expect(f.store.question(questionId)).toMatchObject({ status: 'defaulted', answer: { late: { choice: 'Flat B', tapped: true } }, answerMessage: message.id })
    // A tap is still the bot's label, never the owner's words.
    expect(f.bots.ownerWords(botId, turn.id)).toBe('')
  })
})

describe('Forget', () => {
  const memoryStore = () => new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  function journaled(memory: BotMemoryStore, message: BotChatMessage, lane: 'chat' | 'run'): string {
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'notice', lane, sourceKey: `bm:${message.id}`, who: 'bot', text: message.text, ...(message.activationId ? { activationId: message.activationId } : {}) }))
    return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
  }

  it('of the bubble takes the default’s line from the work’s prompt, and the default’s label from the question', async () => {
    const memory = memoryStore()
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    const resumed = mainDispatches(workId).at(-1)!
    expect(resumed.prompt.text).toContain(FLATS.question)
    memory.forget(botId, { refs: [journaled(memory, bubble, 'run')], by: 'owner_ui' })
    expect(f.store.dispatch(workId, resumed.n)!.prompt.text).not.toMatch(/flat/i)
    expect(JSON.stringify(f.store.question(questionId))).not.toMatch(/flat a/i)
  })

  it('of a chat question’s bubble takes the default’s line from the chat turn it queued', async () => {
    const memory = memoryStore()
    const { bubble, questionId } = await chatAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    const turn = f.store.activationByKey(`question:${questionId}:default`)!
    memory.forget(botId, { refs: [journaled(memory, bubble, 'chat')], by: 'owner_ui' })
    expect(JSON.stringify(f.store.activation(turn.id)!.trigger)).not.toMatch(/flat/i)
    expect(JSON.stringify(f.store.dispatches(turn.id).map((dispatch) => dispatch.prompt))).not.toMatch(/flat/i)
  })

  /** A thread message copied into the journal as capture copies it: its journal row's seq. */
  function captured(memory: BotMemoryStore, ref: { threadId: string; lane: 'chat' | 'run'; activationId: string }, id: string, role: 'user' | 'assistant', content: string): number {
    const rows = capturedRows({ id, role, content, timestamp: f.store.now() } as ChatMessage, { botId, ...ref })
    f.store.db.transaction(() => { for (const { at, ...row } of rows) memory.appendInTx(f.store.db, row, at) })
    return f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', rows[0]!.sourceKey)!.seq as number
  }
  const journalText = (seq: number) => (f.store.get('SELECT text FROM bot_journal WHERE seq = ?', seq) as { text: string }).text

  it('of the bubble takes the question and the default from the chat turn an owner’s late answer started', async () => {
    const memory = memoryStore()
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    const resumed = await start(f, workId, mainDispatches(workId).at(-1)!.n)
    await finish(f, resumed.payload, 'completed', { text: 'I booked a viewing of the first one.' })
    await tap(questionId, 'Flat B')
    const late = f.store.laneActivations(botId, 'chat', ['running', 'queued']).at(-1)!
    expect(late.trigger).toMatchObject({ input: `${lateAnsweringLine(FLATS.question, 'Flat A')}\n\nFlat B` })
    const asked = f.store.dispatches(late.id)[0]!
    const copy = captured(memory, { threadId: asked.threadId, lane: 'chat', activationId: late.id }, 'late-in', 'user', asked.prompt.text)
    memory.forget(botId, { refs: [journaled(memory, bubble, 'run')], by: 'owner_ui' })
    // The owner's own tap stays; the question's words and the bot's default go, from the request, its prompt and its copy.
    const request = (f.store.activation(late.id)!.trigger as { input: string }).input
    expect(request).toContain('Flat B')
    for (const kept of [request, f.store.dispatch(late.id, asked.n)!.prompt.text, journalText(copy)]) {
      expect(kept).not.toMatch(/which flat/i)
      expect(kept).not.toContain('Flat A')
    }
  })

  it('of an owner’s late answer takes the note it passed to running work from the rows captured from that work', async () => {
    const memory = memoryStore()
    const { workId, bubble, questionId } = await workAsks(DEFAULT_A)
    await reach(Date.parse(bubble.at) + 30 * MIN)
    const resumed = await start(f, workId, mainDispatches(workId).at(-1)!.n)
    const { message } = await tap(questionId, 'Flat B')
    // The note reaches the running work as a steer, and capture copies it from the work's thread.
    const note = f.store.pendingWorkNotes(workId)[0]!.text
    const steer = captured(memory, { threadId: resumed.payload.threadId, lane: 'run', activationId: workId }, 'steer', 'user', noteSteerText([note]))
    const report = captured(memory, { threadId: resumed.payload.threadId, lane: 'run', activationId: workId }, 'rep', 'assistant', 'I switched the viewing to Flat B.')
    expect(journalText(steer)).toContain('Flat B')
    memory.forget(botId, { refs: [journaledOwner(memory, message)], by: 'owner_ui' })
    // "Flat B" is shorter than any copy the journal looks for by its words: the note is found by the message and the work.
    expect(journalText(steer)).not.toContain('Flat B')
    expect(journalText(steer)).toContain('The owner added this to your job')
    // What the bot wrote itself stays.
    expect(journalText(report)).toBe('I switched the viewing to Flat B.')
  })

  function journaledOwner(memory: BotMemoryStore, message: BotChatMessage): string {
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'run', sourceKey: `bm:${message.id}`, who: 'owner', text: message.text, ...(message.activationId ? { activationId: message.activationId } : {}) }))
    return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
  }

  it('of the bubble leaves a nudge’s notification nothing of the question, and the nudge no longer notifies', async () => {
    const memory = memoryStore()
    const { bubble, questionId } = await workAsks(FLATS)
    await reach(Date.parse(bubble.at) + HOUR)
    const [nudge] = nudgesOf(questionId)
    // On its own, as a phone shows it: the question it reminds of, and its answers.
    expect(botNotificationContent('Pip', nudge!).body).toBe(`Still need your answer: ${FLATS.question} — Flat A / Flat B`)
    // Nothing of the question is kept with the nudge: its words come from the bubble each time.
    expect(f.store.message(nudge!.id)!.text).toBe(NUDGE_TEXT)
    expect(f.journal.find((row) => row.sourceKey === `bm:${nudge!.id}`)?.text).toBe(NUDGE_TEXT)
    memory.forget(botId, { refs: [journaled(memory, bubble, 'run')], by: 'owner_ui' })
    const after = chatOf(f, botId).find((message) => message.id === nudge!.id)!
    expect(botNotificationKind(after, Date.parse(after.at))).toBeNull()
    expect(botNotificationContent('Pip', after).body).not.toMatch(/which flat|flat a/i)
  })
})


describe('owner attention in the shared summary', () => {
  const summary = () => f.bots.service.get(botId).summary

  it('counts a posted chat question, then clears on an answer', async () => {
    const { questionId } = await chatAsks(FLATS)
    expect(summary()).toMatchObject({ state: 'needs_you', stateText: `Asked: ${FLATS.question}`, needsOwner: true })
    await tap(questionId, 'Flat A')
    expect(summary().needsOwner).toBeUndefined()
    expect(summary().state).not.toBe('needs_you')
  })

  it.each(['running', 'queued'] as const)('keeps %s work visible while a chat question still counts for the badge', async (status) => {
    await chatAsks(DEFAULT_A)
    const activation = await f.bots.activate({ botId, input: 'Check flights', clientRequestId: 'flights' })
    if (status === 'queued') f.store.moveActivation(activation.id, ['running'], 'queued')
    expect(summary()).toMatchObject({ state: 'working', needsOwner: true })
    expect(summary().stateText).not.toContain('Asked:')
    f.store.moveActivation(activation.id, [status], 'done')
    expect(summary()).toMatchObject({ state: 'needs_you', stateText: `Asked: ${FLATS.question}`, needsOwner: true })
  })

  it('keeps a managed thread visible while a chat question still counts for the badge', async () => {
    await chatAsks(FLATS)
    f.launched = () => [{ threadId: 'flights', title: 'Check flights', status: 'running', startedAt: new Date(f.clock.now).toISOString(), updatedAt: new Date(f.clock.now).toISOString() }]
    expect(summary()).toMatchObject({ state: 'working', needsOwner: true })
    expect(summary().stateText).not.toContain('Asked:')
    f.launched = () => []
    expect(summary()).toMatchObject({ state: 'needs_you', stateText: `Asked: ${FLATS.question}`, needsOwner: true })
  })

  it('clears when the owner answers the only question from work', async () => {
    const { questionId } = await workAsks(FLATS)
    expect(summary().needsOwner).toBe(true)
    await tap(questionId, 'Flat A')
    expect(summary().needsOwner).toBeUndefined()
    expect(summary().state).not.toBe('needs_you')
  })

  it('counts work waiting on its question, once even with three questions', async () => {
    const one = await workAsks(FLATS)
    await workAsks({ question: 'Which movers?', choices: ['A', 'B'] }, 'Movers', 'w2')
    await chatAsks({ question: 'Which day?', choices: ['Monday', 'Tuesday'] })
    expect(summary()).toMatchObject({ state: 'needs_you', needsOwner: true })
    await tap(one.questionId, 'Flat A')
    expect(summary().needsOwner).toBe(true)
  })

  it.each(['moved_on', 'defaulted', 'withdrawn'] as const)('does not count a %s chat question', async (status) => {
    const { questionId } = await chatAsks(DEFAULT_A)
    expect(summary().needsOwner).toBe(true)
    if (status === 'moved_on') await chat('Something else now.', 'move-on')
    else if (status === 'defaulted') await reach(Date.parse(f.store.question(questionId)!.nextAt!))
    else f.store.withdrawQuestions(botId)
    expect(f.store.question(questionId)?.status).toBe(status)
    expect(summary().needsOwner).toBeUndefined()
    expect(summary().state).not.toBe('needs_you')
  })

  it('counts an open question even when an error takes priority in the state', async () => {
    f.store.setError(botId, { code: 'test', error: { text: 'Sign in', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'test' } } })
    expect(summary().needsOwner).toBeUndefined()
    await chatAsks(FLATS)
    f.store.setError(botId, { code: 'test', error: { text: 'Sign in', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'test' } } })
    expect(summary()).toMatchObject({ state: 'stuck', needsOwner: true })
  })

  it('does not count a paused bot with an open question', async () => {
    await chatAsks(FLATS)
    await f.bots.service.pause(botId)
    expect(summary()).toMatchObject({ state: 'paused' })
    expect(summary().needsOwner).toBeUndefined()
  })
})
