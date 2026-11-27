/**
 * Which of the owner's devices reach a personal bot (`docs/bots.md`, Two layers). The claim: to a device that is left
 * out, the bot does not exist; a device whose switch is off reaches no bot; only this computer's own window changes
 * either; a new bot reaches only its own computer (and its maker); a device linked later reaches no bot; and the
 * update's one-time snapshot narrows or widens nothing.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import {
  REMOTE_BOT_METHODS,
  remoteBotMethods,
  validateRemoteBotParams,
  type RemoteBotMethod
} from '../../../../src/mms/bridge/remote/RemoteBots'
import { createBotReach, keepMakerInReach, withHiddenBots } from '../../../../src/mms/bridge/remote/botReach'
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
    'bots.actions.answer': { botId, actionId: 'action-1', digest: 'digest-1', answer: 'not_now' },
    'bots.questions.answer': { botId, questionId: 'q_00000000-0000-0000-0000-000000000000', choice: 'Yes', clientRequestId: 'r-q' },
    'bots.personal.pause': { botId },
    'bots.personal.resume': { botId },
    'bots.update': { botId, name: 'Pip' },
    'bots.reminders.snooze': { botId, messageId: 'm1', choice: '10m' },
    'bots.reminders.cancel': { botId, reminderId: REM },
    'bots.schedules.remove': { botId, scheduleId: 'daily' },
    'bots.permissions.set': { botId, permissionId: 'p1', enabled: false },
    'bots.permissions.revoke': { botId, permissionId: 'p1' },
    'bots.memory.forget': { botId, id: 'm1' },
    'bots.memory.edit': { botId, id: 'm1', text: 'Call me Sam.' }
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
  // A profile past the one-time snapshot, as every start after this update is.
  store.snapshot([], [])
  f = botFixture({ deviceAccess: store })
})
/** The owner turns both devices on for these bots (About → Devices). */
const onBoth = (...botIds: string[]) => { for (const botId of botIds) store.set(botId, { mode: 'chosen', nodes: [PHONE, LAPTOP] }) }
afterEach(() => {
  f.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a bot the device may not reach answers as a bot that is not there', () => {
  it('for every method a device may call: the same code, words and details, before the call is admitted and as it runs', async () => {
    const shown = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    const hidden = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    const missing = 'bot-ffffffffffff'
    onBoth(shown)
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

  it('a saved result of an earlier call is not handed back to a device that has lost the bot since', async () => {
    const botId = (await createBot(f, { name: 'Server keeper', reply: 'Ready.' })).botId
    onBoth(botId)
    const { reach, switchOff } = reachOver(store)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'full' })
    const pause = methods.find((entry) => entry.method === 'bots.personal.pause')!
    // The call runs while the phone reaches the bot; the dispatcher keeps its result under this execution.
    await pause.handle({ botId }, { ...as(PHONE), execution: 'exec-1' } as RpcContext)
    const saved = (execution: string, node: string): string => {
      try {
        pause.authorizeResult!(execution as never, as(node).caller)
        return 'ok'
      } catch (error) {
        return (error as NetError).code
      }
    }
    expect(saved('exec-1', PHONE)).toBe('ok')
    // Taken off the bot: the saved result answers as a bot that is not there, like the call itself would.
    store.set(botId, { mode: 'chosen', nodes: [LAPTOP] })
    expect(saved('exec-1', PHONE)).toBe('stream_unknown')
    // A result whose bot is not known here (the service restarted since) goes only to a device no bot is held from: with
    // each list explicit, a bot without one (this computer alone) is held from every device.
    expect(saved('exec-from-before-a-restart', PHONE)).toBe('outcome_uncertain')
    expect(saved('exec-from-before-a-restart', LAPTOP)).toBe('outcome_uncertain')
    // Its switch off: refused as every bot call is.
    onBoth(botId)
    switchOff(PHONE)
    expect(saved('exec-1', PHONE)).toBe('forbidden')
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
  it('off: every method is refused (bots_off), for every bot alike, and its lists carry none', async () => {
    const botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    onBoth(botId)
    const { reach, switchOff } = reachOver(store)
    switchOff(PHONE)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach })
    for (const name of NAMED) {
      const real = await outcome(methods, name, paramsFor(botId)[name], as(PHONE))
      expect(real, name).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
      expect(await outcome(methods, name, paramsFor('bot-ffffffffffff')[name], as(PHONE)), name).toEqual(real)
    }
    expect(await outcome(methods, 'bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1' }, as(PHONE)))
      .toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
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
    onBoth(everyone)
    store.set(laptopOnly, { mode: 'chosen', nodes: [LAPTOP] })
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
    onBoth(botId)
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
    onBoth(botId)
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
    // A device making a bot asks for every device or for the home and itself; it can't name other devices or leave itself out.
    for (const reach of ['this_computer', 'chosen', { mode: 'chosen', nodes: [LAPTOP] }, [PHONE]])
      expect(() => validateRemoteBotParams('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1', reach }), JSON.stringify(reach)).toThrow(NetError)
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
      await expect(set(connection, { mode: 'chosen', nodes: [PHONE] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(store.get(botId).access).toEqual({ mode: 'this_computer' })
    // "All my devices" is gone: the list is explicit.
    expect(() => entry.validate({ botId, access: { mode: 'all' } })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
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
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, madeBy: keepMakerInReach(store, reach) })
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

/**
 * Which devices reach a bot, chosen as it is made. The inputs: who makes it (New bot on this computer, a device asking for
 * the home and itself, a device asking for every device, a device asking for nothing), what is stored before (nothing, a
 * file that can't be read), and what follows (a device watching its lists all along, a retry of the same request, a
 * failure before or after the bot is published, the owner walling it off while the device's create is finishing). A
 * crash and restart is in `tests/bots/botReachRestart.test.ts`.
 */
describe('a choice made when the bot is made', () => {
  const LOOK = { colour: 'teal', accessory: 'cap' }
  /** Every bot a device's lists carried at any moment something about bots changed: a bot announced, or a choice saved. */
  function watchLists(reach: BotReachPort, reader?: string) {
    const seen = new Set<string>()
    const look = () => { for (const bot of new MmsListsSource(listsServices(f, reach), undefined, reader ? { reader } : {}).snapshot().bots) seen.add(bot.id) }
    for (const event of ['changed', 'message', 'activity']) f.bots.events.on(event, look)
    store.onChange(look)
    return seen
  }
  const ids = (reach: BotReachPort, reader: string) => new MmsListsSource(listsServices(f, reach), undefined, { reader }).snapshot().bots.map((bot) => bot.id)
  const stored = () => (JSON.parse(readFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), 'utf8')) as { bots: Record<string, BotDeviceAccess> }).bots

  it('a new bot reaches only its own computer: a device watching its lists never sees it, whatever New bot or an older app sent', async () => {
    const { reach } = reachOver(store)
    const phone = watchLists(reach, PHONE)
    const everyone = watchLists(reach)
    const asked: Array<[string, Parameters<typeof createBot>[1]]> = [
      ['nothing', { name: 'Diary', reply: 'Hi.' }],
      ['this computer', { name: 'Notes', reply: 'Hi.', access: { mode: 'this_computer' } }],
      // An app from before the lists sends its Everywhere.
      ['an older app\'s Everywhere', { name: 'Shopping', reply: 'Hi.', access: { mode: 'all' } as never }]
    ]
    for (const [name, input] of asked) {
      const botId = (await createBot(f, input)).botId
      expect(phone.has(botId), name).toBe(false)
      expect(everyone.has(botId), name).toBe(false)
      expect(reach.canReach(botId, LAPTOP), name).toBe(false)
      // This computer's window lists it, and its menu has nothing to make private.
      expect(f.bots.service.list().bots.find((bot) => bot.id === botId)?.reach, name).toBe('this_computer')
    }
  })

  it('New bot with devices turned on: those devices and no other, from the first moment', async () => {
    const { reach } = reachOver(store)
    const laptop = watchLists(reach, LAPTOP)
    const botId = (await createBot(f, { name: 'Diary', reply: 'Hi.', access: { mode: 'chosen', nodes: [PHONE] } })).botId
    expect(stored()).toEqual({ [botId]: { mode: 'chosen', nodes: [PHONE] } })
    expect(ids(reach, PHONE)).toEqual([botId])
    expect(laptop.has(botId)).toBe(false)
    expect(f.bots.service.list().bots[0]?.reach).toBe('chosen')
  })

  it('a retry of the same request finds the bot it made and changes nothing, whatever it asks for now', async () => {
    const first = await createBot(f, { name: 'Diary', access: { mode: 'chosen', nodes: [PHONE] }, clientRequestId: 'desk-1' })
    const again = await createBot(f, { name: 'Diary', access: { mode: 'this_computer' }, clientRequestId: 'desk-1' })
    expect(again.botId).toBe(first.botId)
    expect(f.bots.service.list().bots.map((bot) => bot.id)).toEqual([first.botId])
    expect(stored()).toEqual({ [first.botId]: { mode: 'chosen', nodes: [PHONE] } })
  })

  it('a create that fails before the bot is published leaves no choice behind; one that fails after keeps it, and its retry finishes the bot', async () => {
    const { reach } = reachOver(store)
    const phone = watchLists(reach, PHONE)
    const laptopOnly = { mode: 'chosen', nodes: [LAPTOP] } as const
    vi.spyOn(f.bots, 'createBot').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(createBot(f, { name: 'Diary', access: { mode: 'chosen', nodes: [LAPTOP] }, clientRequestId: 'desk-1' })).rejects.toThrow('disk full')
    expect(f.bots.service.list().bots).toEqual([])
    expect(stored()).toEqual({})
    // Published, and then its home thread could not be made: the bot is there, so its choice stays with it.
    const ensureHome = vi.spyOn(f.bots as unknown as { ensureHome(botId: string, name: string): void }, 'ensureHome').mockImplementationOnce(() => { throw new Error('thread store busy') })
    await expect(createBot(f, { name: 'Diary', access: { mode: 'chosen', nodes: [LAPTOP] }, clientRequestId: 'desk-2' })).rejects.toThrow('thread store busy')
    const [made] = f.bots.service.list().bots
    expect(made?.reach).toBe('chosen')
    ensureHome.mockRestore()
    expect((await createBot(f, { name: 'Diary', access: { mode: 'chosen', nodes: [LAPTOP] }, clientRequestId: 'desk-2' })).botId).toBe(made!.id)
    expect(stored()).toEqual({ [made!.id]: laptopOnly })
    expect(phone.size).toBe(0)
  })

  it('a bot made from another device reaches this computer and its maker, and no other device ever sees it, whatever reach it asked for', async () => {
    const { reach } = reachOver(store)
    const laptop = watchLists(reach, LAPTOP)
    const methods = remoteBotMethods({ bots: () => f.bots.service, reach, madeBy: keepMakerInReach(store, reach) })
    const create = methods.find((entry) => entry.method === 'bots.create')!
    // `all` comes from a phone made before the lists were explicit: it is taken as the home and the maker, not refused.
    for (const [index, asked] of [{ reach: 'home_and_maker' }, { reach: 'all' }, {}].entries()) {
      const made = (await create.handle(create.validate!({ look: LOOK, name: 'Notes', description: 'Tidy my notes', clientRequestId: `phone-c${index}`, ...asked }), as(PHONE))) as { bot: { id: string } }
      expect(store.get(made.bot.id).access, JSON.stringify(asked)).toEqual({ mode: 'chosen', nodes: [PHONE] })
      expect(laptop.has(made.bot.id), JSON.stringify(asked)).toBe(false)
      expect(ids(reach, PHONE), JSON.stringify(asked)).toContain(made.bot.id)
      // Which devices reach it stays on this computer: the device's answer does not say.
      expect(made.bot).not.toHaveProperty('reach')
    }
  })

  it('the device that made a bot never widens a choice saved for it, such as the owner walling it off while the create finished', async () => {
    const { reach } = reachOver(store)
    // What is stored can't be read: a bot made without a choice would stand at this computer alone, and gain its maker.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), '{ nope')
    const service = f.bots.service
    // The owner sees the new bot on this computer and makes it private before the phone's create has answered.
    const port = Object.assign(Object.create(service) as typeof service, {
      create: async (input: Parameters<typeof service.create>[0]) => {
        const result = await service.create(input)
        store.set(result.bot.id, { mode: 'this_computer' })
        return result
      }
    })
    const methods = remoteBotMethods({ bots: () => port, reach, madeBy: keepMakerInReach(store, reach) })
    const create = methods.find((entry) => entry.method === 'bots.create')!
    const made = (await create.handle(create.validate!({ look: LOOK, name: 'Notes', description: 'Tidy my notes', clientRequestId: 'phone-c1' }), as(PHONE))) as { bot: { id: string } }
    expect(store.get(made.bot.id).access).toEqual({ mode: 'this_computer' })
    expect(reach.canReach(made.bot.id, PHONE)).toBe(false)
  })
})

describe('what is stored', () => {
  /**
   * The one-time snapshot on update. Rows: what an earlier build stored for a bot (All my devices, nothing, this computer,
   * chosen devices, a value it can't read, or a file with `missing: this_computer` after a bad file), and which devices
   * are linked when the snapshot runs (two, or none).
   */
  const A = 'bot-aaaaaaaaaaaa', B = 'bot-bbbbbbbbbbbb', C = 'bot-cccccccccccc', D = 'bot-dddddddddddd', E = 'bot-eeeeeeeeeeee'
  const earlier = (file: unknown) => {
    rmSync(join(dir, BOT_DEVICE_ACCESS_FILE), { force: true })
    if (file !== undefined) writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), JSON.stringify(file))
    return new BotDeviceAccessStore(dir)
  }
  it.each([
    ['All my devices, with two linked', { version: 1, bots: { [A]: { mode: 'all' } } }, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'chosen', nodes: [PHONE, LAPTOP] }],
    ['no choice stored, with two linked', { version: 1, bots: {} }, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'chosen', nodes: [PHONE, LAPTOP] }],
    ['no file at all, with two linked', undefined, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'chosen', nodes: [PHONE, LAPTOP] }],
    ['All my devices, with none linked', { version: 1, bots: { [A]: { mode: 'all' } } }, [], { mode: 'this_computer' }, { mode: 'this_computer' }],
    ['this computer', { version: 1, bots: { [A]: { mode: 'this_computer' } } }, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'this_computer' }],
    ['chosen devices', { version: 1, bots: { [A]: { mode: 'chosen', nodes: [LAPTOP] } } }, [PHONE, LAPTOP], { mode: 'chosen', nodes: [LAPTOP] }, { mode: 'chosen', nodes: [LAPTOP] }],
    ['a value it can\'t read', { version: 1, bots: { [A]: { mode: 'everyone' } } }, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'this_computer' }],
    ['no choice, after a file that could not be read', { version: 1, bots: {}, missing: 'this_computer' }, [PHONE, LAPTOP], { mode: 'this_computer' }, { mode: 'this_computer' }]
  ] as const)('on update, %s: no other device reaches it until the snapshot, which gives it the devices linked then', (_name, file, devices, before, after) => {
    const fresh = earlier(file)
    // Until the snapshot, an earlier build's every device reads as this computer alone: no device reaches it in between.
    expect(fresh.get(A).access).toEqual(before)
    expect(fresh.needsSnapshot()).toBe(true)
    expect(fresh.snapshot([A], devices)).toBe(true)
    expect(fresh.get(A).access).toEqual(after)
    expect(JSON.parse(readFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), 'utf8'))).toMatchObject({ version: 2 })
  })

  it('the snapshot runs once: a restart, or a device linked since, changes nothing; a bot without a choice after it reaches this computer alone', () => {
    const fresh = earlier({ version: 1, bots: { [A]: { mode: 'all' } } })
    expect(fresh.snapshot([A, B], [PHONE])).toBe(true)
    const restarted = new BotDeviceAccessStore(dir)
    expect(restarted.needsSnapshot()).toBe(false)
    // LAPTOP is linked later: the snapshot does not run again, and it reaches no existing bot.
    expect(restarted.snapshot([A, B, C], [PHONE, LAPTOP])).toBe(false)
    expect(restarted.get(A).access).toEqual({ mode: 'chosen', nodes: [PHONE] })
    expect(restarted.get(B).access).toEqual({ mode: 'chosen', nodes: [PHONE] })
    expect(restarted.get(C).access).toEqual({ mode: 'this_computer' })
    const { reach } = reachOver(restarted)
    for (const botId of [A, B, C]) expect(reach.canReach(botId, LAPTOP), botId).toBe(false)
  })

  it('a bot made before the snapshot, as this computer alone, is not widened by it', async () => {
    rmSync(join(dir, BOT_DEVICE_ACCESS_FILE), { force: true })
    const fresh = new BotDeviceAccessStore(dir)
    const fixture = botFixture({ deviceAccess: fresh })
    try {
      const botId = (await createBot(fixture, { name: 'Diary', reply: 'Hi.' })).botId
      expect(fresh.get(botId).access).toEqual({ mode: 'this_computer' })
      fresh.snapshot([botId, D], [PHONE, LAPTOP])
      expect(fresh.get(botId).access).toEqual({ mode: 'this_computer' })
      // An earlier bot, with no choice stored, keeps every device linked now.
      expect(fresh.get(D).access).toEqual({ mode: 'chosen', nodes: [PHONE, LAPTOP] })
    } finally {
      fixture.close()
    }
  })

  it('a file that can\'t be read at the snapshot is put aside, and every bot stays at this computer alone', () => {
    rmSync(join(dir, BOT_DEVICE_ACCESS_FILE), { force: true })
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), '{ nope')
    const broken = new BotDeviceAccessStore(dir, () => 7)
    expect(broken.needsSnapshot()).toBe(true)
    expect(broken.snapshot([E], [PHONE, LAPTOP])).toBe(true)
    expect(readdirSync(dir)).toContain(`${BOT_DEVICE_ACCESS_FILE}.corrupt-7`)
    expect(broken.get(E)).toEqual({ access: { mode: 'this_computer' }, unreadable: false })
    expect(broken.needsSnapshot()).toBe(false)
  })

  it('what can\'t be read means only this computer, and the next change keeps the rest there', () => {
    const cases: Array<[string, string]> = [
      ['not JSON', '{ nope'],
      ['another version', JSON.stringify({ version: 3, bots: {} })],
      ['bots not an object', JSON.stringify({ version: 1, bots: [] })],
      ['an unknown default', JSON.stringify({ version: 1, bots: {}, missing: 'all' })],
      ['a default at version 2', JSON.stringify({ version: 2, bots: {}, missing: 'this_computer' })]
    ]
    for (const [name, text] of cases) {
      writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), text)
      const fresh = new BotDeviceAccessStore(dir)
      expect(fresh.get('bot-aaaaaaaaaaaa'), name).toEqual({ access: { mode: 'this_computer' }, unreadable: true })
    }
    // One entry that can't be read holds back that bot only; at version 2 "every device" is one of those.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), JSON.stringify({ version: 2, bots: { 'bot-aaaaaaaaaaaa': { mode: 'chosen', nodes: ['../x'] }, 'bot-bbbbbbbbbbbb': { mode: 'all' }, 'bot-dddddddddddd': { mode: 'chosen', nodes: [PHONE] } } }))
    const partly = new BotDeviceAccessStore(dir)
    expect(partly.get('bot-aaaaaaaaaaaa')).toEqual({ access: { mode: 'this_computer' }, unreadable: true })
    expect(partly.get('bot-bbbbbbbbbbbb')).toEqual({ access: { mode: 'this_computer' }, unreadable: true })
    expect(partly.get('bot-dddddddddddd')).toEqual({ access: { mode: 'chosen', nodes: [PHONE] }, unreadable: false })
    expect(partly.get('bot-cccccccccccc')).toEqual({ access: { mode: 'this_computer' }, unreadable: false })
    // A file that can't be read is put aside at the next change, and the other bots stay on this computer.
    writeFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), '{ nope')
    const broken = new BotDeviceAccessStore(dir, () => 42)
    broken.set('bot-aaaaaaaaaaaa', { mode: 'chosen', nodes: [PHONE] })
    expect(readdirSync(dir)).toContain(`${BOT_DEVICE_ACCESS_FILE}.corrupt-42`)
    expect(broken.get('bot-aaaaaaaaaaaa')).toEqual({ access: { mode: 'chosen', nodes: [PHONE] }, unreadable: false })
    expect(broken.get('bot-bbbbbbbbbbbb').access).toEqual({ mode: 'this_computer' })
    expect(JSON.parse(readFileSync(join(dir, BOT_DEVICE_ACCESS_FILE), 'utf8'))).toEqual({ version: 2, bots: { 'bot-aaaaaaaaaaaa': { mode: 'chosen', nodes: [PHONE] } } })
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

