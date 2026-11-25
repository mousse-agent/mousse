import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botFixture, chatOf, createBot, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { reply: 'Hello.' })).botId
})
afterEach(() => { f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

// Owner message, coalesced message, tap, first message, wake, default, other bot, unknown.
it.each([
  ['chat:m1', true], ['chat:after:m1', true], ['answer:q1', true],
  ['create:b1', false], ['wake:r1', false], ['question:q1:default', false],
  ['botmsg:b2', false], ['future:start', false]
])('stores who set text and work reminders in %s', async (key, ownerSet) => {
  await f.bots.service.chatSend({ botId, text: 'Remind me', clientRequestId: 'm1' })
  const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  f.store.run('UPDATE bot_activations SET idempotency_key = ?, provenance = NULL WHERE id = ?', key, turn.id)
  for (const work of [undefined, { title: 'Check', brief: 'Check it' }]) {
    const r = f.bots.addReminder(botId, turn.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Tea', work })
    expect(f.store.reminder(r.reminderId)?.ownerSet).toBe(ownerSet)
  }
  const job = f.bots.tools.schedules.add(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check' }, turn.id)
  expect(f.scheduler.listJobs().find(j => j.bot?.scheduleId === job.scheduleId)?.bot?.ownerAsked === true).toBe(ownerSet)
})

it('leaves legacy inserts unknown and stores wakes as the bot’s own', async () => {
  f.store.insertReminder({ id: 'legacy', botId, dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Old', work: null, replyTo: null, createdAt: f.store.now() })
  expect(f.store.reminder('legacy')?.ownerSet).toBeNull()
  await f.bots.service.chatSend({ botId, text: 'Later', clientRequestId: 'm1' })
  const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const wake = await f.bots.addWake(botId, turn.id, { dueAt: new Date(f.clock.now + 600_000).toISOString(), brief: 'Check' })
  expect(f.store.reminder(wake.wakeId)?.ownerSet).toBe(false)
})

async function said(work = false) {
  const { message } = await f.bots.service.chatSend({ botId, text: 'Tea later', clientRequestId: 'm1' })
  const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const r = f.bots.addReminder(botId, turn.id, { dueAt: new Date(f.clock.now).toISOString(), text: 'Tea', ...(work ? { work: { title: 'Tea', brief: 'Make tea' } } : {}) })
  await f.bots.deliverDueReminders()
  return { r, message, bubble: chatOf(f, botId).find(m => m.id === `bm_${r.reminderId}`)! }
}

it.each(['10m', '1h', 'tomorrow'] as const)('snoozes %s once without a turn, then says it with buttons again', async choice => {
  const { r, message, bubble } = await said()
  expect(bubble.reminder).toMatchObject({ expiresAt: expect.any(String) })
  const count = f.store.listActivations(botId).length
  const expected = new Date(f.clock.now)
  if (choice === 'tomorrow') { expected.setDate(expected.getDate() + 1); expected.setHours(9, 0, 0, 0) }
  else expected.setTime(expected.getTime() + (choice === '10m' ? 10 : 60) * 60_000)
  const updated = f.bots.service.reminderSnooze(botId, bubble.id, choice)
  const rows = f.store.waitingReminders(botId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ text: 'Tea', replyTo: message.id, snoozedFrom: r.reminderId, ownerSet: true, dueAt: expected.toISOString() })
  expect(updated.reminder?.snoozedUntil).toBe(expected.toISOString())
  expect(f.bots.tools.reminders.list(botId)).toContainEqual(expect.objectContaining({ reminderId: rows[0]!.id, ownerSet: true }))
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, choice)).toThrow('already snoozed')
  expect(f.store.listActivations(botId)).toHaveLength(count)
  f.clock.now = expected.getTime()
  await f.bots.deliverDueReminders()
  expect(chatOf(f, botId).find(m => m.id === `bm_${rows[0]!.id}`)?.reminder).toMatchObject({ expiresAt: expect.any(String) })
})

it('has no cap: snoozes with 50 reminders already waiting', async () => {
  const { bubble } = await said()
  for (let i = 0; i < 50; i++) f.store.insertReminder({ id: `r${i}`, botId, dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Tea', work: null, replyTo: null, createdAt: f.store.now() })
  f.bots.service.reminderSnooze(botId, bubble.id, '10m')
  expect(f.store.waitingReminders(botId)).toHaveLength(51)
})

it('Forget cancels a snoozed copy of the forgotten request', async () => {
  const { bubble, message } = await said()
  f.bots.service.reminderSnooze(botId, bubble.id, '10m')
  const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${message.id}`, who: 'owner', text: message.text }))
  const journal = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!
  expect(memory.forget(botId, { refs: [`j${journal.seq as number}`], by: 'owner_ui' })).not.toHaveProperty('error')
  expect(f.store.waitingReminders(botId)).toEqual([])
})

it('refuses an ordinary bubble, work reminder, wrong bot and invalid choice', async () => {
  const { bubble } = await said()
  expect(() => f.bots.service.reminderSnooze(botId, 'missing', '10m')).toThrow()
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, 'bad' as '10m')).toThrow()
  expect(() => f.bots.service.reminderSnooze('another', bubble.id, '10m')).toThrow()
  const row = f.store.reminder(bubble.id.slice(3))!
  f.store.run('UPDATE bot_reminders SET work_title = ?, work_brief = ? WHERE id = ?', 'Work', 'Do work', row.id)
  expect(chatOf(f, botId).find(m => m.id === bubble.id)?.reminder).toBeUndefined()
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, '10m')).toThrow()
})


it('a snoozed reminder can be cancelled through the usual list', async () => {
  const { bubble } = await said()
  f.bots.service.reminderSnooze(botId, bubble.id, '10m')
  const reminder = f.bots.service.get(botId).reminders![0]!
  expect(f.bots.service.reminderCancel(botId, reminder.id).reminders).toEqual([])
  expect(f.store.reminder(reminder.id)?.status).toBe('cancelled')
})


it('reads reminder state only for said reminder rows and scopes copies to their bot', async () => {
  const { bubble, r } = await said()
  const lookup = vi.spyOn(f.store, 'reminderForMessage')
  const copies = vi.spyOn(f.store, 'snoozedCopy')
  const ordinary = f.store.messages(botId, { limit: 50 }).filter(m => !m.id.startsWith('bm_rem_'))
  for (const row of ordinary) f.bots.chat.toMessage(row)
  expect(lookup).not.toHaveBeenCalled()
  expect(copies).not.toHaveBeenCalled()
  f.store.insertReminder({ id: 'another-bots-copy', botId: 'another', dueAt: f.store.now(), text: 'Other', work: null, replyTo: null, createdAt: f.store.now(), snoozedFrom: r.reminderId })
  expect(f.bots.chat.toMessage(f.store.message(bubble.id)!).reminder).not.toHaveProperty('snoozedUntil')
})

it('cancelling a snoozed copy returns replies and allows another snooze', async () => {
  const { bubble } = await said()
  f.bots.service.reminderSnooze(botId, bubble.id, '10m')
  const copy = f.store.waitingReminders(botId)[0]!
  const messages: unknown[] = []
  f.bots.events.on('message', e => messages.push(e))
  f.bots.service.reminderCancel(botId, copy.id)
  expect(chatOf(f, botId).find(m => m.id === bubble.id)?.reminder).not.toHaveProperty('snoozedUntil')
  expect(messages).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ id: bubble.id, reminder: expect.not.objectContaining({ snoozedUntil: expect.anything() }) }) }))
  f.bots.service.reminderSnooze(botId, bubble.id, '1h')
  expect(f.store.waitingReminders(botId)).toHaveLength(1)
})

it('offers snooze for 24 hours from delivery and refuses an expired stale tap', async () => {
  const { bubble } = await said()
  f.clock.now += 24 * 60 * 60_000 - 1
  expect(chatOf(f, botId).find(m => m.id === bubble.id)?.reminder).toBeDefined()
  f.clock.now += 1
  expect(chatOf(f, botId).find(m => m.id === bubble.id)?.reminder).toBeUndefined()
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, '10m')).toThrow('This reminder is too old to snooze.')
  expect(f.store.waitingReminders(botId)).toEqual([])
})

// America/New_York: midnight boundaries, spring clock change, autumn repeated hour.
it.each([
  ['2026-11-07T23:55:00-05:00', '2026-11-08T05:05:00.000Z', '2026-11-08T05:55:00.000Z', '2026-11-08T14:00:00.000Z'],
  ['2026-11-07T00:05:00-05:00', '2026-11-07T05:15:00.000Z', '2026-11-07T06:05:00.000Z', '2026-11-08T14:00:00.000Z'],
  ['2026-03-08T01:55:00-05:00', '2026-03-08T07:05:00.000Z', '2026-03-08T07:55:00.000Z', '2026-03-09T13:00:00.000Z'],
  ['2026-11-01T01:55:00-04:00', '2026-11-01T06:05:00.000Z', '2026-11-01T06:55:00.000Z', '2026-11-02T14:00:00.000Z']
])('uses local calendar time and real durations at %s', async (now, ten, hour, tomorrow) => {
  vi.stubEnv('TZ', 'America/New_York')
  f.clock.now = Date.parse(now)
  const { bubble } = await said()
  for (const [choice, expected] of [['10m', ten], ['1h', hour], ['tomorrow', tomorrow]] as const) {
    const updated = f.bots.service.reminderSnooze(botId, bubble.id, choice)
    expect(updated.reminder?.snoozedUntil).toBe(expected)
    const copy = f.store.waitingReminders(botId)[0]!
    f.bots.service.reminderCancel(botId, copy.id)
  }
})
