import { afterEach, beforeEach, expect, it } from 'vitest'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { BotChatProjection } from '../../src/mms/bots/chat/projection'
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
  const reopened = new BotStore({ profileHome: f.profile, clock: () => f.clock.now })
  const projection = new BotChatProjection({ store: reopened, emit() {} })
  const restarted = new BotTellings(reopened, projection, () => 'Scout', e => events.push(e))
  restarted.attach(1); restarted.release(f.clock.now)
  expect(events).toHaveLength(1)
  expect(events[0].title).toContain('While Mousse was closed')
  expect(events[0].rows).toHaveLength(3)
  expect(f.store.message(old.id)?.toldAt).toBeTruthy()
  const again = new BotTellings(reopened, projection, () => 'Scout', e => events.push(e))
  again.attach(1); again.release(f.clock.now)
  expect(events).toHaveLength(1)
  reopened.close()
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
it('includes tellings in the shared due sources without spinning a closed-window timer', () => {
  const m = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Ready' })
  expect(f.bots.nextDueAt()).toBeUndefined()
  f.bots.setTellingWindows(1)
  expect(f.bots.nextDueAt(botId)).toBe(f.store.message(m.id)?.tellAt)
  expect(f.timers.at(-1)?.ms).toBe(0)
})
it('keeps later notices behind reports in a fold', async () => {
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  f.bots.chat.post({ id: 'bm_x_sched_dropped_day', botId, author: 'bot', kind: 'error', text: '', error: { text: 'Dropping scheduled runs' } })
  f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: 'New report' })
  await f.bots.deliverDueReminders()
  expect(events[0].body).toBe('New report')
  expect(events[0].rows.at(-1).tell).toBe('later')
})

