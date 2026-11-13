/**
 * Which of the owner's devices reach a personal bot (`docs/bots.md`, Two layers). The claim: to a device that is left
 * out, the bot does not exist; a device whose switch is off reaches no bot; only this computer's own window changes
 * either; and an update narrows or widens nothing.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import {
  REMOTE_BOT_METHODS,
  remoteBotMethods,
  validateRemoteBotParams,
  type RemoteBotMethod
} from '../../../../src/mms/bridge/remote/RemoteBots'
import { createBotReach, withHiddenBots } from '../../../../src/mms/bridge/remote/botReach'
import { MmsListsSource, type ListsServices } from '../../../../src/mms/bridge/remote/MmsListsSource'
import { BotDeviceAccessStore, BOT_DEVICE_ACCESS_FILE } from '../../../../src/mms/bots/definitions/BotDeviceAccessStore'
import { registerBotDeviceMethods, type BotDevicesSource } from '../../../../src/mms/bots/deviceMethods'
import { NOT_DELIVERED_TEXT } from '../../../../src/mms/bots/chat/BotChatService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { classifyRoutedMethod } from '../../../../src/shared/bridge/routed'
import { BRIDGE_REMOTE_METHODS } from '../../../../src/mms/bridge/remote/capabilities'
import { NET_LOCAL_METHODS } from '../../../../src/shared/net/local'
import { BOT_DEVICE_METHODS, type BotDeviceAccess } from '../../../../src/shared/bots/personal/deviceAccess'
import type { BotReachPort } from '../../../../src/mms/protocol/botReachPort'
import { botFixture, chatOf, createBot, type BotFixture } from '../../../bots/botFixture'

const PHONE = newId('node')
const LAPTOP = newId('node')
const ASK = 'esc_00000000-0000-0000-0000-000000000000'
const REM = 'rem_00000000-0000-0000-0000-000000000000'
const WORK = 'act_00000000-0000-0000-0000-000000000000'
const as = (node: string) => ({ caller: { node, user: 'usr_x' }, signal: new AbortController().signal }) as unknown as RpcContext

/** The params a device sends for each method that names a bot, for `botId`. */
function paramsFor(botId: string): Record<Exclude<RemoteBotMethod, 'bots.create'>, Record<string, unknown>> {
  return {
    'bots.get': { botId },
    'bots.chat.list': { botId },
    'bots.chat.attachment': { botId, messageId: 'm1', index: 0 },
    'bots.memory.list': { botId },
    'bots.chat.send': { botId, text: 'Hi', clientRequestId: `send-${botId}` },
    'bots.chat.stop': { botId },
    'bots.work.stop': { botId, workId: WORK },
    'bots.chat.markRead': { botId, seq: 1 },
    'bots.asks.answer': { botId, askId: ASK, answer: 'allow' },
    'bots.personal.pause': { botId },
    'bots.personal.resume': { botId },
    'bots.update': { botId, name: 'Pip' },
    'bots.reminders.cancel': { botId, reminderId: REM },
    'bots.schedules.remove': { botId, scheduleId: 'daily' },
    'bots.permissions.revoke': { botId, permissionId: 'p1' },
    'bots.memory.forget': { botId, id: 'm1' }
  }
}
const NAMED = Object.keys(REMOTE_BOT_METHODS).filter((name) => name !== 'bots.create') as Array<Exclude<RemoteBotMethod, 'bots.create'>>

/** What a call answers, as the dispatcher runs it for a new execution: validate, authorize, authorizeNew, handle. */
async function outcome(methods: RpcMethod[], name: RemoteBotMethod, params: unknown, context: RpcContext): Promise<{ ok: true } | { code: string; message?: string; details?: unknown }> {
  const method = methods.find((entry) => entry.method === name)!
  try {
    const valid = method.validate ? method.validate(params) : params
    method.authorize?.(valid, context)
    method.authorizeNew?.(valid, context)
    await method.handle(valid, context)
    return { ok: true }
  } catch (error) {
    expect(error).toBeInstanceOf(NetError)
    const refused = error as NetError
    return { code: refused.code, message: refused.message, details: refused.details }
  }
}

/** A reach over a real store, with each device's switch and the devices on the account set by the test. */
function reachOver(store: BotDeviceAccessStore, devices = [PHONE, LAPTOP]) {
  const off = new Set<string>()
  const changes = new Set<() => void>()
  const reach = createBotReach({
    access: (botId) => store.get(botId).access,
    choices: () => store.choices(),
    deviceOn: (node) => !off.has(node),
    devices: () => devices,
    changes: [(listener) => store.onChange(listener), (listener) => { changes.add(listener); return () => changes.delete(listener) }]
  })
  return {
    reach: { ...reach, devices: async () => [] } as BotReachPort,
    switchOff: (node: string) => { off.add(node); for (const listener of changes) listener() }
  }
}

