/**
 * Bot Phase 1 §5.11: the Bot UI's methods (`bots.personal.v2`), driven through the domain registry
 * over a real engine. Every method validates exact keys and values; together they take a bot from
 * creation through its chat, an ask, About and its menu to deletion; and no result or event ever
 * carries a model or an instance id.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import type { BotChatMessage, BotDetail, BotSummary } from '../../src/shared/bots/personal/chat'
import { BOTS_PERSONAL_V2_METHODS } from '../../src/shared/bots/personal/methods'
import { botFixture, flush, runDispatch, start, finish, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
const LOOK = { colour: 'teal', accessory: 'cap' }

let f: BotFixture
let domains: DomainHandlerRegistry
let seen: unknown[]

const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  domains.dispatch(context, method, params).then((result) => {
    seen.push(result)
    return result as T
  })

beforeEach(() => {
  f = botFixture()
  domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  seen = []
  for (const event of ['message', 'changed', 'activity']) f.bots.events.on(event, (payload: unknown) => seen.push({ event, payload }))
})

afterEach(() => f.close())

/** No payload names a model or an instance (§5.11). */
function expectNoModel(values: unknown[]): void {
  const text = JSON.stringify(values)
  expect(text).not.toContain('some/model')
  expect(text).not.toContain('pi:openrouter')
  expect(text).not.toContain('instanceId')
}

async function created(): Promise<string> {
  const { bot } = await call<{ bot: BotSummary }>('bots.create', { look: LOOK, description: 'Read my invoices and sum them up.', clientRequestId: 'c1' })
  const [first] = f.store.laneActivations(bot.id, 'chat', ['running'])
  await runDispatch(f, first!.id, 1, { text: 'Hello, I sum up invoices.' })
  return bot.id
}

describe('validation', () => {
  it('registers exactly the v2 methods', () => {
    for (const method of BOTS_PERSONAL_V2_METHODS) expect(domains.has(method)).toBe(true)
  })

  it('refuses unknown keys and bad values', async () => {
    const botId = await created()
    const bad: Array<[string, Record<string, unknown>]> = [
      ['bots.personal.list', { extra: 1 }],
      ['bots.create', { look: LOOK, description: 'x', clientRequestId: 'c2', face: 'cat' }],
      ['bots.create', { look: { colour: 'teal' }, description: 'x', clientRequestId: 'c2' }],
      ['bots.create', { look: LOOK, description: '   ', clientRequestId: 'c2' }],
      ['bots.create', { look: LOOK, description: 'x'.repeat(501), clientRequestId: 'c2' }],
      ['bots.create', { look: LOOK, name: 'n'.repeat(61), description: 'x', clientRequestId: 'c2' }],
      ['bots.create', { look: LOOK, description: 'x', clientRequestId: 'has spaces' }],
      ['bots.get', { botId: 'Not An Id' }],
      ['bots.get', {}],
      ['bots.update', { botId }],
      ['bots.update', { botId, look: { colour: 'teal', accessory: 'cap', glow: true } }],
      ['bots.chat.list', { botId, limit: 101 }],
      ['bots.chat.list', { botId, beforeSeq: 0 }],
      ['bots.chat.send', { botId, text: '  ', clientRequestId: 'm1' }],
      ['bots.chat.send', { botId, text: 'hi', clientRequestId: 'm1', attachments: [{ name: 'a.pdf', path: 'relative/a.pdf' }] }],
      ['bots.chat.send', { botId, text: 'hi', clientRequestId: 'm1', attachments: [{ name: 'a.pdf' }] }],
      ['bots.chat.markRead', { botId, seq: -1 }],
      ['bots.asks.answer', { botId, askId: 'esc_00000000-0000-4000-8000-000000000000', answer: 'allow_bot' }],
      ['bots.asks.answer', { botId, askId: 'nope', answer: 'allow' }],
      ['bots.permissions.revoke', { botId, permissionId: '' }],
      ['bots.schedules.remove', { botId, scheduleId: 'Bad Id' }],
      ['bots.memory.list', { botId, history: 'yes' }],
      ['bots.memory.forget', { botId }],
      ['bots.memory.export', { botId, dir: 'relative/dir' }]
    ]
    for (const [method, params] of bad) await expect(domains.dispatch(context, method, params), `${method} ${JSON.stringify(params)}`).rejects.toMatchObject({ code: expect.stringMatching(/^(invalid_params|unknown_field)$/) })
  })

  it('keeps the engine\'s error codes', async () => {
    await expect(call('bots.get', { botId: 'no-such-bot' })).rejects.toMatchObject({ code: 'bot_not_found' })
    const botId = await created()
    await expect(call('bots.asks.answer', { botId, askId: 'esc_00000000-0000-4000-8000-000000000000', answer: 'allow' })).rejects.toMatchObject({ code: 'ask_not_found' })
    await expect(call('bots.schedules.remove', { botId, scheduleId: 'none' })).rejects.toMatchObject({ code: 'schedule_not_found' })
    await expect(call('bots.permissions.revoke', { botId, permissionId: '{"tool":"edit"}' })).rejects.toMatchObject({ code: 'permission_not_found' })
  })
})

