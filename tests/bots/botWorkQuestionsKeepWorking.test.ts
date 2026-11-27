/**
 * Work that asks its owner a question without waiting (`question_ask` with `wait: false`, issue #1372), over a real engine
 * and a real `bots.db`: the bubble is posted at once, the turn goes on (nothing is refused), and the answer reaches the
 * work wherever it is when it comes.
 *
 * Where the answer can land, by what the work is doing then:
 * - its turn still runs, on a runtime that takes notes as it works: a note naming the question, read once; the work
 *   does not stop on the question at its turn's end
 * - its turn still runs, on a runtime that takes no notes while it runs: the note goes with the continuation, once
 * - its turn ends without reading the note and with too little time left to go on with notes: the answer still carries
 *   the work on, once (it becomes the work's unread answer again)
 * - its turn already ended with the question open: it waits, and the answer carries it on (as a question that waits)
 * - passed on from the chat in the owner's words (`question_answer`) while the work runs
 * - a restart while the work runs: it restarts as cut-off work does, and the question stays answerable
 * - a chat turn's `wait: false` changes nothing (a chat question never waits)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import { QUESTION_ASKED_TEXT, questionWorkKeepsWorkingText } from '../../src/shared/bots/personal/questions'
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
    caller: { threadId, runId: 'r', provider: 'pi', accessLevel: 'lineage' },
    turn: { threadId, bot: prepared.authority },
    toolCallId: `call-${Math.random()}`,
    signal: new AbortController().signal,
    transport: 'mcp'
  } as unknown as ToolCallContext
  return (tools.get(name) as MousseTool).handler(args, ctx)
}

const FLATS = { question: 'Which flat should I book a viewing for?', choices: ['Flat A', 'Flat B'], wait: false }
const web: NormalisedCall = { kind: 'app', tool: 'web_fetch', args: {} }

async function chat(text: string, id: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

async function handOff(title: string, key: string) {
  const turn = await chat(`Please do: ${title}`, `m-${key}`)
  const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title, brief: `${title}: find two and book a viewing.`, key })
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  return { workId, asked: turn.message }
}

/** Work that runs and asks without waiting; `steers`: its runtime takes notes while it runs. */
async function workThatAsks(steers: boolean) {
  const { workId, asked } = await handOff('Flat hunt', 'w1')
  const work = await start(f, workId)
  if (steers) work.prepared.steer!.attached()
  const answer = await tool('question_ask', work.prepared, work.payload.threadId, FLATS)
  const bubble = chatOf(f, botId).find((message) => message.question && message.activationId === workId)!
  const questionId = bubble.question!.questionId
  expect(JSON.parse(answer.text)).toEqual({ asked: true, questionId, note: questionWorkKeepsWorkingText(questionId) })
  return { workId, work, asked, bubble, questionId }
}

const tap = (questionId: string, choice: string) =>
  call<{ message: BotChatMessage; question?: BotChatMessage }>('bots.questions.answer', { botId, questionId, choice, clientRequestId: `tap-${Math.random().toString(16).slice(2)}` })

const mainDispatches = (workId: string) => f.store.dispatches(workId).filter((dispatch) => dispatch.kind === 'start' || dispatch.kind === 'continue')
const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!
const answerLine = (questionId: string, answer: string, how = '') => `[${questionId}] Your owner answered your question "${FLATS.question}"${how}: ${answer}`

