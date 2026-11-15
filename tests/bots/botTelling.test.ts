import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, createBot, type BotFixture } from './botFixture'
let f: BotFixture
let botId: string
beforeEach(async () => { f = botFixture(); await f.bots.reconcileOnStartup(); ({ botId } = await createBot(f)) })
afterEach(() => f.close())
// Inputs: owner, reply, service line, unattended reply, report, failure, offline, dropped schedules.
it('keeps a class and due time in the post transaction', () => {
  for (const [patch, tell] of [
    [{ author: 'owner' }, null],
    [{}, 'soon'],
    [{ id: 'bm_permission_test', kind: 'notice' }, null],
    [{ id: 'bm_x_offline', kind: 'notice' }, 'later'],
    [{ id: 'bm_x_sched_dropped_today', kind: 'error' }, 'later'],
    [{ kind: 'error', error: { text: 'Failed' } }, 'soon'],
    [{ kind: 'run_report' }, 'soon']
  ] as const) {
    const message = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Update', ...patch })
    expect(f.store.message(message.id)).toMatchObject({ tell, tellAt: tell ? f.store.now() : null })
  }
})

it('releases due unread rows once and keeps read rows silent', async () => {
  const events: unknown[] = []
  f.bots.events.on('tell', e => events.push(e))
  f.bots.setTellingWindows(1)
  const m = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Hello\nprivate second line' })
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ body: 'Hello', sound: true, rows: [{ botId, messageId: m.id, tell: 'soon' }] })
  expect(f.store.message(m.id)?.toldAt).toBe(f.store.now())
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(1)
  const read = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Already read' })
  f.bots.markRead(botId, read.seq)
  events.length = 0
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(0)
  expect(f.store.message(read.id)?.toldAt).toBeTruthy()
})

it('folds five reports into one replaceable banner, caps sounds, and never holds now', async () => {
  const events: import('../../src/shared/bots/personal/telling').BotTelling[] = []
  f.bots.events.on('tell', e => events.push(e))
  f.bots.setTellingWindows(1)
  for (let n = 0; n < 5; n++) {
    f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: `Report ${n}` })
    await f.bots.deliverDueReminders()
    f.clock.now += 1000
  }
  expect(new Set(events.map(e => e.id)).size).toBe(1)
  expect(events.at(-1)?.rows).toHaveLength(5)
  expect(events.filter(e => e.sound)).toHaveLength(1)
  const now = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Reminder' })
  f.store.run("UPDATE bot_messages SET tell = 'now' WHERE id = ?", now.id)
  await f.bots.deliverDueReminders()
  expect(events.at(-1)).toMatchObject({ sound: true, rows: [{ messageId: now.id, tell: 'now' }] })
  expect(events.at(-1)?.id).not.toBe(events[0]?.id)
  f.clock.now += 121_000
  f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: 'More' })
  await f.bots.deliverDueReminders()
  expect(events.at(-1)?.sound).toBe(false)
})
it('later rows only join a subsequent fold', async () => {
  const events: any[] = []
  f.bots.events.on('tell', e => events.push(e)); f.bots.setTellingWindows(1)
  f.bots.chat.post({ id: 'bm_x_offline', botId, author: 'bot', kind: 'notice', text: 'Waiting for internet' })
  await f.bots.deliverDueReminders(); expect(events).toHaveLength(0)
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Done' })
  await f.bots.deliverDueReminders(); expect(events[0].rows).toHaveLength(2)
})

it('catches up once as one fold, drops rows older than a day, and survives a service restart', async () => {
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  const old = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Yesterday' })
  f.clock.now += 86_400_001
  for (let n = 0; n < 3; n++) f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: `Missed ${n}` })
  await f.bots.deliverDueReminders(); expect(events).toHaveLength(0)
  const { BotTellings } = await import('../../src/mms/bots/chat/BotTellings')
  const restarted = new BotTellings(f.store, f.bots.chat, () => 'Scout', e => events.push(e))
  restarted.attach(1); restarted.release(f.clock.now)
  expect(events).toHaveLength(1)
  expect(events[0].title).toContain('While Mousse was closed')
  expect(events[0].rows).toHaveLength(3)
  expect(f.store.message(old.id)?.toldAt).toBeTruthy()
  const again = new BotTellings(f.store, f.bots.chat, () => 'Scout', e => events.push(e))
  again.attach(1); again.release(f.clock.now)
  expect(events).toHaveLength(1)
})

it.each([true, false, null])('classifies reminder ownership %s without a migration', async owner => {
  const reminder = f.bots.addReminder(botId, 'test', { dueAt: new Date(f.clock.now + 1000).toISOString(), text: 'Take a break' })
  f.store.run('UPDATE bot_reminders SET owner_set = ? WHERE id = ?', owner === null ? null : Number(owner), reminder.reminderId)
  f.clock.now += 1000; await f.bots.deliverDueReminders()
  expect(f.store.message(`bm_${reminder.reminderId}`)?.tell).toBe(owner === false ? 'soon' : 'now')
})
it('limits profile sounds to six an hour without limiting banners', async () => {
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  for (let n = 0; n < 7; n++) {
    const other = (await createBot(f, { name: `Bot ${n}` })).botId
    f.bots.chat.post({ botId: other, author: 'bot', kind: 'run_report', text: 'Report' })
    await f.bots.deliverDueReminders()
    f.clock.now += 121_000
  }
  expect(events).toHaveLength(7)
  expect(events.filter(e => e.sound)).toHaveLength(6)
})
it('withdraws a banner when any window reads and keeps the next update free of read rows', async () => {
  f.bots.setTellingWindows(2)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  const read = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Done' })
  await f.bots.deliverDueReminders()
  f.bots.markRead(botId, read.seq)
  expect(events.at(-1)).toMatchObject({ id: events[0].id, rows: [], sound: false })
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Another' })
  await f.bots.deliverDueReminders()
  expect(events.at(-1).rows).toHaveLength(1)
})