describe('a bot through the v2 methods', () => {
  it('create, chat, an ask, About, the menu and delete; no payload names a model', async () => {
    const botId = await created()
    expect((await call<{ bots: BotSummary[] }>('bots.personal.list')).bots).toMatchObject([{ id: botId, name: 'Inbox Helper', state: 'idle', unread: 1 }])
    expect(await call<{ bot: BotSummary }>('bots.update', { botId, name: 'Invoice Sum', look: { colour: 'pink', accessory: 'crown' } })).toMatchObject({ bot: { name: 'Invoice Sum', look: { colour: 'pink', accessory: 'crown' } } })

    // The owner asks; the chat turn asks for a folder with `escalate`, and the card lands on its reply.
    const invoices = join(f.base, 'Invoices')
    mkdirSync(invoices)
    const sent = await call<{ message: BotChatMessage }>('bots.chat.send', { botId, text: 'Sum up my invoices', clientRequestId: 'm1', attachments: [{ name: 'list.txt', path: join(f.base, 'list.txt') }] })
    expect(sent.message).toMatchObject({ author: 'owner', kind: 'text', text: 'Sum up my invoices', attachments: [{ name: 'list.txt' }] })
    // A repeat of the request returns the same row.
    expect((await call<{ message: BotChatMessage }>('bots.chat.send', { botId, text: 'Sum up my invoices', clientRequestId: 'm1' })).message.seq).toBe(sent.message.seq)
    const [chat] = f.store.laneActivations(botId, 'chat', ['running'])
    const { payload, prepared } = await start(f, chat!.id)
    expect(prepared.authority.escalate!({ permission: { path: invoices, access: 'read' }, reason: 'To read them.' })).toContain('Asked')
    await finish(f, payload, 'completed', { text: 'I need to read that folder.' })
    const listed = await call<{ messages: BotChatMessage[] }>('bots.chat.list', { botId, limit: 2 })
    expect(listed.messages).toHaveLength(2)
    const reply = listed.messages.at(-1)!
    expect(reply).toMatchObject({ author: 'bot', text: 'I need to read that folder.', ask: { status: 'open', kind: 'permission', title: expect.stringContaining('read files in') } })
    expect((await call<{ bots: BotSummary[] }>('bots.personal.list')).bots[0]).toMatchObject({ state: 'needs_you', stateText: expect.stringContaining('Wants to read files in') })
    const older = await call<{ messages: BotChatMessage[] }>('bots.chat.list', { botId, beforeSeq: listed.messages[0]!.seq })
    expect(older.messages.map((message) => message.text)).toEqual(['Hello, I sum up invoices.'])

    const answered = await call<{ message: BotChatMessage }>('bots.asks.answer', { botId, askId: reply.ask!.askId, answer: 'allow' })
    expect(answered.message.ask).toMatchObject({ status: 'allowed' })
    // The wall continues: the next dispatch says what the owner allowed.
    expect(f.store.dispatch(chat!.id, 2)?.prompt.text).toContain('The owner allowed: read files in')
    await runDispatch(f, chat!.id, 2, { text: 'Total: 120 EUR.' })
    expect(await call('bots.chat.markRead', { botId, seq: 1_000 })).toEqual({})
    expect((await call<{ bots: BotSummary[] }>('bots.personal.list')).bots[0]).toMatchObject({ state: 'idle', unread: 0 })

    // About: the folder is listed and can be removed; so can a schedule.
    let detail = await call<BotDetail>('bots.get', { botId })
    expect(detail.permissions).toMatchObject([{ title: expect.stringContaining('read files in'), note: expect.any(String) }])
    f.bots.addSchedule(botId, { when: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'Sum up new invoices.' }, 'bot')
    await f.bots.tickSchedules(new Date(f.clock.now))
    detail = await call<BotDetail>('bots.get', { botId })
    expect(detail.runs).toMatchObject([{ label: 'every weekday · 09:00', kind: 'schedule' }])
    expect((await call<BotDetail>('bots.permissions.revoke', { botId, permissionId: detail.permissions[0]!.id })).permissions).toEqual([])
    expect((await call<BotDetail>('bots.schedules.remove', { botId, scheduleId: detail.runs[0]!.id })).runs).toEqual([])

    expect(await call('bots.personal.pause', { botId })).toMatchObject({ bot: { state: 'paused', stateText: 'Paused' } })
    expect(await call('bots.personal.resume', { botId })).toMatchObject({ bot: { state: 'idle' } })
    expect(await call('bots.chat.stop', { botId })).toEqual({})

    // Memory goes to the memory admin.
    expect(await call('bots.memory.list', { botId, history: true })).toEqual({ entries: [], gauge: 'core 0/2,000' })
    expect(await call('bots.memory.forget', { botId, id: 'm1' })).toEqual({ redacted: [] })
    expect(await call('bots.memory.export', { botId, dir: join(f.base, 'export') })).toEqual({ files: [] })

    const deleted = await call<{ purgeAt: string }>('bots.delete', { botId })
    expect(Date.parse(deleted.purgeAt)).toBe(f.clock.now + 30 * 24 * 60 * 60_000)
    expect((await call<{ bots: BotSummary[] }>('bots.personal.list')).bots).toEqual([])
    await expect(call('bots.get', { botId })).rejects.toMatchObject({ code: 'bot_not_found' })
    await flush()
    // The check below covers the events too: chat rows and changes were emitted.
    expect(seen.some((entry) => (entry as { event?: string }).event === 'message')).toBe(true)
    expect(seen.some((entry) => (entry as { event?: string }).event === 'changed')).toBe(true)
    expectNoModel(seen)
  })

  it('a sign-in error carries the entry to sign in to, and only that', async () => {
    f.problem = { problem: 'no_provider', instanceId: 'claude:bots' }
    const { bot } = await call<{ bot: BotSummary }>('bots.create', { look: LOOK, name: 'Penny', description: 'Track my spending.', clientRequestId: 'c1' })
    await flush()
    const summary = (await call<{ bots: BotSummary[] }>('bots.personal.list')).bots[0]!
    expect(summary).toMatchObject({ id: bot.id, state: 'stuck', error: { action: { kind: 'sign_in', instanceId: 'claude:bots' } } })
    const messages = (await call<{ messages: BotChatMessage[] }>('bots.chat.list', { botId: bot.id })).messages
    expect(messages).toMatchObject([{ kind: 'error', error: { action: { kind: 'sign_in', instanceId: 'claude:bots' } } }])
    // Remove the one allowed id: nothing else names a model or an instance.
    const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll('"instanceId":"claude:bots"', '"signIn":true'))
    expectNoModel(seen.map(scrub))
  })
})

