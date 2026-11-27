/**
 * A bot takes back a question it no longer needs (`question_withdraw`, issue #1446), asks several at once, and is
 * refused a repeat (issue #1363), over a real engine and a real `bots.db`, through the bot's own tools.
 *
 * Inputs:
 * - who withdraws: the work that asked; another piece of the same bot's work; another bot; the chat turn that asked
 * - races: the owner's tap lands first (the answer is kept and returned)
 * - where the bubble shows it: every window (`bots.message` events)
 * - repeats: the same question again after it was shown, before and after the owner writes
 * - batches in work: it waits until every question it waits on is answered, then hears every answer once
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import { QUESTION_DUPLICATE_TEXT } from '../../src/shared/bots/personal/questions'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

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
const result = (outcome: { text: string; isError?: boolean }) => (outcome.isError ? { error: outcome.text } : JSON.parse(outcome.text))

const FLATS = { question: 'Which flat should I book a viewing for?', choices: ['Flat A', 'Flat B'], wait: false }

async function chat(text: string, id: string, bot = botId) {
  await f.bots.service.chatSend({ botId: bot, text, clientRequestId: id })
  const activation = f.store.laneActivations(bot, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

/** Work of `bot` that runs: handed off from a chat turn the owner's message started. */
async function work(key: string, bot = botId) {
  const turn = await chat(`Please do ${key}`, `m-${key}`, bot)
  const { workId } = await f.bots.tools.work.start(bot, turn.activation.id, { title: key, brief: `${key}: find two.`, key })
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  return { workId, ...(await start(f, workId)) }
}

const tap = (questionId: string, choice: string, bot = botId) =>
  call<{ message: BotChatMessage; question?: BotChatMessage }>('bots.questions.answer', { botId: bot, questionId, choice, clientRequestId: `tap-${Math.random().toString(16).slice(2)}` })

/** What open windows were last sent of a message (`bots.message`), from now on. */
function published(): (id: string) => BotChatMessage | undefined {
  const sent: BotChatMessage[] = []
  f.bots.events.on('message', (payload: unknown) => sent.push((payload as { message: BotChatMessage }).message))
  return (id) => sent.filter((message) => message.id === id).at(-1)
}

const mainDispatches = (workId: string) => f.store.dispatches(workId).filter((dispatch) => dispatch.kind === 'start' || dispatch.kind === 'continue')

describe('question_withdraw', () => {
  it('takes back the work\'s own open question: its bubble says so in every window, and the work goes on without it', async () => {
    const running = await work('flats')
    const { questionId } = result(await tool('question_ask', running.prepared, running.payload.threadId, FLATS))
    const bubble = chatOf(f, botId).find((message) => message.question?.questionId === questionId)!
    const sent = published()
    expect(result(await tool('question_withdraw', running.prepared, running.payload.threadId, { questionId }))).toMatchObject({ withdrawn: true })
    expect(f.store.question(questionId)?.status).toBe('withdrawn')
    expect(sent(bubble.id)?.question).toMatchObject({ questionId, status: 'withdrawn' })
    // The work does not wait on it, and does not end as if the owner had forgotten it.
    await finish(f, running.payload, 'completed', { text: 'Found it myself.' })
    expect(f.store.activation(running.workId)).toMatchObject({ status: 'done' })
    expect(mainDispatches(running.workId)).toHaveLength(1)
    // A tap on the withdrawn bubble is refused.
    await expect(tap(questionId, 'Flat A')).rejects.toMatchObject({ code: 'question_closed' })
  })

  it('refuses another piece of the bot\'s work, and another bot, without touching the question', async () => {
    const asking = await work('flats')
    const { questionId } = result(await tool('question_ask', asking.prepared, asking.payload.threadId, FLATS))
    const other = await work('movers')
    expect(result(await tool('question_withdraw', other.prepared, other.payload.threadId, { questionId }))).toEqual({ error: expect.stringContaining('no question with that id') })
    const otherBot = (await createBot(f, { name: 'Quill', reply: 'Hi.' })).botId
    const stranger = await work('notes', otherBot)
    expect(result(await tool('question_withdraw', stranger.prepared, stranger.payload.threadId, { questionId }))).toEqual({ error: expect.stringContaining('no question with that id') })
    expect(f.store.question(questionId)?.status).toBe('open')
  })

  it('when the owner\'s tap landed first, nothing is withdrawn and the bot gets the answer', async () => {
    const running = await work('flats')
    const { questionId } = result(await tool('question_ask', running.prepared, running.payload.threadId, FLATS))
    await tap(questionId, 'Flat B')
    expect(result(await tool('question_withdraw', running.prepared, running.payload.threadId, { questionId }))).toMatchObject({ withdrawn: false, status: 'answered', answer: 'Flat B' })
    expect(f.store.question(questionId)).toMatchObject({ status: 'answered', answer: { choice: 'Flat B' } })
  })

  it('a chat turn takes back a question it asked before its reply: it is never shown', async () => {
    const turn = await chat('Find me a flat', 'c1')
    const { questionId } = result(await tool('question_ask', turn.prepared, turn.payload.threadId, FLATS))
    expect(result(await tool('question_withdraw', turn.prepared, turn.payload.threadId, { questionId }))).toMatchObject({ withdrawn: true })
    await finish(f, turn.payload, 'completed', { text: 'Never mind, I found one.' })
    expect(chatOf(f, botId).some((message) => message.question)).toBe(false)
  })
})

describe('repeats and batches in work (issue #1363)', () => {
  it('a question shown and taken back is not asked again until the owner writes', async () => {
    const running = await work('flats')
    const { questionId } = result(await tool('question_ask', running.prepared, running.payload.threadId, FLATS))
    await tool('question_withdraw', running.prepared, running.payload.threadId, { questionId })
    // Reworded, with its answers the other way round: the same question.
    const again = { question: 'which flat should I book a viewing for', choices: ['Flat B', 'Flat A'], wait: false }
    expect(result(await tool('question_ask', running.prepared, running.payload.threadId, again))).toEqual({ error: QUESTION_DUPLICATE_TEXT })
    // Another question is not a repeat.
    expect(result(await tool('question_ask', running.prepared, running.payload.threadId, { question: 'Which day?', yesNo: true, wait: false })).asked).toBe(true)
    await f.bots.service.chatSend({ botId, text: 'How is the flat hunt going?', clientRequestId: 'm-how' })
    expect(result(await tool('question_ask', running.prepared, running.payload.threadId, again)).asked).toBe(true)
  })

  it('work that asks several and waits goes on once every one is answered, with every answer once', async () => {
    const running = await work('move')
    const asked = result(await tool('question_ask', running.prepared, running.payload.threadId, { questions: [{ question: 'Which flat?', choices: ['Flat A', 'Flat B'] }, { question: 'Book the movers?', yesNo: true }] }))
    expect(asked.questionIds).toHaveLength(2)
    await finish(f, running.payload, 'completed', { text: 'I asked.' })
    expect(f.store.activation(running.workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    await tap(asked.questionIds[0], 'Flat B')
    await flush()
    expect(f.store.activation(running.workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    expect(mainDispatches(running.workId)).toHaveLength(1)
    await tap(asked.questionIds[1], 'Yes')
    await flush()
    const next = mainDispatches(running.workId)[1]!
    expect(next.prompt.text.split('Your owner answered your question "Which flat?": Flat B')).toHaveLength(2)
    expect(next.prompt.text.split('Your owner answered your question "Book the movers?": Yes')).toHaveLength(2)
  })
})
