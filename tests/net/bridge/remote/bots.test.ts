/**
 * The owner's personal bots from a phone: the `bots.*` remote methods (exact params, no attachments, plain refusals,
 * no paths or instance ids in what they return) and the bots in the lists stream.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NetError } from '../../../../src/shared/net'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import {
  REMOTE_BOT_METHODS,
  remoteBotMessage,
  remoteBotMethods,
  remoteBotSummary,
  validateRemoteBotParams,
  type RemoteBotMethod,
  type RemoteBotsPort
} from '../../../../src/mms/bridge/remote/RemoteBots'
import { MmsListsSource, type ListsServices } from '../../../../src/mms/bridge/remote/MmsListsSource'
import type { BotChatMessage, BotSummary } from '../../../../src/shared/bots/personal/chat'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from '../../../bots/botFixture'

const at = '2026-11-07T09:00:00.000Z'
const BOT = 'bot-0123456789ab'
const ASK = 'esc_00000000-0000-0000-0000-000000000000'
const context = { caller: { node: 'n', user: 'u' } } as unknown as RpcContext

/** Calls a method the way the dispatcher does for a new execution: validate, authorize, authorizeNew, handle. */
async function call(methods: RpcMethod[], name: RemoteBotMethod, params: unknown): Promise<unknown> {
  const method = methods.find((entry) => entry.method === name)!
  const valid = method.validate ? method.validate(params) : params
  method.authorize?.(valid, context)
  method.authorizeNew?.(valid, context)
  return method.handle(valid, context)
}

async function refused(work: () => Promise<unknown>): Promise<NetError> {
  try {
    await work()
  } catch (error) {
    expect(error).toBeInstanceOf(NetError)
    return error as NetError
  }
  throw new Error('expected a refusal')
}