let dir: string
let f: BotFixture
let store: BotDeviceAccessStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-device-access-'))
  store = new BotDeviceAccessStore(dir)
  f = botFixture()
})
afterEach(() => {
  f.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a bot the device may not reach answers as a bot that is not there', () => {
  it('for every method a device may call: the same code, words and details, before the call is admitted and as it runs', async () => {
    const shown = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const hidden = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    const missing = 'bot-ffffffffffff'
    store.set(hidden, { mode: 'chosen', nodes: [LAPTOP] })
    const { reach } = reachOver(store)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'full' })
    for (const name of NAMED) {
      const method = methods.find((entry) => entry.method === name)!
      // The bot it reaches is admitted (what the call then finds is its own business).
      expect(() => method.authorize!(method.validate!(paramsFor(shown)[name]), as(PHONE)), name).not.toThrow()
      const fromHidden = await outcome(methods, name, paramsFor(hidden)[name], as(PHONE))
      const fromMissing = await outcome(methods, name, paramsFor(missing)[name], as(PHONE))
      expect(fromHidden, name).toEqual(fromMissing)
      expect(fromHidden, name).toMatchObject({ code: 'stream_unknown' })
      // A call admitted just before the device was taken off the bot gets nothing either.
      const late = await method.handle(paramsFor(hidden)[name], as(PHONE)).then(() => 'ran', (error: NetError) => error.code)
      expect(late, name).toBe('stream_unknown')
      // The device on its list reaches it.
      expect(() => method.authorize!(method.validate!(paramsFor(hidden)[name]), as(LAPTOP)), name).not.toThrow()
    }
    // Nothing the hidden bot holds changed: no message from the phone reached its chat.
    expect(chatOf(f, hidden).some((message) => message.author === 'owner' && message.text === 'Hi')).toBe(false)
  })

  it('a device on a bot\'s list may not reach another bot through the first one\'s ids', async () => {
    const mine = (await createBot(f, { name: 'Notes', reply: 'Hi.' })).botId
    const theirs = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    store.set(mine, { mode: 'chosen', nodes: [PHONE] })
    store.set(theirs, { mode: 'this_computer' })
    const { reach } = reachOver(store)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'full' })
    // An ask, reminder or message of one bot is looked for in the bot the call names, which the device must reach.
    const message = chatOf(f, theirs)[0]!
    expect(await outcome(methods, 'bots.chat.attachment', { botId: theirs, messageId: message.id, index: 0 }, as(PHONE))).toMatchObject({ code: 'stream_unknown' })
    expect(await outcome(methods, 'bots.chat.attachment', { botId: mine, messageId: message.id, index: 0 }, as(PHONE))).toMatchObject({ code: 'stream_unknown' })
  })
})

describe('Bots on this computer, per device', () => {
  it('off: every method is refused as if this computer shared no bots, for every bot alike, and its lists carry none', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const { reach, switchOff } = reachOver(store)
    switchOff(PHONE)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach })
    for (const name of NAMED) {
      const real = await outcome(methods, name, paramsFor(botId)[name], as(PHONE))
      expect(real, name).toMatchObject({ code: 'forbidden', details: { reason: 'setting_off' } })
      expect(await outcome(methods, name, paramsFor('bot-ffffffffffff')[name], as(PHONE)), name).toEqual(real)
    }
    expect(await outcome(methods, 'bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1' }, as(PHONE)))
      .toMatchObject({ code: 'forbidden', details: { reason: 'setting_off' } })
    // The laptop's switch is still on.
    expect(await outcome(methods, 'bots.get', { botId }, as(LAPTOP))).toEqual({ ok: true })
    const lists = (reader?: string) => new MmsListsSource(listsServices(f, reach), undefined, reader ? { reader } : {}).snapshot().bots.map((bot) => bot.id)
    expect(lists(PHONE)).toEqual([])
    expect(lists(LAPTOP)).toEqual([botId])
    // The lists every device may read carry no bot while one device may not have it.
    expect(lists()).toEqual([])
  })
})

