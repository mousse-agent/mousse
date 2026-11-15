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
  const wake = f.bots.addWake(botId, turn.id, { dueAt: new Date(f.clock.now + 600_000).toISOString(), brief: 'Check' })
  expect(f.store.reminder(wake.wakeId)?.ownerSet).toBe(false)
})