describe('bot method params', () => {
  const bad = (method: RemoteBotMethod, params: unknown) =>
    expect(() => validateRemoteBotParams(method, params)).toThrow(NetError)

  it('takes exactly the documented keys', () => {
    expect(validateRemoteBotParams('bots.chat.list', { botId: BOT, beforeSeq: 4, limit: 100 })).toBeTruthy()
    expect(validateRemoteBotParams('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r-1', replyTo: 'm1' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.asks.answer', { botId: BOT, askId: ASK, answer: 'not_now' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.work.stop', { botId: BOT, workId: 'act_00000000-0000-0000-0000-000000000000' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy notes', clientRequestId: 'c1' })).toBeTruthy()
    bad('bots.get', { botId: BOT, profileId: 'p' })
    bad('bots.get', { botId: '../etc' })
    bad('bots.chat.stop', {})
    bad('bots.chat.list', { botId: BOT, limit: 101 })
    bad('bots.chat.list', { botId: BOT, beforeSeq: 0 })
    bad('bots.chat.markRead', { botId: BOT, seq: -1 })
    bad('bots.asks.answer', { botId: BOT, askId: ASK, answer: 'allow_bot' })
    bad('bots.work.stop', { botId: BOT, workId: 'w1' })
    bad('bots.create', { look: { colour: 'teal', accessory: 'cap', model: 'x' }, description: 'Tidy', clientRequestId: 'c1' })
    bad('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'x'.repeat(501), clientRequestId: 'c1' })
    bad('bots.personal.pause', { botId: BOT, extra: true })
  })

  it('refuses attachments, an empty or oversized message and a bad request id', () => {
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r1', attachments: [{ name: 'a.txt', path: '/a.txt' }] })
    bad('bots.chat.send', { botId: BOT, text: '  ', clientRequestId: 'r1' })
    bad('bots.chat.send', { botId: BOT, text: 'é'.repeat(20_000), clientRequestId: 'r1' })
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'has space' })
    bad('bots.chat.send', { botId: BOT, text: 'Hi' })
  })

  it('lists every method with its capability', () => {
    expect(REMOTE_BOT_METHODS).toMatchObject({
      'bots.chat.list': { capability: 'read', mutating: false },
      'bots.get': { capability: 'read', mutating: false },
      'bots.chat.send': { capability: 'chat', mutating: true },
      'bots.asks.answer': { capability: 'chat', mutating: true },
      'bots.personal.pause': { capability: 'write', mutating: true },
      'bots.create': { capability: 'write', mutating: true }
    })
    const methods = remoteBotMethods({ bots: () => undefined })
    expect(methods.map((entry) => entry.method).sort()).toEqual(Object.keys(REMOTE_BOT_METHODS).sort())
    // A read's result (the chat) is never kept in the request ledger.
    expect(methods.filter((entry) => entry.ephemeral).map((entry) => entry.method).sort()).toEqual(['bots.chat.list', 'bots.get'])
  })
})

describe('what a phone sees of a bot', () => {
  it('drops attachment paths and instance ids', () => {
    const message: BotChatMessage = {
      seq: 1, id: 'm1', at, author: 'owner', kind: 'error', text: 'x', chips: [],
      attachments: [{ name: 'list.txt', path: '/home/me/bots/files/list.txt' }],
      error: { text: 'Sign in again', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } }
    }
    const seen = remoteBotMessage(message)
    expect(seen.attachments).toEqual([{ name: 'list.txt' }])
    expect(seen.error).toEqual({ text: 'Sign in again', action: { kind: 'sign_in', label: 'Sign in' } })
    expect(JSON.stringify(seen)).not.toMatch(/home\/me|claude:bots/)
    const summary = { id: BOT, name: 'Penny', error: { text: 'e', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } } } as BotSummary
    expect(remoteBotSummary(summary).error).toEqual({ text: 'e', action: { kind: 'sign_in', label: 'Sign in' } })
  })

  it('a page fits one reply: the newest messages, the older ones on the next page', async () => {
    const messages = Array.from({ length: 10 }, (_, n): BotChatMessage => ({ seq: n + 1, id: `m${n + 1}`, at, author: 'bot', kind: 'text', text: 'x'.repeat(10_000), chips: [] }))
    const port = { get: () => ({}), chatList: () => ({ messages }) } as unknown as RemoteBotsPort
    const page = (await call(remoteBotMethods({ bots: () => port }), 'bots.chat.list', { botId: BOT })) as { messages: BotChatMessage[] }
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(10)
    expect(page.messages.at(-1)!.seq).toBe(10)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(63 * 1024)
    // One message larger than a reply is cut.
    const huge = { get: () => ({}), chatList: () => ({ messages: [{ ...messages[0]!, text: 'y'.repeat(100_000) }] }) } as unknown as RemoteBotsPort
    const one = (await call(remoteBotMethods({ bots: () => huge }), 'bots.chat.list', { botId: BOT })) as { messages: BotChatMessage[] }
    expect(one.messages).toHaveLength(1)
    expect(one.messages[0]!.text).toMatch(/the rest is on the computer\)$/)
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThan(63 * 1024)
  })

  it('without bots on the computer, every method refuses plainly', async () => {
    const methods = remoteBotMethods({ bots: () => undefined })
    const error = await refused(() => call(methods, 'bots.get', { botId: BOT }))
    expect(error.code).toBe('conflict')
  })
})

