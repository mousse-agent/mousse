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
  settings.experimental.botAsksFirst = on
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
