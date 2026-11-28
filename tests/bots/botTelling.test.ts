import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { BotChatProjection } from '../../src/mms/bots/chat/projection'
import { botFixture, createBot, type BotFixture } from './botFixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotMarksStore } from '../../src/mms/bots/marks/BotMarksStore'
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

it('keeps a bot muted or hidden on this computer quiet, drops it from a fold, and tells only its new rows once unmuted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-marks-'))
  try {
    const marks = new BotMarksStore(dir)
    f.bots.tellings.setQuiet(id => { const m = marks.get(id); return m.muted === true || m.hidden === true })
    const loud = (await createBot(f)).botId
    const hidden = (await createBot(f)).botId
    const events: import('../../src/shared/bots/personal/telling').BotTelling[] = []
    f.bots.events.on('tell', e => events.push(e))
    f.bots.setTellingWindows(1)
    const folded = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Folded before the mute' })
    await f.bots.deliverDueReminders()
    marks.set(botId, 'muted', true)
    marks.set(hidden, 'hidden', true)
    const quiet = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Muted now' })
    f.store.run("UPDATE bot_messages SET tell = 'now' WHERE id = ?", quiet.id)
    const unseen = f.bots.chat.post({ botId: hidden, author: 'bot', kind: 'text', text: 'Hidden' })
    const heard = f.bots.chat.post({ botId: loud, author: 'bot', kind: 'text', text: 'Heard' })
    await f.bots.deliverDueReminders()
    // The fold goes on without the muted bot's row; the muted and hidden rows are done with, told to nobody.
    expect(events.at(-1)?.rows.map(r => r.messageId)).toEqual([heard.id])
    expect(events.flatMap(e => e.rows.map(r => r.messageId))).not.toContain(quiet.id)
    expect([quiet, unseen].map(m => f.store.message(m.id)?.toldAt)).toEqual([f.store.now(), f.store.now()])
    expect(f.store.message(folded.id)?.toldAt).toBeTruthy()

    marks.set(botId, 'muted', false)
    f.clock.now += 200_000
    const next = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Unmuted' })
    await f.bots.deliverDueReminders()
    expect(events.at(-1)?.rows.map(r => r.messageId)).toEqual([next.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

it.each([
  [false, 1, 0, 'Scout'],
  [false, 2, 0, 'Scout · 2 messages'],
  [false, 1, 1, 'Scout, Ledger · 2 messages'],
  [true, 1, 0, 'Scout'],
  [true, 2, 0, 'While Mousse was closed: Scout 2 messages'],
  [true, 1, 1, 'While Mousse was closed: Scout 1 message · Ledger 1 message'],
  [true, 2, 1, 'While Mousse was closed: Scout 2 messages · Ledger 1 message']
] as const)('uses ordinary or counted banner grammar (closed=%s, Scout=%i, Ledger=%i)', async (closed, scoutCount, ledgerCount, title) => {
  const scout = (await createBot(f, { name: 'Scout' })).botId
  const ledger = (await createBot(f, { name: 'Ledger' })).botId
  const events: any[] = []; f.bots.events.on('tell', event => events.push(event))
  if (!closed) f.bots.setTellingWindows(1)
  for (const [id, count] of [[scout, scoutCount], [ledger, ledgerCount]] as const)
    for (let n = 0; n < count; n++) f.bots.chat.post({ botId: id, author: 'bot', kind: 'run_report', text: 'An ordinary report' })
  if (closed) f.bots.setTellingWindows(1)
  await f.bots.deliverDueReminders()
  expect(events.at(-1)).toMatchObject({ title, body: 'An ordinary report' })
})

it('expires legacy receipts in the same release as later rows without needing a capable window', () => {
  const old = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Old legacy announcement' })
  f.bots.noteLegacyTelling({ botId, message: old })
  const later = f.bots.chat.post({ id: 'bm_expiring_offline', botId, author: 'bot', kind: 'notice', text: 'Waiting' })
  f.store.run("INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, 'cursor:kept-thread', 'true')", botId)
  f.clock.now += 86_400_000 - 1
  const recent = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Recent legacy announcement' })
  f.bots.noteLegacyTelling({ botId, message: recent })
  const receipt = (id: string) => f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `cursor:telling-legacy:${id}`)
  f.bots.tellings.release(f.clock.now)
  expect(receipt(old.id)).toBeDefined()
  f.clock.now++
  f.bots.tellings.release(f.clock.now)
  expect(receipt(old.id)).toBeUndefined()
  expect(receipt(recent.id)).toBeDefined()
  expect(f.store.message(later.id)?.toldAt).toBe(f.store.now())
  expect(f.store.get("SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = 'cursor:kept-thread'", botId)).toBeDefined()
})
it.each(['clear', 'reset'] as const)('%s drops only that bot’s legacy receipts along with its messages', async action => {
  const other = (await createBot(f)).botId
  for (const id of [botId, other]) {
    const message = f.bots.chat.post({ botId: id, author: 'bot', kind: 'text', text: 'Legacy announcement' })
    f.bots.noteLegacyTelling({ botId: id, message })
  }
  f.store.run("INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, 'cursor:kept-thread', 'true')", botId)
  if (action === 'clear') await f.bots.clearChat(botId)
  else await f.bots.resetBot(botId)
  const receipts = f.store.all("SELECT bot_id FROM bot_memory_state WHERE key GLOB 'cursor:telling-legacy:*'")
  expect(receipts.map(row => row.bot_id)).toEqual([other])
  expect(f.store.get("SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = 'cursor:kept-thread'", botId)).toBeDefined()
})
it('Forget removes a redacted message’s legacy receipt and preserves unrelated receipts', async () => {
  const { BotMemoryStore } = await import('../../src/mms/bots/memory/BotMemoryStore')
  const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  const forgotten = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'The private appointment is at the clinic on Thursday afternoon.' })
  const kept = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'An unrelated announcement remains available.' })
  for (const message of [forgotten, kept]) f.bots.noteLegacyTelling({ botId, message })
  const seq = f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'bot_msg', lane: 'chat', who: 'bot', sourceKey: `bm:${forgotten.id}`, text: forgotten.text }))!
  expect(memory.forget(botId, { refs: [`j${seq}`], by: 'owner_ui' })).not.toHaveProperty('error')
  expect(f.store.message(forgotten.id)?.text).not.toContain('private appointment')
  expect(f.store.get('SELECT 1 FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `cursor:telling-legacy:${forgotten.id}`)).toBeUndefined()
  expect(f.store.get('SELECT 1 FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `cursor:telling-legacy:${kept.id}`)).toBeDefined()
})

// An older build kept a Tells you level and a can-wake choice here; neither changes how a report is told any more.
it('ignores a telling level and can-wake choice an older build stored', () => {
  f.store.run('UPDATE bot_registry SET tell_json = ? WHERE bot_id = ?', JSON.stringify({ tellMe: 'needs_you', canWakeMe: true }), botId)
  const report = f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: 'Night report' })
  expect(f.store.message(report.id)).toMatchObject({ tell: 'soon', tellAt: f.store.now() })
})

it.each([false, true])('C4 folded telling preserves the single projection cost without action rows, switch=%s', async (on) => {
  const { BotTellings } = await import('../../src/mms/bots/chat/BotTellings')
  const chat = new BotChatProjection({ store: f.store, asksFirst: () => on, emit() {} })
  const rows = Array.from({ length: 8 }, (_, i) => {
    const message = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: `Update ${i}` })
    return f.store.message(message.id)!
  })
  const projection = vi.spyOn(chat, 'toMessage')
  const events: any[] = []
  const telling = new BotTellings(f.store, chat, () => 'Scout', event => events.push(event))
  telling.releaseBacklog(rows, f.clock.now)
  expect(events).toHaveLength(1)
  expect(events[0].rows).toHaveLength(rows.length)
  expect(projection).toHaveBeenCalledTimes(1)
})