describe('bot methods on a real bot', () => {
  let f: BotFixture
  let botId: string
  let methods: RpcMethod[]
  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    methods = remoteBotMethods({ bots: () => f.bots.service })
  })
  afterEach(() => f.close())

  it('chats: list, send (once per request id), mark read, and the bot detail', async () => {
    const sent = (await call(methods, 'bots.chat.send', { botId, text: 'Sort my notes', clientRequestId: 'phone-1' })) as { message: BotChatMessage }
    expect(sent.message).toMatchObject({ author: 'owner', text: 'Sort my notes' })
    await call(methods, 'bots.chat.send', { botId, text: 'Sort my notes', clientRequestId: 'phone-1' })
    const page = (await call(methods, 'bots.chat.list', { botId })) as { messages: BotChatMessage[] }
    expect(page.messages.filter((message) => message.text === 'Sort my notes')).toHaveLength(1)
    expect(page.messages).toEqual(chatOf(f, botId).map(remoteBotMessage))
    expect(await call(methods, 'bots.chat.markRead', { botId, seq: page.messages.at(-1)!.seq })).toEqual({})
    const detail = (await call(methods, 'bots.get', { botId })) as { summary: BotSummary }
    expect(detail.summary).toMatchObject({ id: botId, name: 'Penny', unread: 0 })
    expect(JSON.stringify(detail)).not.toMatch(/instanceId|some\/model/)
  })

  it('pauses, resumes and creates a bot', async () => {
    expect(await call(methods, 'bots.personal.pause', { botId })).toMatchObject({ bot: { id: botId, state: 'paused' } })
    expect(await call(methods, 'bots.personal.resume', { botId })).toMatchObject({ bot: { id: botId } })
    const made = (await call(methods, 'bots.create', { look: { colour: 'teal', accessory: 'cap' }, name: 'Notes', description: 'Tidy my notes', clientRequestId: 'phone-c1' })) as { bot: BotSummary }
    expect(made.bot).toMatchObject({ name: 'Notes', description: 'Tidy my notes' })
    const again = (await call(methods, 'bots.create', { look: { colour: 'teal', accessory: 'cap' }, name: 'Notes', description: 'Tidy my notes', clientRequestId: 'phone-c1' })) as { bot: BotSummary }
    expect(again.bot.id).toBe(made.bot.id)
  })

  it('refuses an unknown bot before the call is admitted', async () => {
    const error = await refused(() => call(methods, 'bots.chat.stop', { botId: 'bot-ffffffffffff' }))
    expect(error.code).toBe('stream_unknown')
  })

  it('stopping work the bot does not have stops nothing', async () => {
    expect(await call(methods, 'bots.work.stop', { botId, workId: 'act_00000000-0000-0000-0000-000000000000' })).toEqual({ stopped: false })
  })

  it('answers a permission ask, and leaves memory export to the computer', async () => {
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: 'm1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    await finish(f, payload, 'completed', { text: 'Pick a folder.' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect(card.kind).toBe('export_memory')
    const error = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Answer this on the computer.' })
    expect(chatOf(f, botId).at(-1)!.ask!.status).toBe('open')
    // An ask that is not there is a plain refusal too.
    const missing = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: ASK, answer: 'allow' }))
    expect(missing.code).toBe('conflict')
  })

  it('answers a permission ask', async () => {
    await f.bots.service.chatSend({ botId, text: 'Read my invoices', clientRequestId: 'm2' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { path: f.base, access: 'read' }, reason: 'To read them.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect(card.kind).toBe('permission')
    const answered = (await call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'not_now' })) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ askId: card.askId, status: 'not_now' })
  })

  it('the lists carry the bots, and push again when a bot changes', async () => {
    const services = {
      threads: Object.assign(new EventEmitter(), { listAllThreads: () => [] }),
      projects: { listProjects: () => [] },
      orchestrator: Object.assign(new EventEmitter(), { getTurnSnapshot: () => ({}) }),
      threadRuntimes: Object.assign(new EventEmitter(), { getActivitySnapshot: () => ({}) }),
      questions: new EventEmitter(),
      events: new EventEmitter(),
      platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } },
      personalBots: f.bots
    } as unknown as ListsServices
    const timeouts: Array<() => void> = []
    const timers = {
      setTimeout: (run: () => void) => timeouts.push(run),
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined
    }
    const lists = new MmsListsSource(services, timers)
    expect(lists.snapshot().bots).toMatchObject([{ id: botId, name: 'Penny', state: 'idle', last: { text: 'Hello.', author: 'bot' } }])
    expect(new MmsListsSource({ ...services, personalBots: null } as ListsServices).snapshot().bots).toEqual([])
    let pushes = 0
    const stop = lists.watch(() => pushes++)
    f.bots.service.pause(botId)
    timeouts.splice(0).forEach((run) => run())
    expect(pushes).toBe(1)
    expect(lists.snapshot().bots[0]).toMatchObject({ state: 'paused' })
    // A live chip of the bot's working activation, cleared with null.
    await f.bots.service.resume(botId)
    await f.bots.service.chatSend({ botId, text: 'Look it up', clientRequestId: 'm3' })
    const working = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    timeouts.splice(0).forEach((run) => run())
    f.bots.publishActivity({ botId, activationId: working.id, chip: { icon: 'web', text: 'Searching', live: true } })
    timeouts.splice(0).forEach((run) => run())
    expect(lists.snapshot().bots[0]!.activity).toEqual({ icon: 'web', text: 'Searching', live: true })
    f.bots.publishActivity({ botId, activationId: working.id, chip: null })
    timeouts.splice(0).forEach((run) => run())
    expect(lists.snapshot().bots[0]!.activity).toBeUndefined()
    expect(pushes).toBeGreaterThanOrEqual(4)
    stop()
    expect(f.bots.events.listenerCount('activity')).toBe(0)
  })
})