describe('lists', () => {
  it('each device\'s lists carry the bots it reaches; the shared lists only those every device reaches', async () => {
    const everyone = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const laptopOnly = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    const here = (await createBot(f, { name: 'Diary', reply: 'Hi.' })).botId
    store.set(laptopOnly, { mode: 'chosen', nodes: [LAPTOP] })
    store.set(here, { mode: 'this_computer' })
    const { reach } = reachOver(store)
    // Bots made in the same instant list in either order.
    const ids = (reader?: string) => new MmsListsSource(listsServices(f, reach), undefined, reader ? { reader } : {}).snapshot().bots.map((bot) => bot.id).sort()
    expect(ids(PHONE)).toEqual([everyone])
    expect(ids(LAPTOP)).toEqual([everyone, laptopOnly].sort())
    expect(ids()).toEqual([everyone])
    // Another computer's private lists are filtered for it the same way.
    expect(new MmsListsSource(listsServices(f, reach), undefined, { private: true, reader: PHONE }).snapshot().bots.map((bot) => bot.id)).toEqual([everyone])
  })

  it('push again at once when a bot leaves a device', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const { reach } = reachOver(store)
    const timeouts: Array<() => void> = []
    const lists = new MmsListsSource(listsServices(f, reach), { setTimeout: (run: () => void) => timeouts.push(run), clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined }, { reader: PHONE })
    let pushes = 0
    const stop = lists.watch(() => pushes++)
    expect(lists.snapshot().bots.map((bot) => bot.id)).toEqual([botId])
    store.set(botId, { mode: 'chosen', nodes: [LAPTOP] })
    timeouts.splice(0).forEach((run) => run())
    expect(pushes).toBe(1)
    expect(lists.snapshot().bots).toEqual([])
    stop()
  })
})

describe('what is already under way', () => {
  it('a queued message from a device that lost the bot is not delivered; running work carries on', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const { reach } = reachOver(store)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'accept_edits' })
    // The owner's own message is running; the phone's waits behind it.
    await f.bots.service.chatSend({ botId, text: 'Sort my notes', clientRequestId: 'desk-1' })
    const running = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(await outcome(methods, 'bots.chat.send', { botId, text: 'And my photos', clientRequestId: 'phone-1' }, as(PHONE))).toEqual({ ok: true })
    const queued = f.store.laneActivations(botId, 'chat', ['queued'])
    expect(queued).toHaveLength(1)
    store.set(botId, { mode: 'this_computer' })
    expect(await f.bots.service.withdrawQueued((id, node) => !reach.canReach(id, node))).toBe(1)
    expect(f.store.activation(queued[0]!.id)!.status).toBe('cancelled')
    expect(f.store.activation(running.id)!.status).toBe('running')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ author: 'bot', text: NOT_DELIVERED_TEXT })
    // Once is enough: nothing else is withdrawn the next time.
    expect(await f.bots.service.withdrawQueued((id, node) => !reach.canReach(id, node))).toBe(0)
  })

  it('a card is no longer answerable from a device taken off the bot', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const { reach } = reachOver(store)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'full' })
    store.set(botId, { mode: 'chosen', nodes: [LAPTOP] })
    expect(await outcome(methods, 'bots.asks.answer', { botId, askId: ASK, answer: 'not_now' }, as(PHONE))).toMatchObject({ code: 'stream_unknown' })
  })
})

