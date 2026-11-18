import { afterEach, expect, it, vi } from 'vitest'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { getDefaultSettings } from '../../src/shared/settings'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

const HOUR = 60 * 60_000
let f: BotFixture
afterEach(() => f?.close())
async function held(on = true, options: { quietFor?: number; canWake?: boolean } = {}) {
  f = botFixture()
  const settings = getDefaultSettings()
  settings.experimental.botAsksFirstOff = !on
  f.host.settings = { get: () => settings, set: () => undefined } as never
  const descriptor = { configRevision: 'revision-1', toolName: 'send', providerName: 'mail_send', inputSchema: { type: 'object', properties: {} }, installationId: 'mail', serverId: 'mail', serverName: 'Mail' }
  const server = { installationId: 'mail', serverName: 'Mail', configDigest: 'config-1', failing: false, tools: [descriptor] }
  const calls = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'delivered' }] }))
  const mcp = new BotMcp({ enabled: () => true, catalog: { ensure: async () => undefined, listing: () => [{ ...descriptor, name: 'Mail__send' }], servers: () => [server] }, manager: { callTool: calls } })
  f.host.mcp = mcp
  await f.bots.reconcileOnStartup()
  const { botId } = await createBot(f, { reply: 'Hello' })
  if (options.quietFor) {
    const end = f.clock.now + options.quietFor
    f.host.quietHoursFor = (_botId, at) => at < end ? { end } as never : undefined
  }
  if (options.canWake) f.store.run('UPDATE bot_registry SET tell_json = ? WHERE bot_id = ?', JSON.stringify({ canWakeMe: true }), botId)
  const permission = await f.bots.activate({ botId, input: 'Allow mail', clientRequestId: 'permission' })
  const asking = await start(f, permission.id)
  asking.prepared.authority.escalate!({ permission: { mcp: { server: 'Mail' } } as never, reason: 'To send mail' })
  await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
  await finish(f, asking.payload)
  const grant = f.store.activeGrant(botId)!
  const manifest = { ...grant.manifest, mcp: [{ serverId: 'mail', tool: 'send', ...(on ? { level: 'asks_first' as const } : {}) }] }
  f.store.approve(botId, botManifestDigest(manifest), manifest)
  await f.bots.service.chatSend({ botId, text: 'Send the email', clientRequestId: 'owner' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const talk = await start(f, chat.id)
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Email', brief: 'Send email', key: 'email' })
  await finish(f, talk.payload)
  const work = await start(f, workId)
  f.bots.markRead(botId, f.bots.service.chatList(botId).messages.at(-1)!.seq)
  await callForBot({ bot: work.prepared.authority, mcp, name: 'Mail__send', args: { to: 'private@example.test', body: 'Private body' }, toolCallId: 'send-call', signal: new AbortController().signal })
  await finish(f, work.payload)
  const action = f.bots.actions.forWork(workId)
  const nudges = () => f.store.all("SELECT * FROM bot_messages WHERE id IN (?, ?) ORDER BY seq", `bm_${action?.id}_n1`, `bm_${action?.id}_n2`)
  return { botId, workId, action: action!, nudges, calls }
}
async function tellOriginal() { f.bots.setTellingWindows(1); await f.bots.deliverDueReminders() }

it('starts at the original told time, follows up twice through upkeep, and survives restart', async () => {
  const t = await held()
  f.clock.now += 3 * HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(0)
  await tellOriginal()
  const told = f.store.message(t.action.message_id)!.toldAt!
  expect(f.bots.nextDueAt(t.botId)).toBe(new Date(Date.parse(told) + HOUR).toISOString())
  f.clock.now += HOUR - 1
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(0)
  f.clock.now++
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  expect(t.nudges()[0]).toMatchObject({ id: `bm_${t.action.id}_n1`, reply_to: t.action.message_id })
  expect(f.store.all('SELECT * FROM bot_questions')).toEqual([])
  f.bots.close(); f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup(); f.bots.setTellingWindows(1)
  f.clock.now += 24 * HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(2)
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(2)
  expect(t.calls).not.toHaveBeenCalled()
})

// The same stored card is the only authority: acceptance, settlement, withdrawal and Forget all stop follow-up.
it.each(['approved', 'running', 'done', 'failed', 'uncertain', 'declined', 'expired', 'withdrawn', 'forgotten'] as const)('does not nudge %s cards', async status => {
  const t = await held()
  await tellOriginal()
  if (status === 'forgotten') f.bots.actions.forgetText(t.botId, t.action.id)
  else f.store.run('UPDATE bot_actions SET exec_args = NULL, status = ? WHERE id = ?', status, t.action.id)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(0)
})

it('adds no rows, source, state writes or immediate timer when the switch is off and no action exists', async () => {
  const t = await held(false)
  await tellOriginal()
  const state = f.store.all('SELECT * FROM bot_memory_state ORDER BY bot_id, key')
  f.clock.now += HOUR
  const timers = f.timers.length
  await f.bots.deliverDueReminders()
  expect(f.store.all('SELECT * FROM bot_actions')).toEqual([])
  expect(f.store.all('SELECT * FROM bot_memory_state ORDER BY bot_id, key')).toEqual(state)
  expect(f.bots.nextDueAt(t.botId)).toBeUndefined()
  expect(f.timers.slice(timers).some(timer => timer.ms === 0)).toBe(false)
})


it.each([false, true])('keeps nudges out of quiet hours even when original canWakeMe=%s', async canWake => {
  const t = await held(true, { quietFor: 3 * HOUR, canWake })
  const created = f.clock.now
  await tellOriginal()
  expect(f.store.message(t.action.message_id)!.toldAt).toBe(canWake ? f.store.now() : null)
  f.clock.now = created + HOUR
  f.host.ownerActive = () => true
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(0)
  expect(f.bots.nextDueAt(t.botId)).toBe(new Date(created + 3 * HOUR).toISOString())
  f.clock.now = created + 3 * HOUR
  await f.bots.deliverDueReminders()
  if (canWake) expect(t.nudges()).toHaveLength(1)
  else {
    expect(t.nudges()).toHaveLength(0)
    expect(f.bots.nextDueAt(t.botId)).toBe(new Date(created + 4 * HOUR).toISOString())
    f.clock.now += HOUR
    await f.bots.deliverDueReminders()
    expect(t.nudges()).toHaveLength(1)
  }
})

it('follows the question pause convention without a due-time spin or extra timer', async () => {
  const t = await held()
  await tellOriginal()
  await f.bots.service.pause(t.botId)
  // Parked work is busy even while the owner has paused schedules, as with a work question.
  expect(f.bots.isIdle(t.botId, { within: HOUR - 1 })).toBe(false)
  expect(f.bots.isIdle(t.botId, { within: HOUR })).toBe(false)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  expect(Date.parse(f.bots.nextDueAt(t.botId)!)).toBeGreaterThan(f.clock.now)
  const timers = f.timers.length
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  expect(f.timers.slice(timers).some(timer => timer.ms === 0)).toBe(false)
})

it('shares nudge spacing with questions in both directions', async () => {
  const t = await held()
  await tellOriginal()
  function ask(id: string, afterMs: number) {
    f.store.insertQuestion({ id, botId: t.botId, activationId: t.workId, dispatchN: 1, lane: 'run', spec: { question: 'Which?', choices: ['A', 'B'] }, createdAt: f.store.now(), follow: { kind: 'nudge', afterMs } })
    f.bots.chat.post({ botId: t.botId, author: 'bot', kind: 'notice', text: 'Which?', questionId: id })
  }
  ask('q-first', HOUR)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(f.store.question('q-first')!.nudges).toBe(1)
  expect(t.nudges()).toHaveLength(0)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  ask('q-second', HOUR / 2)
  f.clock.now += HOUR / 2
  await f.bots.deliverDueReminders()
  expect(f.store.question('q-second')!.nudges).toBe(0)
  expect(f.store.question('q-second')!.nextAt).toBe(new Date(f.clock.now + HOUR / 2).toISOString())
})

it('uses legacy telling receipts and never schedules a second nudge before the first is told', async () => {
  const t = await held()
  const cardBefore = t.action.card_json
  f.clock.now += 5 * 60_000
  f.bots.noteLegacyTelling({ botId: t.botId, message: f.bots.service.actionMessage(t.botId, t.action.id) })
  expect(f.bots.nextDueAt(t.botId)).toBe(new Date(f.clock.now + HOUR).toISOString())
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  expect(f.bots.nextDueAt(t.botId)).toBeUndefined()
  f.clock.now += 5 * 60_000
  const nudge = f.bots.chat.toMessage(f.store.message(`bm_${t.action.id}_n1`)!)
  f.bots.noteLegacyTelling({ botId: t.botId, message: nudge })
  expect(f.bots.nextDueAt(t.botId)).toBe(new Date(f.clock.now + 24 * HOUR).toISOString())
  expect(f.bots.actions.get(t.action.id)!.card_json).toBe(cardBefore)
})

it('republishes existing nudge rows when the card changes and suppresses an untold settled nudge', async () => {
  const t = await held()
  await tellOriginal()
  f.bots.markRead(t.botId, f.store.message(t.action.message_id)!.seq)
  f.bots.setTellingWindows(0)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  const messages: string[] = []
  const tells: any[] = []
  f.bots.events.on('message', event => messages.push(event.message.id))
  f.bots.events.on('tell', event => { if (event.rows.length) tells.push(event) })
  f.bots.actions.transition(t.action.id, 'open', 'declined')
  expect(messages).toContain(`bm_${t.action.id}_n1`)
  f.bots.setTellingWindows(1)
  await f.bots.deliverDueReminders()
  expect(tells).toHaveLength(0)
})

it('tells a nudge as an action name only, and backs off a failed write without spinning', async () => {
  const t = await held()
  await tellOriginal()
  const events: any[] = []
  f.bots.events.on('tell', event => events.push(event))
  f.clock.now += HOUR
  const post = vi.spyOn(f.bots.chat, 'post').mockImplementationOnce(() => { throw new Error('disk busy') })
  const timers = f.timers.length
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(0)
  expect(f.timers.slice(timers).at(-1)?.ms).toBe(60_000)
  post.mockRestore()
  f.clock.now += 60_000
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ body: 'Wants to send', kind: 'question' })
  expect(JSON.stringify(events)).not.toContain('private@example.test')
  expect(JSON.stringify(events)).not.toContain('Private body')
})

