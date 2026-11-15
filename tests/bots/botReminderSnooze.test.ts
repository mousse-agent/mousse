import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { reply: 'Hello.' })).botId
})
afterEach(() => f.close())

// Owner message, coalesced message, tap, first message, wake, default, other bot, unknown.
it.each([
  ['chat:m1', true], ['chat:after:m1', true], ['answer:q1', true],
  ['create:b1', false], ['wake:r1', false], ['question:q1:default', false],
  ['bot-message:b2', false], ['future:start', false]
])('stores who set text and work reminders in %s', async (key, ownerSet) => {
  await f.bots.service.chatSend({ botId, text: 'Remind me', clientRequestId: 'm1' })
  const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  f.store.run('UPDATE bot_activations SET idempotency_key = ? WHERE id = ?', key, turn.id)
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
  expect(bubble.reminder).toEqual({})
  const count = f.store.listActivations(botId).length
  const expected = new Date(f.clock.now)
  if (choice === 'tomorrow') { expected.setDate(expected.getDate() + 1); expected.setHours(9, 0, 0, 0) }
  else expected.setTime(expected.getTime() + (choice === '10m' ? 10 : 60) * 60_000)
  const updated = f.bots.service.reminderSnooze(botId, bubble.id, choice)
  const rows = f.store.waitingReminders(botId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ text: 'Tea', replyTo: message.id, snoozedFrom: r.reminderId, ownerSet: true, dueAt: expected.toISOString() })
  expect(updated.reminder?.snoozedUntil).toBe(expected.toISOString())
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, choice)).toThrow('already snoozed')
  expect(f.store.listActivations(botId)).toHaveLength(count)
  f.clock.now = expected.getTime()
  await f.bots.deliverDueReminders()
  expect(chatOf(f, botId).find(m => m.id === `bm_${rows[0]!.id}`)?.reminder).toEqual({})
})

it('refuses the cap and leaves the original available', async () => {
  const { bubble } = await said()
  for (let i = 0; i < 50; i++) f.store.insertReminder({ id: `r${i}`, botId, dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Tea', work: null, replyTo: null, createdAt: f.store.now() })
  expect(() => f.bots.service.reminderSnooze(botId, bubble.id, '10m')).toThrow('Cancel one first')
  expect(chatOf(f, botId).find(m => m.id === bubble.id)?.reminder).toEqual({})
})

it('Forget cancels a snoozed copy of the forgotten request', async () => {
  const { bubble, message } = await said()
  f.bots.service.reminderSnooze(botId, bubble.id, '10m')
  await f.bots.service.memoryForget(botId, message.id)
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