describe('work that asks without waiting', () => {
  it('keeps working; a tap while it runs goes in as a note naming the question, once, and the work ends without stopping on it', async () => {
    const { workId, work, asked, bubble, questionId } = await workThatAsks(true)
    // Its turn is not refused, and the owner is needed: the chat knows the question, with its id to pass an answer on.
    expect(work.prepared.authority.check(web)).toEqual({ ok: true })
    expect(summary().state).toBe('needs_you')
    expect(f.bots.questionLines(botId).join('\n')).toContain(`[${questionId}]`)
    expect(f.store.activation(workId)!.status).toBe('running')

    const { question } = await tap(questionId, 'Flat B')
    expect(question?.question).toMatchObject({ status: 'answered', answer: 'Flat B' })
    const steer = work.prepared.steer!
    expect(steer.peek()).toContain(answerLine(questionId, 'Flat B'))
    const taken = steer.take()!
    steer.accepted(taken.token)
    expect(f.store.pendingWorkNotes(workId)).toEqual([])
    // Counted as read: it no longer holds the work up, and the owner is not needed any more.
    expect(f.store.question(questionId)?.readAt).not.toBeNull()
    expect(summary().state).not.toBe('needs_you')

    await finish(f, work.payload, 'completed', { text: 'I booked a viewing of Flat B.' })
    expect(mainDispatches(workId)).toHaveLength(1)
    expect(f.store.activation(workId)!.status).toBe('done')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'I booked a viewing of Flat B.', replyTo: { id: asked.id } })
    expect(chatOf(f, botId).find((message) => message.id === bubble.id)?.question).toMatchObject({ status: 'answered', answer: 'Flat B' })
  })

  it('on a runtime that takes no notes while it runs, the answer goes with the continuation once, not twice', async () => {
    const { workId, work, questionId } = await workThatAsks(false)
    await tap(questionId, 'Flat A')
    await finish(f, work.payload, 'completed', { text: 'Two flats found.' })
    const next = mainDispatches(workId)[1]!
    expect(next.prompt.text.split(`Your owner answered your question "${FLATS.question}"`)).toHaveLength(2)
    expect(next.prompt.text).toContain(answerLine(questionId, 'Flat A'))
    const resumed = await start(f, workId, next.n)
    await finish(f, resumed.payload, 'completed', { text: 'Booked Flat A.' })
    expect(f.store.activation(workId)!.status).toBe('done')
    expect(mainDispatches(workId)).toHaveLength(2)
  })

  it('a turn that ends with the question still open waits for it, and the answer carries it on', async () => {
    const { workId, work, questionId } = await workThatAsks(true)
    await finish(f, work.payload, 'completed', { text: 'Everything else is done.' })
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
    await tap(questionId, 'Flat B')
    await flush()
    const next = mainDispatches(workId)[1]!
    expect(next.prompt.text).toBe(`[Mousse] Your owner answered your question "${FLATS.question}": Flat B. Carry on where you left off.`)
  })

  it('the chat passes on the owner’s words while the work runs: they reach the running work as its note', async () => {
    const { workId, work, questionId } = await workThatAsks(true)
    const own = await chat('Go with the second one', 'c2')
    expect(JSON.parse((await tool('question_answer', own.prepared, own.payload.threadId, { questionId, answer: 'The second one' })).text)).toMatchObject({ ok: true })
    expect(work.prepared.steer!.peek()).toContain(answerLine(questionId, 'The second one', ' in the chat'))
    expect(f.store.activation(workId)!.status).toBe('running')
  })

  it('a restart while it works restarts it as cut-off work, and the question stays open for the answer', async () => {
    const { workId, work, questionId } = await workThatAsks(true)
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(mainDispatches(workId).at(-1)!.prompt.text).toContain('Mousse restarted while you were working.')
    expect(f.store.question(questionId)?.status).toBe('open')
    const resumed = await start(f, workId, mainDispatches(workId).at(-1)!.n)
    resumed.prepared.steer!.attached()
    await tap(questionId, 'Flat A')
    expect(resumed.prepared.steer!.peek()).toContain(answerLine(questionId, 'Flat A'))
  })

  it('in a chat turn, wait false changes nothing: the question is shown under the reply and the turn ends', async () => {
    const turn = await chat('Find me a flat', 'c1')
    expect(JSON.parse((await tool('question_ask', turn.prepared, turn.payload.threadId, FLATS)).text)).toEqual({ asked: true, questionId: expect.stringMatching(/^q_/), note: QUESTION_ASKED_TEXT })
    const asked = f.store.activationQuestions(turn.activation.id)[0]!
    expect(asked.spec.wait).toBeUndefined()
  })
})