it('suppresses an untold settled nudge even after asks first is switched off', async () => {
  const t = await held()
  await tellOriginal()
  f.bots.markRead(t.botId, f.store.message(t.action.message_id)!.seq)
  f.bots.setTellingWindows(0)
  f.clock.now += HOUR
  await f.bots.deliverDueReminders()
  expect(t.nudges()).toHaveLength(1)
  f.host.settings!.get().experimental.botAsksFirstOff = true
  f.bots.actions.transition(t.action.id, 'open', 'declined')
  const events: any[] = []
  f.bots.events.on('tell', event => { if (event.rows.length) events.push(event) })
  f.bots.setTellingWindows(1)
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(0)
})

it('holds a failed nudge delivery if quiet hours start before its retry, even with canWakeMe', async () => {
  const t = await held(true, { canWake: true })
  await tellOriginal()
  f.bots.markRead(t.botId, f.store.message(t.action.message_id)!.seq)
  f.clock.now += HOUR
  const fail = () => { throw new Error('banner temporarily unavailable') }
  f.bots.events.on('tell', fail)
  await f.bots.deliverDueReminders()
  f.bots.events.off('tell', fail)
  expect(t.nudges()).toHaveLength(1)
  expect(f.store.message(`bm_${t.action.id}_n1`)!.toldAt).toBeNull()
  const end = f.clock.now + HOUR
  f.host.quietHoursFor = (_bot, at) => at < end ? { end } as never : undefined
  f.host.ownerActive = () => true
  f.clock.now += 60_000
  const tells: any[] = []
  f.bots.events.on('tell', event => tells.push(event))
  await f.bots.deliverDueReminders()
  expect(tells).toHaveLength(0)
  expect(f.bots.nextDueAt(t.botId)).toBe(new Date(end).toISOString())
  f.clock.now = end
  await f.bots.deliverDueReminders()
  expect(tells.at(-1)).toMatchObject({ body: 'Wants to send', kind: 'question' })
})

it('processes a due nudge when the wall clock advances after upkeep captured its time', async () => {
  const t = await held()
  await tellOriginal()
  const due = f.clock.now + HOUR
  f.clock.now = due + 5
  await f.bots.deliverDueReminders(new Date(due))
  expect(t.nudges()).toHaveLength(1)
  await f.bots.deliverDueReminders()
  expect(Date.parse(f.bots.nextDueAt(t.botId)!)).toBeGreaterThan(f.clock.now)
})