it.each(['emit', 'write'] as const)('backs off a failed telling %s while other bots and reminders continue', async failure => {
  const { vi } = await import('vitest')
  const other = (await createBot(f)).botId
  f.bots.setTellingWindows(1)
  const bad = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Bad' })
  const good = f.bots.chat.post({ botId: other, author: 'bot', kind: 'text', text: 'Good' })
  const reminder = f.bots.addReminder(other, 'test', { dueAt: f.store.now(), text: 'Reminder' })
  const original = f.store.run.bind(f.store)
  const write = vi.spyOn(f.store, 'run').mockImplementation((sql, ...args) => {
    if (failure === 'write' && sql.startsWith('UPDATE bot_messages SET told_at') && args.includes(bad.id)) throw new Error('Disk full')
    return original(sql, ...args)
  })
  const listener = (event: any) => { if (failure === 'emit' && event.rows.some((r: any) => r.botId === botId)) throw new Error('Window failed') }
  f.bots.events.on('tell', listener)
  try {
    await expect(f.bots.deliverDueReminders()).resolves.toBeUndefined()
    expect(f.store.message(bad.id)?.toldAt).toBeNull()
    expect(f.store.message(good.id)?.toldAt).toBe(f.store.now())
    expect(f.store.reminder(reminder.reminderId)?.status).toBe('delivered')
    expect(f.bots.nextDueAt(botId)).toBe(new Date(f.clock.now + 60_000).toISOString())
    expect(f.timers.at(-1)?.ms).toBe(60_000)
    await f.bots.deliverDueReminders()
    expect(f.store.message(bad.id)?.toldAt).toBeNull()
  } finally { write.mockRestore(); f.bots.events.off('tell', listener) }
  f.clock.now += 60_000
  await f.bots.deliverDueReminders()
  expect(f.store.message(bad.id)?.toldAt).toBe(f.store.now())
})
it('leaves a partly read fold shown until every row is read', async () => {
  const other = (await createBot(f)).botId
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  const a = f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: 'A' })
  const b = f.bots.chat.post({ botId: other, author: 'bot', kind: 'run_report', text: 'B' })
  await f.bots.deliverDueReminders()
  const before = events.length
  f.bots.markRead(botId, a.seq)
  expect(events).toHaveLength(before)
  f.bots.markRead(other, b.seq)
  expect(events.at(-1)).toMatchObject({ rows: [], sound: false })
})
it('expires later rows with one indexed read and no per-message projection when only later rows wait', async () => {
  const { vi } = await import('vitest')
  f.bots.setTellingWindows(1)
  const later = f.bots.chat.post({ id: 'bm_test_offline', botId, author: 'bot', kind: 'notice', text: 'Offline' })
  f.clock.now += 86_400_001
  const projected = vi.spyOn(f.bots.chat, 'toMessage')
  const all = vi.spyOn(f.store, 'all')
  try {
    f.bots.tellings.release(f.clock.now)
    expect(f.store.message(later.id)?.toldAt).toBe(f.store.now())
    expect(projected).not.toHaveBeenCalled()
    expect(all).toHaveBeenCalledTimes(1)
    expect(all.mock.calls[0]![0]).toContain('bot_messages_tell_due')
  } finally { projected.mockRestore(); all.mockRestore() }
})
it('does not label a live reply as closed-window catch-up because later rows wait', async () => {
  f.bots.chat.post({ id: 'bm_later_offline', botId, author: 'bot', kind: 'notice', text: 'Offline' })
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Live' })
  await f.bots.deliverDueReminders()
  expect(events[0].title).not.toContain('While Mousse was closed')
  expect(events[0].sound).toBe(true)
})
it.each([
  ['- **Check the build**\nNot in the banner', 'Check the build'],
  ['x'.repeat(160), `${'x'.repeat(139)}…`]
])('keeps the existing banner wording for %s', async (text, body) => {
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text })
  await f.bots.deliverDueReminders()
  expect(events[0].body).toBe(body)
})
it.each([false, true])('keeps question answers and nudge wording (nudge=%s)', async nudge => {
  f.bots.setTellingWindows(1)
  const activation = f.store.listActivations(botId)[0]!
  f.store.insertQuestion({ id: 'banner-question', botId, activationId: activation.id, dispatchN: 1, lane: 'chat',
    spec: { question: 'Which flat?', choices: [{ label: 'Flat A' }, { label: 'Flat B' }], other: true }, createdAt: f.store.now() })
  const question = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Which flat?', questionId: 'banner-question' })
  if (nudge) {
    f.store.run('UPDATE bot_messages SET told_at = ? WHERE id = ?', f.store.now(), question.id)
    f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Still need your answer on this one.', questionId: 'banner-question', replyTo: question.id })
  }
  const events: any[] = []; f.bots.events.on('tell', e => events.push(e))
  await f.bots.deliverDueReminders()
  expect(events[0].body).toBe(`${nudge ? 'Still need your answer: ' : ''}Which flat? — Flat A / Flat B`)
})
it('keeps legacy-announced rows untold until a capable window consumes durable receipts', async () => {
  const m = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Already announced' })
  f.bots.noteLegacyTelling({ botId, message: m })
  await f.bots.deliverDueReminders()
  expect(f.store.message(m.id)?.toldAt).toBeNull()
  const { BotTellings } = await import('../../src/mms/bots/chat/BotTellings')
  const reopened = new BotStore({ profileHome: f.profile, clock: () => f.clock.now })
  try {
    const events: any[] = []
    const release = new BotTellings(reopened, new BotChatProjection({ store: reopened, emit() {} }), () => 'Scout', e => events.push(e))
    release.attach(1); release.release(f.clock.now)
    expect(events).toHaveLength(0)
    expect(reopened.message(m.id)?.toldAt).toBe(f.store.now())
  } finally { reopened.close() }
})
it('does not let a failed bot already in the fold hold back another bot', async () => {
  const other = (await createBot(f)).botId
  f.bots.setTellingWindows(1)
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Earlier' })
  await f.bots.deliverDueReminders()
  f.bots.events.on('tell', event => { if (event.rows.some((r: any) => r.botId === botId)) throw new Error('Bot failed') })
  f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Fails' })
  const good = f.bots.chat.post({ botId: other, author: 'bot', kind: 'text', text: 'Still delivered' })
  await f.bots.deliverDueReminders()
  expect(f.store.message(good.id)?.toldAt).toBe(f.store.now())
})

it('tells an owner-asked fixed schedule line now, alone in a fold and beyond both sound caps', async () => {
  f.bots.setTellingWindows(1)
  const events: any[] = []; f.bots.events.on('tell', event => events.push(event))
  const bots = [botId]
  for (let i = 0; i < 5; i++) bots.push((await createBot(f)).botId)
  for (const id of bots) {
    f.bots.chat.post({ botId: id, author: 'bot', kind: 'run_report', text: 'Report' })
    await f.bots.deliverDueReminders()
  }
  expect(events.filter(event => event.sound)).toHaveLength(6)
  const foldId = events.at(-1).id
  const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 1 }, say: 'Take a break' }, 'owner')
  expect(f.scheduler.getJob(schedule.jobId)!.bot).toMatchObject({ say: 'Take a break', ownerAsked: true })
  await f.tickSchedules(new Date(f.clock.now + 60_000))
  await f.bots.deliverDueReminders()
  const message = f.bots.service.chatList(botId).messages.find(row => row.text === 'Take a break')!
  expect(f.store.message(message.id)).toMatchObject({ tell: 'now', toldAt: f.store.now(), activationId: null })
  expect(events.at(-1)).toMatchObject({ sound: true, rows: [{ messageId: message.id, tell: 'now' }] })
  expect(events.at(-1).id).not.toBe(foldId)
})
it('does not infer a fixed line from a schedule-shaped id or its words', () => {
  const message = f.bots.chat.post({ id: `bm_sched:${botId}:test:occurrence`, botId, author: 'bot', kind: 'run_report', text: 'Take a break' })
  expect(f.store.message(message.id)?.tell).toBe('soon')
})