describe('who changes it', () => {
  it('no method a device may call changes it: not in its table, not routed, and bots.update takes a name and a look only', () => {
    for (const method of BOT_DEVICE_METHODS) {
      expect(Object.keys(REMOTE_BOT_METHODS)).not.toContain(method)
      expect(Object.keys(BRIDGE_REMOTE_METHODS)).not.toContain(method)
      expect(classifyRoutedMethod(method)).toMatchObject({ kind: 'local' })
    }
    // The device switch is a Devices limit: local to this computer, never routed, not callable by a device.
    expect(NET_LOCAL_METHODS).toContain('bridge.policy')
    expect(classifyRoutedMethod('bridge.policy')).toMatchObject({ kind: 'local' })
    expect(classifyRoutedMethod('settings.set')).toMatchObject({ kind: 'local' })
    for (const extra of [{ access: { mode: 'all' } }, { devices: [PHONE] }, { mode: 'all' }])
      expect(() => validateRemoteBotParams('bots.update', { botId: 'bot-0123456789ab', name: 'Pip', ...extra })).toThrow(NetError)
    expect(() => validateRemoteBotParams('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1', access: { mode: 'all' } })).toThrow(NetError)
  })

  it('only this computer\'s window or command line may read or set it: a call through Bridge or any other client is refused', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const domains = new DomainHandlerRegistry()
    const source: BotDevicesSource = {
      assertBot: (id) => { if (id !== botId) throw Object.assign(new Error('gone'), { code: 'bot_not_found' }) },
      store,
      devices: async () => [{ node: PHONE, name: 'Pocket', kind: 'phone' }]
    }
    registerBotDeviceMethods(domains, () => source)
    const entry = (domains as unknown as { entries: Map<string, { validate(p: unknown): unknown; handle(c: unknown, p: unknown, b: unknown): Promise<unknown> }> }).entries.get('bots.devices.set')!
    const set = (connection: unknown, access: BotDeviceAccess) =>
      entry.handle({ connection }, entry.validate({ botId, access }), { profileId: 'p', epoch: 1 })
    const routed = { id: 'c1', capabilities: new Set(), clientType: 'bridge', bridgeCaller: { node: PHONE, user: 'usr_x', maxPermissionMode: 'full' } }
    for (const connection of [routed, { id: 'c2', capabilities: new Set(), clientType: 'unknown' }, { id: 'c3', capabilities: new Set(), clientType: 'test' }, undefined])
      await expect(set(connection, { mode: 'all' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(store.get(botId).access).toEqual({ mode: 'all' })
    await expect(set({ id: 'c4', capabilities: new Set(), clientType: 'gui' }, { mode: 'chosen', nodes: [PHONE] })).resolves.toMatchObject({ access: { mode: 'chosen', nodes: [PHONE] } })
    await expect(set({ id: 'c5', capabilities: new Set(), clientType: 'cli' }, { mode: 'this_computer' })).resolves.toMatchObject({ access: { mode: 'this_computer' } })
    // A device that is not on the account can't be picked.
    await expect(set({ id: 'c6', capabilities: new Set(), clientType: 'gui' }, { mode: 'chosen', nodes: [LAPTOP] })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('a bot a device makes is one that device reaches, and no other bot changes', async () => {
    const other = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    // What is stored can't be read: every bot, a new one too, stands at this computer alone.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), '{ not json')
    const { reach } = reachOver(store)
    const methods = remoteBotMethods({
      bots: () => f.bots.service,
      reach,
      madeBy: (botId, node) => {
        const held = store.get(botId).access
        if (!reach.canReach(botId, node)) store.set(botId, { mode: 'chosen', nodes: [...(held.mode === 'chosen' ? held.nodes : []), node] })
      }
    })
    const params = { look: { colour: 'teal', accessory: 'cap' }, name: 'Notes', description: 'Tidy my notes', clientRequestId: 'phone-c1' }
    const method = methods.find((entry) => entry.method === 'bots.create')!
    const made = (await method.handle(method.validate!(params), as(PHONE))) as { bot: { id: string } }
    expect(store.get(made.bot.id).access).toEqual({ mode: 'chosen', nodes: [PHONE] })
    expect(store.get(other).access).toEqual({ mode: 'this_computer' })
    expect(reach.canReach(made.bot.id, PHONE)).toBe(true)
    expect(reach.canReach(made.bot.id, LAPTOP)).toBe(false)
    // The same request id again names that bot; the laptop, which does not reach it, gets nothing and widens nothing.
    expect(await outcome(methods, 'bots.create', params, as(LAPTOP))).toMatchObject({ code: 'stream_unknown' })
    expect(store.get(made.bot.id).access).toEqual({ mode: 'chosen', nodes: [PHONE] })
  })
})

describe('what is stored', () => {
  it('an update changes nothing: no file means every bot on every device, and a new bot starts there too', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    expect(existsSync(join(dir, BOT_DEVICE_ACCESS_FILE))).toBe(false)
    expect(store.get(botId)).toEqual({ access: { mode: 'all' }, unreadable: false })
    const { reach } = reachOver(store)
    expect(reach.canReach(botId, PHONE) && reach.canReach(botId, LAPTOP) && reach.everyone(botId)).toBe(true)
    expect(reach.hiddenFor(PHONE)).toBeUndefined()
    expect(reach.hiddenFor()).toBeUndefined()
    // Reading writes nothing.
    expect(existsSync(join(dir, BOT_DEVICE_ACCESS_FILE))).toBe(false)
    // A choice that was saved is read back as it was, by a new store (a restart).
    store.set(botId, { mode: 'chosen', nodes: [PHONE] })
    expect(new BotDeviceAccessStore(dir).get(botId)).toEqual({ access: { mode: 'chosen', nodes: [PHONE] }, unreadable: false })
    expect(new BotDeviceAccessStore(dir).get('bot-aaaaaaaaaaaa').access).toEqual({ mode: 'all' })
  })

  it('what can\'t be read means only this computer, and the next change keeps the rest there', () => {
    const cases: Array<[string, string]> = [
      ['not JSON', '{ nope'],
      ['another version', JSON.stringify({ version: 2, bots: {} })],
      ['bots not an object', JSON.stringify({ version: 1, bots: [] })],
      ['an unknown default', JSON.stringify({ version: 1, bots: {}, missing: 'all' })]
    ]
    for (const [name, text] of cases) {
      writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), text)
      const fresh = new BotDeviceAccessStore(dir)
      expect(fresh.get('bot-aaaaaaaaaaaa'), name).toEqual({ access: { mode: 'this_computer' }, unreadable: true })
    }
    // One entry that can't be read holds back that bot only.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), JSON.stringify({ version: 1, bots: { 'bot-aaaaaaaaaaaa': { mode: 'chosen', nodes: ['../x'] }, 'bot-bbbbbbbbbbbb': { mode: 'all' } } }))
    const partly = new BotDeviceAccessStore(dir)
    expect(partly.get('bot-aaaaaaaaaaaa')).toEqual({ access: { mode: 'this_computer' }, unreadable: true })
    expect(partly.get('bot-bbbbbbbbbbbb')).toEqual({ access: { mode: 'all' }, unreadable: false })
    expect(partly.get('bot-cccccccccccc').access).toEqual({ mode: 'all' })
    // A file that can't be read is put aside at the next change, and the other bots stay on this computer.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), '{ nope')
    const broken = new BotDeviceAccessStore(dir, () => 42)
    broken.set('bot-aaaaaaaaaaaa', { mode: 'all' })
    expect(readdirSync(dir)).toContain(`${BOT_DEVICE_ACCESS_FILE}.corrupt-42`)
    expect(broken.get('bot-aaaaaaaaaaaa')).toEqual({ access: { mode: 'all' }, unreadable: false })
    expect(broken.get('bot-bbbbbbbbbbbb').access).toEqual({ mode: 'this_computer' })
    expect(JSON.parse(readFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), 'utf8'))).toMatchObject({ version: 1, missing: 'this_computer' })
  })

  it('a device removed from the account leaves every bot\'s list', () => {
    store.set('bot-aaaaaaaaaaaa', { mode: 'chosen', nodes: [PHONE, LAPTOP] })
    store.set('bot-bbbbbbbbbbbb', { mode: 'this_computer' })
    expect(store.dropDevices((node) => node === LAPTOP)).toBe(true)
    expect(store.get('bot-aaaaaaaaaaaa').access).toEqual({ mode: 'chosen', nodes: [LAPTOP] })
    expect(store.get('bot-bbbbbbbbbbbb').access).toEqual({ mode: 'this_computer' })
    expect(store.dropDevices((node) => node === LAPTOP)).toBe(false)
  })
})

