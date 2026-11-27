/**
 * `BOT_METHODS` is the one table of personal-bot methods: every bot method this daemon registers for its own clients,
 * and every one another device may call, has exactly one row, and the registrations and the access classes come from
 * it. Read from the real registrations, so a method registered by hand outside the table fails here.
 */
import { describe, expect, it } from 'vitest'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { registerBotDeviceMethods } from '../../src/mms/bots/deviceMethods'
import { registerBotBrowserMethods } from '../../src/mms/bots/browser/registerBotBrowserMethods'
import { remoteBotMethods } from '../../src/mms/bridge/remote/RemoteBots'
import { BOT_METHODS, REMOTE_BOT_METHOD_NAMES, localBotMethods, type BotMethod } from '../../src/shared/bots/personal/methodTable'
import { ACCESS_CLASSES, METHOD_ACCESS } from '../../src/shared/net/accessClasses'

const rows = BOT_METHODS as Record<BotMethod, { local?: { by: string }; remote?: { access: string } }>

/** What one local registration registers, on its own registry. */
function registered(register: (domains: DomainHandlerRegistry) => void): string[] {
  const domains = new DomainHandlerRegistry()
  register(domains)
  return [...domains.methods()]
}

const local = {
  chat: registered((domains) => registerPersonalBotMethods(domains, () => undefined)),
  devices: registered((domains) => registerBotDeviceMethods(domains, () => undefined)),
  browser: registered((domains) => registerBotBrowserMethods(domains, () => undefined))
}
const remote = remoteBotMethods({ bots: () => undefined }).map((method) => method.method)

describe('the bot method table', () => {
  it('has one row for every bot method registered here, under the registration the row names', () => {
    const all = [...local.chat, ...local.devices, ...local.browser]
    // One registry would refuse a second registration; across the three, no method is registered twice either.
    expect(new Set(all).size).toBe(all.length)
    for (const [by, methods] of Object.entries(local)) expect([...methods].sort(), by).toEqual([...localBotMethods(by as 'chat')].sort())
    for (const name of Object.keys(rows) as BotMethod[]) expect(all.includes(name) || remote.includes(name), name).toBe(true)
  })

  it('offers another device exactly its remote rows, once each, each with its access class', () => {
    expect(new Set(remote).size).toBe(remote.length)
    expect([...remote].sort()).toEqual([...REMOTE_BOT_METHOD_NAMES].sort())
    for (const name of REMOTE_BOT_METHOD_NAMES) {
      expect(ACCESS_CLASSES, name).toContain(rows[name].remote!.access)
      expect(METHOD_ACCESS[name], name).toBe(rows[name].remote!.access)
    }
    // No bot method has a class without being offered remotely.
    expect(Object.keys(METHOD_ACCESS).filter((name) => name in rows && !rows[name as BotMethod].remote)).toEqual([])
  })

  it('offers another device the same methods, with the same classes, as before the table', () => {
    expect(Object.fromEntries(REMOTE_BOT_METHOD_NAMES.map((name) => [name, rows[name].remote!.access]))).toEqual({
      'bots.get': 'bots_chat',
      'bots.chat.list': 'bots_chat',
      'bots.chat.attachment': 'bots_chat',
      'bots.memory.list': 'bots_chat',
      'bots.chat.send': 'bots_chat',
      'bots.chat.stop': 'bots_chat',
      'bots.work.stop': 'bots_chat',
      'bots.chat.markRead': 'bots_chat',
      'bots.questions.answer': 'bots_chat',
      'bots.reminders.snooze': 'bots_chat',
      'bots.actions.answer': 'bots_manage',
      'bots.asks.answer': 'bots_manage',
      'bots.personal.pause': 'bots_manage',
      'bots.personal.resume': 'bots_manage',
      'bots.create': 'bots_manage',
      'bots.update': 'bots_manage',
      'bots.reminders.cancel': 'bots_manage',
      'bots.schedules.remove': 'bots_manage',
      'bots.permissions.set': 'bots_manage',
      'bots.permissions.revoke': 'bots_manage',
      'bots.memory.forget': 'bots_manage',
      'bots.memory.edit': 'bots_manage'
    })
  })

  it('names its bot in every row that acts on one', () => {
    // Only listing bots, making one and New bot's choices name none.
    const unnamed = (Object.keys(rows) as BotMethod[]).filter((name) => {
      const row = BOT_METHODS[name] as { local?: { keys: readonly string[] }; remote?: { required: readonly string[] } }
      return !(row.local?.keys.includes('botId') ?? true) || !(row.remote?.required.includes('botId') ?? true)
    })
    expect(unnamed.sort()).toEqual(['bots.create', 'bots.model.choices', 'bots.personal.list'])
  })
})