describe('Bot UI wiring', () => {
  it('every v2 method is allowed through the GUI bridge and required of the daemon', async () => {
    const { PLATFORM_REQUEST_METHODS } = await import('../../src/main/ipc/registerGuiIpc')
    const { GUI_REQUIRED_METHODS } = await import('../../src/main/mms/guiDaemonCompatibility')
    for (const method of BOTS_PERSONAL_V2_METHODS) {
      expect(PLATFORM_REQUEST_METHODS.has(method)).toBe(true)
      expect(GUI_REQUIRED_METHODS).toContain(method)
    }
  })

  it('bridges bots.changed, bots.message and bots.activity to the renderer; bots.escalation is retired', async () => {
    const { bridgeProtocolEvent } = await import('../../src/main/mms/protocolEventBridge')
    const broadcast = (..._args: unknown[]) => { calls.push(_args) }
    const calls: unknown[][] = []
    const presentation = { getActiveThreadId: () => null } as never
    const message = { botId: 'bot-1', message: { seq: 1, id: 'bm_1', at: '2026-11-07T09:00:00.000Z', author: 'bot', kind: 'text', text: 'hi', chips: [] } }
    const activity = { botId: 'bot-1', activationId: 'act_1', chip: { icon: 'search', text: 'searching the web', live: true } }
    expect(bridgeProtocolEvent({ type: 'bots.changed', data: { botId: 'bot-1' } } as never, broadcast as never, presentation)).toBe(true)
    expect(bridgeProtocolEvent({ type: 'bots.message', data: message } as never, broadcast as never, presentation)).toBe(true)
    expect(bridgeProtocolEvent({ type: 'bots.activity', data: activity } as never, broadcast as never, presentation)).toBe(true)
    expect(calls).toEqual([['bots:changed', { botId: 'bot-1' }], ['bots:message', message], ['bots:activity', activity]])
    expect(bridgeProtocolEvent({ type: 'bots.escalation', data: {} } as never, broadcast as never, presentation)).toBe(false)
  })
})