describe('"Started by" on a thread a bot started', () => {
  it('names the bot only to a device that reaches it; any other gets "a bot", with no id and no launcher', async () => {
    const botId = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    store.set(botId, { mode: 'chosen', nodes: [LAPTOP] })
    const { reach } = reachOver(store)
    const thread = { id: 't1', name: 'Fix the login page', startedByBot: { botId, name: 'Server keeper' }, createdByThreadId: 'home-1' }
    const result = { thread, threads: [thread, { id: 't2', name: 'Mine' }] }
    const forPhone = withHiddenBots(result, reach.hiddenFor(PHONE))
    expect(forPhone.thread).toEqual({ id: 't1', name: 'Fix the login page', startedByBot: { botId: '', name: 'a bot' } })
    expect(JSON.stringify(forPhone)).not.toMatch(/Server keeper|home-1|bot-/)
    expect(forPhone.threads[1]).toBe(result.threads[1])
    expect(withHiddenBots(result, reach.hiddenFor(LAPTOP))).toBe(result)
    // A stream every device may read names it only when every device reaches it.
    expect(withHiddenBots(result, reach.hiddenFor()).thread.startedByBot).toEqual({ botId: '', name: 'a bot' })
  })
})

function listsServices(fixture: BotFixture, botReach: BotReachPort): ListsServices {
  return {
    threads: Object.assign(new EventEmitter(), { listAllThreads: () => [] }),
    projects: { listProjects: () => [] },
    orchestrator: Object.assign(new EventEmitter(), { getTurnSnapshot: () => ({}) }),
    threadRuntimes: Object.assign(new EventEmitter(), { getActivitySnapshot: () => ({}) }),
    questions: new EventEmitter(),
    events: new EventEmitter(),
    platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } },
    personalBots: fixture.bots,
    botReach
  } as unknown as ListsServices
}
