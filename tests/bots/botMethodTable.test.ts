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

const rows = BOT_METHODS as Record<BotMethod, { level: string; local?: { by: string }; remote?: object }>

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

  it('offers another device exactly its remote rows, once each, each with the access class of its level', () => {
    expect(new Set(remote).size).toBe(remote.length)
    expect([...remote].sort()).toEqual([...REMOTE_BOT_METHOD_NAMES].sort())
    for (const name of REMOTE_BOT_METHOD_NAMES) {
      expect(ACCESS_CLASSES, name).toContain(METHOD_ACCESS[name])
      expect(METHOD_ACCESS[name], name).toBe(rows[name].level === 'full' ? 'bots_full' : 'bots_use')
    }
    // No bot method has a class without being offered remotely, and a row only this computer serves offers nothing.
    expect(Object.keys(METHOD_ACCESS).filter((name) => name in rows && !rows[name as BotMethod].remote)).toEqual([])
    expect((Object.keys(rows) as BotMethod[]).filter((name) => rows[name].level === 'local' && rows[name].remote)).toEqual([])
  })

  it('lets a Use device chat, answer, stop and read, and keeps every other remote action for Full', () => {
    expect(Object.fromEntries(REMOTE_BOT_METHOD_NAMES.map((name) => [name, rows[name].level]))).toEqual({
      'bots.get': 'use',
      'bots.chat.list': 'use',
      'bots.chat.attachment': 'use',
      'bots.chat.file': 'use',
      'bots.stage': 'use',
      'bots.memory.list': 'use',
      'bots.chat.send': 'use',
      'bots.chat.stop': 'use',
      'bots.work.stop': 'use',
      'bots.chat.markRead': 'use',
      'bots.questions.answer': 'use',
      'bots.reminders.snooze': 'use',
      'bots.actions.answer': 'use',
      'bots.asks.answer': 'full',
      'bots.personal.pause': 'full',
      'bots.personal.resume': 'full',
      'bots.create': 'full',
      'bots.update': 'full',
      // Setting a bot up from another computer (About, Runs on, Devices, Delete): Full only.
      'bots.delete': 'full',
      'bots.model.get': 'full',
      'bots.model.choices': 'full',
      'bots.model.setSlots': 'full',
      'bots.model.setImage': 'full',
      'bots.devices.get': 'full',
      'bots.devices.set': 'full',
      'bots.reminders.cancel': 'full',
      'bots.schedules.remove': 'full',
      'bots.permissions.set': 'full',
      'bots.permissions.revoke': 'full',
      'bots.memory.forget': 'full',
      'bots.memory.edit': 'full'
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