describe('disk usage on another device', () => {
  it('counts a bot\'s threads without naming them: they are named after the bot and its work', async () => {
    const at = '2026-11-13T10:00:00.000Z'
    const threads = [
      { id: 'home-1', name: 'Server keeper', botOwned: true, createdAt: at, updatedAt: at },
      { id: 'work-1', name: 'Restart the database', botOwned: true, createdAt: at, updatedAt: at },
      { id: 'mine', name: 'Fix the login page', createdAt: at, updatedAt: at }
    ]
    const usage = {
      measuredAt: at, durationMs: 1, partial: false,
      entries: [{ kind: 'thread', threadId: 'home-1', bytes: 10, files: 1 }, { kind: 'thread', threadId: 'work-1', bytes: 20, files: 1 }, { kind: 'thread', threadId: 'mine', bytes: 30, files: 1 }],
      names: { projects: {}, threads: { 'home-1': 'Server keeper', 'work-1': 'Restart the database', mine: 'Fix the login page' } }
    }
    const services = { threads: { listAllThreads: () => threads, getThread: (id: string) => threads.find((thread) => thread.id === id) }, projects: { listProjects: () => [] }, storageUsage: { measure: async () => usage } }
    const { MmsRemoteBackend } = await import('../../../../src/mms/bridge/remote/MmsBackend')
    const seen = (await new MmsRemoteBackend(services as never).execute('storage.usage', {}, { node: PHONE as never })) as typeof usage
    expect(JSON.stringify(seen)).not.toMatch(/Server keeper|Restart the database|home-1|work-1/)
    expect(seen.entries.map((entry) => entry.bytes)).toEqual([10, 20, 30])
    expect(seen.names.threads).toEqual({ mine: 'Fix the login page' })
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

it.each(['send', 'not_now'] as const)('held-action %s rechecks real bot Reach and its saved-result scope before reaching the backend', async answer => {
  const { botId } = await createBot(f, { reply: 'Ready.' })
  const { reach, switchOff } = reachOver(store)
  store.set(botId, { mode: 'chosen', nodes: [PHONE] })
  const card = { seq: 500, id: 'bm_action_one', at: '2026-11-07T09:00:00.000Z', author: 'bot' as const, kind: 'notice' as const, text: 'Mail review', chips: [], action: {
    actionId: 'action-one', digest: 'shown', title: 'Send email', serverName: 'Mail', args: { to: 'one@example.test' }, hasHiddenValues: false, hiddenPaths: [], status: 'open' as const
  } }
  // The backend is scripted: this case proves the bridge's authorization boundary, not execution of an email.
  vi.spyOn(f.bots.service, 'actionMessage').mockReturnValue(card)
  const admission = vi.spyOn(f.bots.service, 'actionCheck').mockImplementation(() => {})
  const backend = vi.spyOn(f.bots.service, 'answerAction').mockResolvedValue({ status: answer === 'send' ? 'done' : 'declined' })
  const methods = remoteBotMethods({ bots: () => f.bots.service, reach, deviceLimit: () => 'accept_edits' })
  const params = { botId, actionId: 'action-one', digest: 'shown', answer }
  const context = { ...as(PHONE), execution: 'execution-action-one' } as RpcContext
  expect(await outcome(methods, 'bots.actions.answer', params, context)).toEqual({ ok: true })
  expect(backend).toHaveBeenCalledExactlyOnceWith(params)
  expect(admission).toHaveBeenCalledExactlyOnceWith(params)
  const method = methods.find(method => method.method === 'bots.actions.answer')!
  store.set(botId, { mode: 'chosen', nodes: [LAPTOP] })
  expect(await outcome(methods, 'bots.actions.answer', params, context)).toMatchObject({ code: 'stream_unknown' })
  expect(() => method.authorizeResult!('execution-action-one', context.caller)).toThrow(NetError)
  // Taking Reach away after admission is checked in the real handler too.
  await expect(method.handle(params, context)).rejects.toMatchObject({ code: 'stream_unknown' })
  store.set(botId, { mode: 'chosen', nodes: [PHONE] })
  switchOff(PHONE)
  expect(await outcome(methods, 'bots.actions.answer', params, context)).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
  expect(backend).toHaveBeenCalledTimes(1)
})
