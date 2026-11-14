/**
 * The owner's personal bots from a phone: the `bots.*` remote methods (exact params, no attachments, plain refusals,
 * no paths or instance ids in what they return) and the bots in the lists stream.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import { systemClock } from '../../../../src/mms/net/clock'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import {
  botDeviceLimitFrom,
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
import type { PermissionMode } from '../../../../src/shared/permissionMode'
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

  it('checks the About and image methods', () => {
    const REM = 'rem_00000000-0000-0000-0000-000000000000'
    expect(validateRemoteBotParams('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, offset: 40_960 })).toBeTruthy()
    expect(validateRemoteBotParams('bots.update', { botId: BOT, name: 'Pip' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.reminders.cancel', { botId: BOT, reminderId: REM })).toBeTruthy()
    expect(validateRemoteBotParams('bots.schedules.remove', { botId: BOT, scheduleId: 'daily-1' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.memory.forget', { botId: BOT, id: 'm12' })).toBeTruthy()
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 10 })
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, offset: -1 })
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, path: '/etc/passwd' })
    bad('bots.memory.list', { botId: BOT, history: true })
    bad('bots.update', { botId: BOT })
    bad('bots.update', { botId: BOT, name: ' ' })
    bad('bots.update', { botId: BOT, look: { colour: 'teal' } })
    bad('bots.reminders.cancel', { botId: BOT, reminderId: 'r1' })
    bad('bots.schedules.remove', { botId: BOT, scheduleId: '../x' })
    bad('bots.permissions.revoke', { botId: BOT, permissionId: '' })
    bad('bots.memory.forget', { botId: BOT, id: 'all' })
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
      'bots.questions.answer': { capability: 'chat', mutating: true },
      'bots.personal.pause': { capability: 'write', mutating: true },
      'bots.create': { capability: 'write', mutating: true }
    })
    const methods = remoteBotMethods({ bots: () => undefined })
    expect(methods.map((entry) => entry.method).sort()).toEqual(Object.keys(REMOTE_BOT_METHODS).sort())
    // A read's result (the chat) is never kept in the request ledger.
    expect(methods.filter((entry) => entry.ephemeral).map((entry) => entry.method).sort()).toEqual(['bots.chat.attachment', 'bots.chat.list', 'bots.get', 'bots.memory.list'])
    expect(REMOTE_BOT_METHODS).toMatchObject({
      'bots.chat.attachment': { capability: 'read', mutating: false },
      'bots.memory.list': { capability: 'read', mutating: false },
      'bots.update': { capability: 'write', mutating: true },
      'bots.reminders.cancel': { capability: 'write', mutating: true },
      'bots.schedules.remove': { capability: 'write', mutating: true },
      'bots.permissions.revoke': { capability: 'write', mutating: true },
      'bots.memory.forget': { capability: 'write', mutating: true }
    })
    // Nothing a remote device must not do: no delete, no model, no memory export, no new schedule.
    for (const name of ['bots.delete', 'bots.model.get', 'bots.model.set', 'bots.memory.export', 'bots.schedules.add', 'bots.personal.list'])
      expect(Object.keys(REMOTE_BOT_METHODS)).not.toContain(name)
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
    expect(seen.attachments).toEqual([{ name: 'list.txt', mime: 'text/plain' }])
    expect(remoteBotMessage({ ...message, attachments: [{ name: 'Shot.PNG', path: '/home/me/bots/files/Shot.PNG' }, { name: 'x.svg', path: '/x.svg' }] }).attachments)
      .toEqual([{ name: 'Shot.PNG', mime: 'image/png', image: true }, { name: 'x.svg', mime: 'image/svg+xml' }])
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
    expect(missing.code).toBe('stream_unknown')
  })

  it('"use your threads" from a device: its message holds the turn to its own limit, and only a Full access device may Allow the card', async () => {
    let limit: PermissionMode = 'ask'
    methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: (node) => (node === 'n' ? limit : 'full') })
    await call(methods, 'bots.chat.send', { botId, text: 'Start a thread to fix the login page', clientRequestId: 'phone-t1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'ask' })
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked me to start one.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    const error = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Allow this on the computer.' })
    expect(f.store.activeGrant(botId)!.manifest.appTools).not.toContain('threads')
    // A device whose own limit here is Full access may allow it.
    limit = 'full'
    const answered = (await call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' })) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ askId: card.askId, status: 'allowed' })
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('threads')
  })

  it('"use your threads": a device with no limit on record is held to Accept edits, the device settings\' default, as the service wires it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bots-device-limit-'))
    const db = new NetDatabase({ profileDir: dir })
    try {
      const policy = new SqliteNodePolicy(db, systemClock)
      methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: botDeviceLimitFrom(policy) })
      await call(methods, 'bots.chat.send', { botId, text: 'Start a thread', clientRequestId: 'phone-t3' })
      const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
      expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'accept_edits' })
      // A device whose limit is on record is held to it.
      const phone = newId('node')
      policy.set(phone, { maxPermissionMode: 'ask' })
      expect(botDeviceLimitFrom(policy)(phone)).toBe('ask')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('"use your threads": Not now works from any device, and with no device settings wired at all a device is held to Ask', async () => {
    methods = remoteBotMethods({ bots: () => f.bots.service })
    await call(methods, 'bots.chat.send', { botId, text: 'Start a thread', clientRequestId: 'phone-t2' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'ask' })
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect((await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))).code).toBe('forbidden')
    const answered = (await call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'not_now' })) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ status: 'not_now' })
  })

  it('answers a question with a tap, as a message from that device, and refuses one answered elsewhere before anything is written', async () => {
    methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: () => 'accept_edits' })
    await f.bots.service.chatSend({ botId, text: 'Find me a flat', clientRequestId: 'q-1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, activation.id)
    expect(f.bots.tools.questions!.ask(botId, activation.id, { question: 'Which flat?', choices: [{ label: 'Flat A' }, { label: 'Flat B' }], other: true }).asked).toBe(true)
    await finish(f, payload, 'completed', { text: 'Two to pick from.' })
    const bubble = chatOf(f, botId).find((message) => message.question)!
    const questionId = bubble.question!.questionId
    const tapped = (await call(methods, 'bots.questions.answer', { botId, questionId, choice: 'Flat B', clientRequestId: 'phone-q1' })) as { message: BotChatMessage; question: BotChatMessage }
    expect(tapped.message).toMatchObject({ author: 'owner', text: 'Flat B', answers: { questionId, tapped: true } })
    expect(tapped.question.question).toMatchObject({ status: 'answered', answer: 'Flat B' })
    // Its turn is the device's message: held to the device's limit, and dropped if the device loses the bot.
    const turn = f.store.activation(tapped.message.activationId!)!
    expect(turn.trigger).toMatchObject({ kind: 'manual', owner: { limit: 'accept_edits', node: 'n' } })
    // Answered: another device's tap is refused plainly, and nothing more is written.
    const rows = chatOf(f, botId).length
    const error = await refused(() => call(methods, 'bots.questions.answer', { botId, questionId, choice: 'Flat A', clientRequestId: 'phone-q2' }))
    expect(error).toMatchObject({ code: 'conflict', message: 'This was already answered.' })
    expect(chatOf(f, botId)).toHaveLength(rows)
    const missing = await refused(() => call(methods, 'bots.questions.answer', { botId, questionId: 'q_00000000-0000-0000-0000-000000000000', choice: 'Flat A', clientRequestId: 'phone-q3' }))
    expect(missing.code).toBe('stream_unknown')
    expect(() => validateRemoteBotParams('bots.questions.answer', { botId, questionId, choice: 'x'.repeat(41), clientRequestId: 'r' })).toThrow(NetError)
    expect(() => validateRemoteBotParams('bots.questions.answer', { botId, questionId: 'nope', choice: 'Flat A', clientRequestId: 'r' })).toThrow(NetError)
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

describe('"Share bots with other devices"', () => {
  it('while it is off, every method refuses before it reads anything', async () => {
    let reads = 0
    const port = new Proxy({}, { get: () => () => { reads++; return {} } }) as RemoteBotsPort
    const methods = remoteBotMethods({ bots: () => port, refusal: () => "Desk doesn't share its bots with other devices." })
    const params: Record<RemoteBotMethod, unknown> = {
      'bots.get': { botId: BOT },
      'bots.chat.list': { botId: BOT },
      'bots.chat.attachment': { botId: BOT, messageId: 'm1', index: 0 },
      'bots.memory.list': { botId: BOT },
      'bots.chat.send': { botId: BOT, text: 'Hi', clientRequestId: 'r1' },
      'bots.chat.stop': { botId: BOT },
      'bots.work.stop': { botId: BOT, workId: 'act_00000000-0000-0000-0000-000000000000' },
      'bots.chat.markRead': { botId: BOT, seq: 1 },
      'bots.asks.answer': { botId: BOT, askId: ASK, answer: 'allow' },
      'bots.questions.answer': { botId: BOT, questionId: 'q_00000000-0000-0000-0000-000000000000', choice: 'Yes', clientRequestId: 'r-q' },
      'bots.personal.pause': { botId: BOT },
      'bots.personal.resume': { botId: BOT },
      'bots.create': { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1' },
      'bots.update': { botId: BOT, name: 'Pip' },
      'bots.reminders.cancel': { botId: BOT, reminderId: 'rem_00000000-0000-0000-0000-000000000000' },
      'bots.schedules.remove': { botId: BOT, scheduleId: 'daily' },
      'bots.permissions.revoke': { botId: BOT, permissionId: 'p1' },
      'bots.memory.forget': { botId: BOT, id: 'm1' }
    }
    for (const name of Object.keys(REMOTE_BOT_METHODS) as RemoteBotMethod[]) {
      const error = await refused(() => call(methods, name, params[name]))
      expect(error).toMatchObject({ code: 'forbidden', message: "Desk doesn't share its bots with other devices.", details: { reason: 'setting_off' } })
      // The handler refuses too, for a call admitted just before the switch went off.
      await expect(methods.find((entry) => entry.method === name)!.handle(params[name], context)).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(reads).toBe(0)
  })

  it('while it is off, the lists carry no bots, and turning it on or off pushes them again', async () => {
    const f = botFixture()
    try {
      const { botId } = await createBot(f, { name: 'Penny', reply: 'Hello.' })
      let off = false
      const listeners = new Set<() => void>()
      const services = listsServices(f.bots, {
        refusal: () => (off ? "Desk doesn't share its bots with other devices." : undefined),
        onChange: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      })
      const timeouts: Array<() => void> = []
      const lists = new MmsListsSource(services, fakeTimers(timeouts))
      expect(lists.snapshot().bots.map((bot) => bot.id)).toEqual([botId])
      let pushes = 0
      const stop = lists.watch(() => pushes++)
      off = true
      for (const listener of listeners) listener()
      timeouts.splice(0).forEach((run) => run())
      expect(pushes).toBe(1)
      expect(lists.snapshot()).toMatchObject({ version: 1, bots: [] })
      off = false
      for (const listener of listeners) listener()
      timeouts.splice(0).forEach((run) => run())
      expect(pushes).toBe(2)
      expect(lists.snapshot().bots).toHaveLength(1)
      stop()
      expect(listeners.size).toBe(0)
    } finally {
      f.close()
    }
  })
})

describe('images and About from another device', () => {
  let f: BotFixture
  let botId: string
  let methods: RpcMethod[]
  let dir: string
  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    methods = remoteBotMethods({ bots: () => f.bots.service })
    dir = mkdtempSync(join(tmpdir(), 'remote-bot-files-'))
  })
  afterEach(() => {
    f.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const png = (size: number): Buffer => {
    const data = Buffer.alloc(size, 7)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
    return data
  }
  const sendWith = async (files: Array<{ name: string; data: Buffer }>): Promise<BotChatMessage> => {
    const attachments = files.map((file) => {
      const path = join(dir, file.name)
      writeFileSync(path, file.data)
      return { name: file.name, path }
    })
    const { message } = await f.bots.service.chatSend({ botId, text: 'Look', attachments, clientRequestId: `img-${files.length}-${files[0]!.name}` })
    return message
  }

  it('reads an image of the chat in parts, never its path', async () => {
    const data = png(100 * 1024)
    const message = await sendWith([{ name: 'shot.png', data }, { name: 'notes.txt', data: Buffer.from('hi') }])
    const page = (await call(methods, 'bots.chat.list', { botId })) as { messages: Array<{ id: string; attachments?: unknown }> }
    const row = page.messages.find((entry) => entry.id === message.id)!
    expect(row.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', image: true }, { name: 'notes.txt', mime: 'text/plain' }])
    expect(JSON.stringify(page)).not.toContain(dir)
    expect(JSON.stringify(page)).not.toContain('attachments/')
    const parts: Buffer[] = []
    for (let offset = 0; ;) {
      const part = (await call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 0, offset })) as { name: string; mime: string; size: number; offset: number; dataB64: string }
      expect(part).toMatchObject({ name: 'shot.png', mime: 'image/png', size: data.length, offset })
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(63 * 1024)
      const bytes = Buffer.from(part.dataB64, 'base64')
      parts.push(bytes)
      offset += bytes.length
      if (offset >= part.size) break
    }
    expect(parts.length).toBe(3)
    expect(Buffer.concat(parts).equals(data)).toBe(true)
    // A file that is not an image, and a file past the list, are refused.
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 1 }))).code).toBe('conflict')
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 2 }))).code).toBe('stream_unknown')
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: 'nope', index: 0 }))).code).toBe('stream_unknown')
  })

  it('refuses an image that is too large, not what its name says, or outside the bot\'s files', async () => {
    const big = await sendWith([{ name: 'big.png', data: png(1536 * 1024 + 1) }])
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: big.id, index: 0 }))).code).toBe('too_large')
    const fake = await sendWith([{ name: 'fake.png', data: Buffer.from('<svg onload="x()"/>') }])
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: fake.id, index: 0 }))).code).toBe('conflict')
    // A row that names a file anywhere else (it never does) is not read.
    const outside = join(dir, 'outside.png')
    writeFileSync(outside, png(100))
    f.store.run('UPDATE bot_messages SET attachments_json = ? WHERE id = ?', JSON.stringify([{ name: 'outside.png', path: outside }]), fake.id)
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: fake.id, index: 0 }))).code).toBe('stream_unknown')
  })

  it('renames a bot, lists its memory, and refuses to remove what it does not have before anything changes', async () => {
    expect(await call(methods, 'bots.update', { botId, name: 'Pip' })).toMatchObject({ bot: { id: botId, name: 'Pip' } })
    const memory = (await call(methods, 'bots.memory.list', { botId })) as { entries: unknown[]; gauge: string }
    expect(memory).toMatchObject({ entries: expect.any(Array), gauge: expect.any(String) })
    for (const [name, params] of [
      ['bots.reminders.cancel', { botId, reminderId: 'rem_00000000-0000-0000-0000-000000000000' }],
      ['bots.schedules.remove', { botId, scheduleId: 'nope' }],
      ['bots.permissions.revoke', { botId, permissionId: 'nope' }],
      ['bots.memory.forget', { botId, id: 'm999' }]
    ] as const) {
      const method = methods.find((entry) => entry.method === name)!
      // Refused by \`authorizeNew\`, before the dispatcher admits the call, so it is never an uncertain outcome.
      expect(() => method.authorizeNew!(params, context)).toThrow(NetError)
      expect((await refused(() => call(methods, name, params))).code).toBe('stream_unknown')
    }
  })
})

function fakeTimers(timeouts: Array<() => void>) {
  return {
    setTimeout: (run: () => void) => timeouts.push(run),
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined
  }
}

function listsServices(bots: unknown, botsSharing?: unknown): ListsServices {
  return {
    threads: Object.assign(new EventEmitter(), { listAllThreads: () => [] }),
    projects: { listProjects: () => [] },
    orchestrator: Object.assign(new EventEmitter(), { getTurnSnapshot: () => ({}) }),
    threadRuntimes: Object.assign(new EventEmitter(), { getActivitySnapshot: () => ({}) }),
    questions: new EventEmitter(),
    events: new EventEmitter(),
    platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } },
    personalBots: bots,
    ...(botsSharing ? { botsSharing } : {})
  } as unknown as ListsServices
}
