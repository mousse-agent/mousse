/**
 * A bot that stays free while it works (docs/plans/bot-always-free.md): the chat is the front desk, work runs beside
 * it and reports as a reply, notes reach running work before it reports, reminders are said at their time, and every
 * reply says which message it answers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_WORK_ONLY_TOOLS, BOT_WORK_TOOLS } from '../../src/shared/bots/personal/manifest'
import { BOT_FAILURE_PAUSE_STREAK, BotEngine, MAX_TURN_CAP_CONTINUATIONS, roomText, sayOnce, stoppedShortText } from '../../src/mms/bots/activation/BotEngine'
import { reminderLabel, reminderTime } from '../../src/mms/run/mcp/appTools/bots'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { isBotRoomAbort, isBotWallAbort } from '../../src/mms/bots/activation/dispatcher'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', description: 'Keep my day in order.', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string, replyTo?: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id, ...(replyTo ? { replyTo } : {}) })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

const summary = () => f.bots.service.list().bots.find((bot) => bot.id === botId)!

describe('the chat is the front desk', () => {
  it('a chat turn gets the work and reminder tools and not what can take long; work gets the web and no work tools', async () => {
    const { prepared, payload, activation } = await chat('Find me a good vacuum', 'm1')
    const allowed = prepared.policy.tools!.allow!
    for (const tool of BOT_WORK_TOOLS) expect(allowed).toContain(tool)
    for (const tool of BOT_WORK_ONLY_TOOLS) expect(allowed).not.toContain(tool)
    const started = await f.bots.tools.work.start(botId, activation.id, { title: 'Vacuum comparison', brief: 'Compare three vacuums under £250.', key: 'k1' })
    expect(started).toMatchObject({ status: 'started', ahead: [] })
    await finish(f, payload, 'completed', { text: "On it, I'll tell you when it's done." })
    const work = await start(f, started.workId)
    const workAllowed = work.prepared.policy.tools!.allow!
    expect(workAllowed).toContain('web_search')
    expect(workAllowed).toContain('web_fetch')
    for (const tool of BOT_WORK_TOOLS) expect(workAllowed).not.toContain(tool)
    expect(work.prepared.prompt).toContain('Compare three vacuums under £250.')
    expect(work.prepared.lane).toBe('run')
  })

  it('stays free while work runs: a second message is answered at once, and the work reports as a reply to its message', async () => {
    const first = await chat('Research vacuums under £250', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Vacuum comparison', brief: 'Compare vacuums under £250.', key: 'k1' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    expect(summary()).toMatchObject({ state: 'working', stateText: 'Working on Vacuum comparison', work: [{ id: workId, title: 'Vacuum comparison', status: 'running' }] })
    expect(summary().chat).toBeUndefined()

    // The owner writes while the work runs: the chat answers it now, beside the work.
    const second = await chat('Also add AA batteries to my list', 'm2')
    expect(f.store.activation(workId)!.status).toBe('running')
    expect(summary().chat).toEqual({ activationId: second.activation.id })
    await finish(f, second.payload, 'completed', { text: 'Added.' })
    expect(chatOf(f, botId).at(-1)).toMatchObject({ text: 'Added.', replyTo: { id: second.message.id, author: 'owner' } })

    await finish(f, work.payload, 'completed', { text: 'The Roborock Q7 is the pick.' })
    const report = chatOf(f, botId).at(-1)!
    expect(report).toMatchObject({ kind: 'run_report', text: 'The Roborock Q7 is the pick.', replyTo: { id: first.message.id, author: 'owner', text: 'Research vacuums under £250' } })
    expect(f.store.activation(workId)).toMatchObject({ status: 'done' })
    expect(summary().work).toBeUndefined()
  })

  it('work runs one at a time: later work says what it waits behind and starts when the lane frees', async () => {
    const first = await chat('Two jobs', 'm1')
    const a = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Job A', brief: 'Do A.', key: 'a' })
    const b = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Job B', brief: 'Do B.', key: 'b' })
    expect(b).toMatchObject({ status: 'queued', ahead: ['Job A'] })
    // The same call again starts nothing new.
    expect((await f.bots.tools.work.start(botId, first.activation.id, { title: 'Job B', brief: 'Do B.', key: 'b' })).workId).toBe(b.workId)
    await finish(f, first.payload, 'completed', { text: 'Both on my list.' })
    expect(f.bots.tools.work.list(botId).now.map((item) => [item.title, item.status])).toEqual([['Job A', 'running'], ['Job B', 'queued']])
    await runDispatch(f, a.workId, 1, { text: 'A done.' })
    expect(f.store.activation(b.workId)!.status).toBe('running')
    expect(f.bots.tools.work.list(botId).recent[0]).toMatchObject({ workId: a.workId, title: 'Job A', status: 'done', report: 'A done.' })
  })

  it('stops one piece of work, and never the chat', async () => {
    const first = await chat('Long job', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Long job', brief: 'Take a while.', key: 'k' })
    expect(await f.bots.service.workStop(botId, workId)).toEqual({ stopped: true })
    expect(f.store.activation(workId)!.status).toBe('cancelled')
    expect(f.store.activation(first.activation.id)!.status).toBe('running')
    expect(await f.bots.service.workStop(botId, workId)).toEqual({ stopped: false })
    await expect(f.bots.service.workStop(botId, first.activation.id)).rejects.toThrow('no such work')
  })

  it("work that fails doesn't pause the bot's schedules", async () => {
    for (let i = 0; i < BOT_FAILURE_PAUSE_STREAK + 1; i += 1) {
      const turn = await chat(`Job ${i}`, `m${i}`)
      const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: `Job ${i}`, brief: 'Fail.', key: `k${i}` })
      await finish(f, turn.payload, 'completed', { text: 'On it.' })
      await runDispatch(f, workId, 1, { status: 'failed' })
      expect(f.store.activation(workId)!.status).toBe('failed')
    }
    expect(f.store.registry(botId)!.pausedReason).toBeNull()
  })
})

describe('notes to work', () => {
  it('running work posts what it has, takes the note, and reports again with the change', async () => {
    const first = await chat('Compare vacuums', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Vacuums', brief: 'Compare vacuums.', key: 'k' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    expect(f.bots.tools.work.note(botId, workId, 'Only ones under £200.')).toBe('noted')
    await finish(f, work.payload, 'completed', { text: 'Here are three under £250.' })
    // What it had is posted at once (never lost), as an update on the way; the work goes on with the note.
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'notice', text: 'Here are three under £250.', replyTo: { id: first.message.id } })
    expect(f.store.activation(workId)!.status).toBe('running')
    const continued = await start(f, workId, 2)
    expect(continued.prepared.prompt).toContain('Only ones under £200.')
    expect(continued.prepared.prompt).toContain('already sent')
    await finish(f, continued.payload, 'completed', { text: 'Under £200 there are two.' })
    expect(chatOf(f, botId).filter((message) => message.kind === 'run_report').map((message) => message.text)).toEqual(['Under £200 there are two.'])
    expect(f.store.pendingWorkNotes(workId)).toEqual([])
  })

  it('a note continuation that is stopped keeps what the work had already found', async () => {
    const first = await chat('Compare vacuums', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Vacuums', brief: 'Compare vacuums.', key: 'k' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    f.bots.tools.work.note(botId, workId, 'Cordless only.')
    await finish(f, work.payload, 'completed', { text: 'Three picks, one corded.' })
    await f.bots.service.workStop(botId, workId)
    expect(chatOf(f, botId).some((message) => message.text === 'Three picks, one corded.')).toBe(true)
  })

  it('notes for work that is paused or blocked are refused: it may never continue', async () => {
    const first = await chat('A job', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Job', brief: 'Do it.', key: 'k' })
    f.store.moveActivation(workId, ['running'], 'paused', { endReason: 'unknown_calls' })
    expect(f.bots.tools.work.note(botId, workId, 'Also this.')).toBe('held')
  })

  it('waiting work gets the note with its request; ended work says so', async () => {
    const first = await chat('Two jobs', 'm1')
    const a = await f.bots.tools.work.start(botId, first.activation.id, { title: 'A', brief: 'Do A.', key: 'a' })
    const b = await f.bots.tools.work.start(botId, first.activation.id, { title: 'B', brief: 'Do B.', key: 'b' })
    expect(f.bots.tools.work.note(botId, b.workId, 'In French.')).toBe('noted')
    await finish(f, first.payload, 'completed', { text: 'On both.' })
    await runDispatch(f, a.workId, 1, { text: 'A done.' })
    expect(f.store.dispatch(b.workId, 1)!.prompt.text).toContain('In French.')
    expect(f.bots.tools.work.note(botId, a.workId, 'Too late.')).toBe('ended')
    expect(f.bots.tools.work.note(botId, 'act_00000000-0000-0000-0000-000000000000', 'x')).toBe('not_found')
  })
})

describe('reminders', () => {
  const fireDue = async () => {
    for (const timer of f.timers.splice(0)) timer.fn()
    await flush()
  }

  it('says the reminder at its time, as a reply to the message that asked, with no model run', async () => {
    const turn = await chat('Remind me in 7 minutes to drink water', 'm1')
    const added = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 7 * 60_000).toISOString(), text: 'Time to drink some water.' })
    await finish(f, turn.payload, 'completed', { text: "I'll remind you at 09:07." })
    expect(f.bots.tools.reminders.list(botId)).toEqual([{ reminderId: added.reminderId, dueAt: added.dueAt, text: 'Time to drink some water.' }])
    const activations = f.store.listActivations(botId).length
    f.clock.now += 7 * 60_000
    await fireDue()
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Time to drink some water.', replyTo: { id: turn.message.id } })
    expect(f.store.listActivations(botId)).toHaveLength(activations)
    expect(f.bots.tools.reminders.list(botId)).toEqual([])
    // Said once, whatever fires again.
    await f.bots.deliverDueReminders()
    expect(chatOf(f, botId).filter((message) => message.text === 'Time to drink some water.')).toHaveLength(1)
  })

  it('a reminder missed while Mousse was off is said at the next start with its time; a work reminder starts work', async () => {
    const turn = await chat('Two reminders', 'm1')
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Call mum.' })
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Checking the weather.', work: { title: 'Weather', brief: 'Check tomorrow\'s weather in London.' } })
    await finish(f, turn.payload, 'completed', { text: 'Both set.' })
    f.clock.now += 60 * 60_000
    await f.bots.maintain(new Date(f.clock.now))
    expect(chatOf(f, botId).some((message) => message.text.startsWith('(For ') && message.text.endsWith('Call mum.'))).toBe(true)
    const work = f.store.laneActivations(botId, 'run', ['running', 'queued'])
    expect(work).toHaveLength(1)
    expect(work[0]!.trigger).toMatchObject({ kind: 'work', title: 'Weather', replyTo: turn.message.id })
  })

  it("a work reminder whose bot can't run is still said, with why, and never retried in a loop", async () => {
    const turn = await chat('Check the weather at 8', 'm1')
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Checking the weather.', work: { title: 'Weather', brief: 'Check the weather.' } })
    await finish(f, turn.payload, 'completed', { text: 'Set.' })
    f.bots.revoke(botId)
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    const said = chatOf(f, botId).at(-1)!
    expect(said.text).toMatch(/^Checking the weather\.\n\nI couldn't start on it: /)
    expect(f.store.waitingReminders(botId)).toEqual([])
    expect(f.store.laneActivations(botId, 'run', ['queued', 'running'])).toEqual([])
  })

  it('forgetting the message that asked cancels its reminder and removes its words', async () => {
    const turn = await chat('Remind me at 9 to call Dr Ames about the biopsy', 'm1')
    const added = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60 * 60_000).toISOString(), text: 'Call Dr Ames about the biopsy.' })
    await finish(f, turn.payload, 'completed', { text: 'Set for 9.' })
    // The owner's message in a real journal (the fixture's journal is a stand-in), then forgotten by its row.
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${turn.message.id}`, who: 'owner', text: turn.message.text }))
    const row = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${turn.message.id}`)!
    expect(memory.forget(botId, { refs: [`j${row.seq as number}`], by: 'owner_ui' })).not.toHaveProperty('error')
    expect(f.store.reminder(added.reminderId)).toMatchObject({ status: 'cancelled' })
    expect(f.store.reminder(added.reminderId)!.text).not.toContain('Ames')
  })

  it('forgetting the message that asked for work cancels it if it has not started, and scrubs its brief everywhere', async () => {
    const turn = await chat('Two jobs about Dr Ames', 'm1')
    const a = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Ames records', brief: 'Collect the Dr Ames letters.', key: 'a' })
    const b = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Ames summary', brief: 'Summarise the Dr Ames letters.', key: 'b' })
    f.bots.tools.work.note(botId, a.workId, 'Include the biopsy one from Ames.')
    await finish(f, turn.payload, 'completed', { text: 'On both.' })
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${turn.message.id}`, who: 'owner', text: turn.message.text }))
    const row = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${turn.message.id}`)!
    memory.forget(botId, { refs: [`j${row.seq as number}`], by: 'owner_ui' })
    expect(f.store.activation(b.workId)!.status).toBe('cancelled')
    for (const id of [a.workId, b.workId]) expect(JSON.stringify(f.store.activation(id)!.trigger)).not.toContain('Ames')
    expect(JSON.stringify(f.store.dispatch(a.workId, 1)!.prompt)).not.toContain('Ames')
    expect(JSON.stringify(f.store.all('SELECT text FROM bot_work_notes'))).not.toContain('Ames')
  })

  it('cancelled and deleted bots say nothing', async () => {
    const turn = await chat('Remind me', 'm1')
    const added = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'One.' })
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 120_000).toISOString(), text: 'Two.' })
    expect(f.bots.tools.reminders.cancel(botId, added.reminderId)).toBe(true)
    expect(f.bots.tools.reminders.cancel(botId, added.reminderId)).toBe(false)
    await finish(f, turn.payload, 'completed', { text: 'Set.' })
    await f.bots.remove(botId)
    f.clock.now += 5 * 60_000
    await f.bots.deliverDueReminders()
    expect(f.store.waitingReminders(botId)).toEqual([])
    expect(f.store.all('SELECT text FROM bot_messages WHERE text IN (?, ?)', 'One.', 'Two.')).toEqual([])
  })

  it('About lists waiting reminders; one the owner cancels there is never said', async () => {
    const turn = await chat('Remind me twice', 'm1')
    const one = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'One.' })
    const two = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 120_000).toISOString(), text: 'Two.', work: { title: 'Two', brief: 'Do two.' } })
    await finish(f, turn.payload, 'completed', { text: 'Set.' })
    expect(f.bots.service.get(botId).reminders).toEqual([
      { id: one.reminderId, dueAt: one.dueAt, text: 'One.' },
      { id: two.reminderId, dueAt: two.dueAt, text: 'Two.', work: true }
    ])
    const detail = f.bots.service.reminderCancel(botId, one.reminderId)
    expect(detail.reminders!.map((reminder) => reminder.id)).toEqual([two.reminderId])
    // A second cancel, or one said meanwhile, leaves things as they are; another bot's or an unknown id is refused.
    expect(f.bots.service.reminderCancel(botId, one.reminderId).reminders).toHaveLength(1)
    expect(() => f.bots.service.reminderCancel(botId, 'rem_00000000-0000-0000-0000-000000000000')).toThrow(/no such reminder/)
    f.clock.now += 60_000
    await fireDue()
    await f.bots.deliverDueReminders()
    expect(f.store.all('SELECT text FROM bot_messages WHERE text = ?', 'One.')).toEqual([])
    expect(f.store.reminder(one.reminderId)).toMatchObject({ status: 'cancelled' })
  })

  it('refuses a time that has passed or is too far, and a reminder with no text', async () => {
    const turn = await chat('Remind me', 'm1')
    const add = (dueAt: number, text = 'x') => () => f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(dueAt).toISOString(), text })
    expect(add(f.clock.now - 10 * 60_000)).toThrow('has passed')
    expect(add(f.clock.now + 400 * 24 * 60 * 60_000)).toThrow('a year ahead')
    expect(add(f.clock.now + 60_000, '  ')).toThrow('needs its text')
  })

  it('reads minutes from now or a local date and time, and labels it plainly', () => {
    const now = new Date(2026, 10, 10, 18, 35)
    expect(reminderTime(7, undefined, now)).toEqual(new Date(2026, 10, 10, 18, 42))
    expect(reminderTime(undefined, '2026-11-14T09:00', now)).toEqual(new Date(2026, 10, 14, 9, 0))
    expect(reminderTime(7, '2026-11-14T09:00', now)).toBe('Give either inMinutes or at.')
    expect(reminderTime(0, undefined, now)).toBe('A reminder is at least a minute from now.')
    expect(reminderTime(undefined, 'tomorrow', now)).toMatch(/local date and time/)
    // A date alone has no time, and a field out of range is refused, not rolled over.
    expect(reminderTime(undefined, '2026-11-14', now)).toMatch(/local date and time/)
    expect(reminderTime(undefined, '2026-13-01T09:00', now)).toMatch(/local date and time/)
    expect(reminderTime(undefined, '2026-11-14T09:00:00Z', now)).toEqual(new Date(Date.UTC(2026, 10, 14, 9)))
    expect(reminderTime(undefined, '2026-02-31T09:00Z', now)).toMatch(/local date and time/)
    expect(reminderTime(undefined, '2026-11-14T09:00+05:30', now)).toEqual(new Date(Date.UTC(2026, 10, 14, 3, 30)))
    expect(reminderLabel(new Date(2026, 10, 10, 18, 42), now)).toBe('18:42')
    expect(reminderLabel(new Date(2026, 10, 14, 9, 0), now)).toBe('Sat 14 Nov · 09:00')
  })
})

describe('replies say what they answer', () => {
  it("the owner's reply to a bot message is kept and given to the bot with what it answers; another bot's message is dropped", async () => {
    const first = await chat('What should I buy?', 'm1')
    await finish(f, first.payload, 'completed', { text: 'Oat milk and eggs.' })
    const botMessage = chatOf(f, botId).at(-1)!
    const reply = await chat('Done, bought them', 'm2', botMessage.id)
    expect(reply.message.replyTo).toMatchObject({ id: botMessage.id, author: 'bot', text: 'Oat milk and eggs.' })
    expect(reply.prepared.prompt).toBe('(Replying to your message: "Oat milk and eggs.")\n\nDone, bought them')
    await finish(f, reply.payload, 'completed', { text: 'Ticked off.' })
    const other = (await createBot(f, { name: 'Sage', reply: 'Hi.' })).botId
    const foreign = chatOf(f, other).at(-1)!
    const stray = await chat('About that', 'm3', foreign.id)
    expect(stray.message.replyTo).toBeUndefined()
    expect(stray.prepared.prompt).toBe('About that')
  })
})

describe('a chat reply says a short thing once', () => {
  it('keeps the last of two paragraphs that open the same way, and leaves anything else alone', () => {
    expect(sayOnce('On it — checking the current GBP/EUR rate.\n\nOn it — checking the current GBP/EUR rate now.')).toBe('On it — checking the current GBP/EUR rate now.')
    expect(sayOnce('Added.\n\nYour list now has 4 things.')).toBe('Added.\n\nYour list now has 4 things.')
    expect(sayOnce('On it.')).toBe('On it.')
    const list = 'Here is the plan:\n\n- one\n- two'
    expect(sayOnce(list)).toBe(list)
  })
})

describe('third review (docs/plans/bot-always-free.md)', () => {
  it('a work reminder cancelled while the pass delivers another is not started', async () => {
    const turn = await chat('Two morning jobs', 'm1')
    // A is due a second before B, so the pass delivers A first. (At the same time the pass takes them by id, which is
    // random: B first would start before the cancel below, and the test would say nothing about a cancel mid-pass.)
    const a = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Job A.', work: { title: 'A', brief: 'Do A.' } })
    const b = f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 61_000).toISOString(), text: 'Job B.', work: { title: 'B', brief: 'Do B.' } })
    await finish(f, turn.payload, 'completed', { text: 'Both set.' })
    // While A's work is being started, the owner cancels B.
    const engine = f.bots as unknown as { enqueue: (...args: unknown[]) => Promise<unknown> }
    const enqueue = engine.enqueue.bind(engine)
    engine.enqueue = async (...args: unknown[]) => {
      const started = await enqueue(...args)
      f.bots.tools.reminders.cancel(botId, b.reminderId)
      return started
    }
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    const titles = f.store.listActivations(botId).filter((row) => row.trigger.kind === 'work').map((row) => (row.trigger as { title: string }).title)
    expect(titles).toEqual(['A'])
    expect(f.store.reminder(a.reminderId)!.status).toBe('delivered')
    expect(f.store.reminder(b.reminderId)!.status).toBe('cancelled')
  })

  it('forgetting a follow-up message removes the note it passed to work, and its copy in the prompt', async () => {
    const first = await chat('Research clinics near me', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Clinics', brief: 'Find clinics.', key: 'k' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    const second = await chat('Only ones that treat my condition X-17', 'm2')
    expect(f.bots.tools.work.note(botId, workId, 'Only clinics treating condition X-17.', second.activation.id)).toBe('noted')
    await finish(f, second.payload, 'completed', { text: 'Passed on.' })
    await finish(f, work.payload, 'completed', { text: 'Five clinics.' })
    expect(f.store.dispatch(workId, 2)!.prompt.text).toContain('X-17')
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${second.message.id}`, who: 'owner', text: second.message.text }))
    const row = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${second.message.id}`)!
    memory.forget(botId, { refs: [`j${row.seq as number}`], by: 'owner_ui' })
    expect(JSON.stringify(f.store.all('SELECT text FROM bot_work_notes'))).not.toContain('X-17')
    expect(f.store.dispatch(workId, 2)!.prompt.text).not.toContain('X-17')
  })

  it('a chat reply that started no work is posted as written, even when two paragraphs open alike', async () => {
    const turn = await chat('When are the trains?', 'm1')
    await finish(f, turn.payload, 'completed', { text: 'The train leaves at 09:00 from Central.\n\nThe train leaves at 10:00 from Riverside.' })
    expect(chatOf(f, botId).at(-1)!.text).toBe('The train leaves at 09:00 from Central.\n\nThe train leaves at 10:00 from Riverside.')
  })
})

describe('long work', () => {
  const MIN = 60_000
  /** A run's error when its turn reached the runtime's cap on model turns (Claude Code's `maxTurns`). */
  const TURN_CAP = { error: '[provider_turn_cap] Claude Code reached the most steps one turn may take.' }
  /** A call the work makes: progress, so its time is work. */
  const call = { kind: 'app' as const, tool: 'memory_list', args: {} }
  const errors = () => chatOf(f, botId).filter((message) => message.kind === 'error')

  /** Work the owner asked for, handed off by the chat (which has answered). */
  async function asked(text = 'Research vacuums under £250', id = 'm1') {
    const turn = await chat(text, id)
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Vacuums', brief: 'Compare vacuums under £250.', key: `k-${id}` })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    return { workId, message: turn.message }
  }

  describe('the cap on model turns in one dispatch', () => {
    it('carries the work on in the same thread with the time it has left, and its report answers the message', async () => {
      const { workId, message } = await asked()
      const first = await start(f, workId)
      f.clock.now += 20 * MIN
      first.prepared.authority.check(call)
      await finish(f, first.payload, 'failed', { outcome: TURN_CAP })
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      const next = f.store.dispatch(workId, 2)!
      expect(next).toMatchObject({ kind: 'continue', threadId: first.payload.threadId, send: { continuationOfRunId: first.payload.runId, turnCap: true } })
      expect(next.prompt.text).toBe('[Mousse] You reached the most steps one turn may take; what you did so far is kept. Continue.')
      expect(errors()).toEqual([])
      const second = await start(f, workId, 2)
      expect(second.prepared.authority.time.deadline() - f.clock.now).toBe(40 * MIN)
      await finish(f, second.payload, 'completed', { text: 'The Roborock Q7 is the pick.' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'The Roborock Q7 is the pick.', replyTo: { id: message.id } })
      expect(f.store.activation(workId)).toMatchObject({ status: 'done' })
    })

    it('with no time left it ends at its limit with an ask for more, never as something that went wrong', async () => {
      const { workId } = await asked()
      const first = await start(f, workId)
      f.clock.now += 60 * MIN - 10_000
      first.prepared.authority.check(call)
      await finish(f, first.payload, 'failed', { outcome: TURN_CAP })
      expect(f.store.dispatch(workId, 2)).toBeUndefined()
      expect(f.store.activation(workId)!.endReason).toBe('budget_exhausted')
      expect(f.store.openAsks(botId)).toMatchObject([{ kind: 'budget', title: 'work for up to 2 hours per run' }])
      expect(JSON.stringify(chatOf(f, botId))).not.toContain('Something went wrong')
    })

    it('with its turn budget used up it ends at that limit with its ask', async () => {
      f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxTurns: 3 } }))
      const { workId } = await asked()
      const first = await start(f, workId)
      for (let i = 0; i < 3; i += 1) expect(first.prepared.authority.counters.charge('request')).toMatchObject({ ok: true })
      f.clock.now += MIN
      await finish(f, first.payload, 'failed', { outcome: TURN_CAP })
      expect(f.store.dispatch(workId, 2)).toBeUndefined()
      expect(f.store.openAsks(botId)).toMatchObject([{ kind: 'budget', permission: { budget: { key: 'maxTurns' } } }])
      expect(JSON.stringify(chatOf(f, botId))).not.toContain('Something went wrong')
    })

    it('a chat turn carries on too, and answers once', async () => {
      const turn = await chat('Sort my notes', 'm1')
      f.clock.now += MIN
      turn.prepared.authority.check(call)
      await finish(f, turn.payload, 'failed', { outcome: TURN_CAP })
      expect(f.store.dispatch(turn.activation.id, 2)).toMatchObject({ kind: 'continue', send: { turnCap: true } })
      await runDispatch(f, turn.activation.id, 2, { text: 'Sorted.' })
      expect(chatOf(f, botId).filter((message) => message.activationId === turn.activation.id && message.author === 'bot').map((message) => message.text)).toEqual(['Sorted.'])
      expect(errors()).toEqual([])
    })

    it('after the cap is reached 10 times in all (not in a row), work ends as out of room with what it had, never as a failure', async () => {
      const { workId, message } = await asked()
      let n = 1
      // Eleven turns reach the cap (ten continue it, the eleventh ends it), and one completes in between.
      const turns = MAX_TURN_CAP_CONTINUATIONS + 2
      for (let step = 0; step < turns; step += 1) {
        const turn = await start(f, workId, n)
        f.clock.now += MIN
        turn.prepared.authority.check(call)
        f.chips.set(`${workId}:d${n}`, [{ icon: 'web', text: `Searched step ${step}` }])
        if (step === 4) {
          // Half way, a turn completes and the owner's note continues the work: the count goes on, it does not start again.
          f.bots.tools.work.note(botId, workId, 'Cordless only.')
          await finish(f, turn.payload, 'completed', { text: 'Five picks so far.' })
          n += 1
          continue
        }
        await finish(f, turn.payload, 'failed', { text: `Words of turn ${n}.`, outcome: TURN_CAP })
        n += 1
      }
      expect(f.store.dispatches(workId).filter((dispatch) => dispatch.send.turnCap)).toHaveLength(MAX_TURN_CAP_CONTINUATIONS)
      expect(f.store.activation(workId)).toMatchObject({ status: 'done', endReason: 'turn_cap_repeated' })
      expect(errors()).toEqual([])
      const report = chatOf(f, botId).at(-1)!
      expect(report).toMatchObject({ kind: 'run_report', text: stoppedShortText(`Words of turn ${n - 1}.`), replyTo: { id: message.id } })
      expect(report.chips.map((chip) => chip.text)).toContain(`Searched step ${turns - 1}`)
    })

    it('a continuation that runs out at once still posts what the capped turn said and did', async () => {
      const { workId } = await asked()
      const first = await start(f, workId)
      f.clock.now += 60 * MIN - 10_000
      first.prepared.authority.check(call)
      f.chips.set(`${workId}:d1`, [{ icon: 'web', text: 'Searched the web' }])
      await finish(f, first.payload, 'failed', { text: 'Two picks so far: Roborock Q7 and Dyson V8.', outcome: TURN_CAP })
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      const notice = chatOf(f, botId).at(-1)!
      expect(notice).toMatchObject({ kind: 'notice', text: roomText('Two picks so far: Roborock Q7 and Dyson V8.'), ask: { status: 'open' } })
      expect(notice.chips.map((chip) => chip.text)).toEqual(['Searched the web'])
    })

    it('the capped turn\'s words still reach the next message when they arrive after its work went on', async () => {
      const { workId } = await asked()
      const first = await start(f, workId)
      f.clock.now += MIN
      first.prepared.authority.check(call)
      // The run's end settles the dispatch first; the executor's words come after the continuation was written.
      f.runs.markTerminal(first.payload.runId, 'failed', TURN_CAP)
      f.bots.settle(first.payload, {})
      await flush()
      expect(f.store.dispatch(workId, 2)).toMatchObject({ send: { turnCap: true } })
      f.bots.settle(first.payload, { text: 'Two picks so far.' })
      await runDispatch(f, workId, 2, { text: '' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Two picks so far.' })
    })

    it('the capped turn\'s chips go into the report of the turn that finishes the work', async () => {
      const { workId } = await asked()
      const first = await start(f, workId)
      f.clock.now += MIN
      first.prepared.authority.check(call)
      f.chips.set(`${workId}:d1`, [{ icon: 'web', text: 'Searched the web' }])
      await finish(f, first.payload, 'failed', { text: 'Interim.', outcome: TURN_CAP })
      f.chips.set(`${workId}:d2`, [{ icon: 'edit', text: 'Wrote notes.md' }])
      await runDispatch(f, workId, 2, { text: 'The Q7.' })
      const report = chatOf(f, botId).at(-1)!
      expect(report).toMatchObject({ kind: 'run_report', text: 'The Q7.' })
      expect(report.chips.map((chip) => chip.text)).toEqual(['Searched the web', 'Wrote notes.md'])
    })
  })

  describe('work that runs out of room', () => {
    /** The dispatch's deadline: its timer fires (it is the newest timer of that length). */
    const deadline = (ms = 60 * MIN) => f.timers.filter((timer) => timer.ms === ms).at(-1)!.fn()

    /** Work that ran its hour: what it had is in the chat with the ask, and the run lane is free. */
    async function outOfTime(text = 'Two picks so far: Roborock Q7 and Dyson V8.') {
      const work = await asked()
      const first = await start(f, work.workId)
      f.clock.now += 60 * MIN
      first.prepared.authority.check(call)
      deadline()
      expect(first.prepared.authority.time.signal.aborted).toBe(true)
      await finish(f, first.payload, 'interrupted', { text, outcome: { interruptedBy: 'bot_wall' } })
      return { ...work, first }
    }

    it('its turn is cut as out of room, so it hands back what it had; a chat\'s wall is cut as a plain wall', async () => {
      const { first } = await outOfTime()
      expect(isBotRoomAbort(first.prepared.authority.time.signal.reason)).toBe(true)
      // A chat turn at a wall (here, its own hour) is a wall like any other: it hands back only its open reply.
      const turn = await chat('How long?', 'm2')
      f.clock.now += 60 * MIN
      turn.prepared.authority.check(call)
      deadline()
      expect(isBotWallAbort(turn.prepared.authority.time.signal.reason)).toBe(true)
      expect(isBotRoomAbort(turn.prepared.authority.time.signal.reason)).toBe(false)
    })

    it('posts what it had with the ask, waits without holding the run lane, and never counts as a failure', async () => {
      const { workId, message } = await outOfTime()
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      const notice = chatOf(f, botId).at(-1)!
      expect(notice).toMatchObject({
        kind: 'notice',
        text: roomText('Two picks so far: Roborock Q7 and Dyson V8.'),
        ask: { title: 'work for up to 2 hours per run', status: 'open', carriesOn: true },
        replyTo: { id: message.id }
      })
      expect(notice.text).toContain('Two picks so far')
      expect(errors()).toEqual([])
      expect(f.store.openAsks(botId)).toHaveLength(1)
      expect(summary()).toMatchObject({ state: 'needs_you', work: [{ id: workId, status: 'paused' }] })
      expect(f.bots.tools.work.list(botId)).toMatchObject({ now: [{ workId, status: 'paused' }] })
      expect(f.bots.tools.work.list(botId).recent.some((item) => item.workId === workId)).toBe(false)
      expect(f.bots.tools.work.note(botId, workId, 'Cordless only.')).toBe('noted')
      // The run lane is free: other work starts at once.
      const next = await chat('Also check the weather', 'm2')
      const other = await f.bots.tools.work.start(botId, next.activation.id, { title: 'Weather', brief: 'Check the weather.', key: 'k-weather' })
      expect(other.status).toBe('started')
      expect(f.store.registry(botId)).toMatchObject({ failureStreak: 0, pausedReason: null })
    })

    it('Allow carries it on in the same thread, and its report answers the original message', async () => {
      const { workId, message, first } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(120 * MIN)
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      const next = f.store.dispatch(workId, 2)!
      expect(next).toMatchObject({ kind: 'continue', threadId: first.payload.threadId })
      expect(next.prompt.text).toBe('[Mousse] You have more room now; what you had so far was already sent to the owner. Carry on where you left off.')
      const second = await start(f, workId, 2)
      expect(second.prepared.authority.time.deadline() - f.clock.now).toBe(60 * MIN)
      await finish(f, second.payload, 'completed', { text: 'The Roborock Q7 is the pick.' })
      expect(f.store.activation(workId)).toMatchObject({ status: 'done' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'The Roborock Q7 is the pick.', replyTo: { id: message.id } })
      expect(chatOf(f, botId).find((row) => row.ask?.askId === askId)!.ask).toMatchObject({ status: 'allowed', carriesOn: true })
      // Answered once, carried on once: nothing more is sent.
      await f.bots.maintain()
      expect(f.store.dispatches(workId)).toHaveLength(2)
    })

    it('Allow while other work runs carries it on after that work, before anything queued later', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      const turn = await chat('Check the weather', 'm2')
      const weather = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Weather', brief: 'Check the weather.', key: 'k-weather' })
      const later = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Trains', brief: 'Check the trains.', key: 'k-trains' })
      await finish(f, turn.payload, 'completed', { text: 'On it.' })
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'room_allowed' })
      expect(f.bots.tools.work.list(botId).now.find((item) => item.workId === workId)).toMatchObject({ status: 'queued' })
      await runDispatch(f, weather.workId, 1, { text: 'Sunny.' })
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      expect(f.store.activation(later.workId)).toMatchObject({ status: 'queued' })
    })

    it('takes over an earlier run\'s open ask; Allow on that card before its turn ended carries it on once the turn let go', async () => {
      // A run started by hand ran out first: it ended, and its ask waits in the chat.
      const run = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
      const earlier = await start(f, run.id)
      f.clock.now += 60 * MIN
      earlier.prepared.authority.check(call)
      deadline()
      await finish(f, earlier.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      const { workId } = await asked()
      const first = await start(f, workId)
      f.clock.now += 60 * MIN
      first.prepared.authority.check(call)
      deadline()
      expect(f.store.escalation(askId)).toMatchObject({ activationId: workId, status: 'open' })
      expect(f.store.openAsks(botId)).toHaveLength(1)
      // Its turn is still ending when the owner allows on the earlier card.
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'room_allowed' })
      expect(f.store.dispatch(workId, 2)).toBeUndefined()
      await finish(f, first.payload, 'interrupted', { text: 'Half way through the list.', outcome: { interruptedBy: 'bot_wall' } })
      await flush()
      expect(chatOf(f, botId).some((row) => row.text === 'Half way through the list.')).toBe(true)
      expect(f.store.dispatch(workId, 2)).toMatchObject({ kind: 'continue', threadId: first.payload.threadId })
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
    })

    it('Not now ends it with what it posted', async () => {
      const { workId } = await outOfTime()
      const before = chatOf(f, botId).length
      await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'not_now')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
      expect(chatOf(f, botId)).toHaveLength(before)
      expect(chatOf(f, botId).at(-1)!.text).toContain('Two picks so far')
      expect(summary().work).toBeUndefined()
      expect(f.store.dispatches(workId)).toHaveLength(1)
    })

    it('after a Not now to that limit in the last day, the next work that runs out ends at once, and still posts what it had', async () => {
      await outOfTime()
      await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'not_now')
      await flush()
      const turn = await chat('And the Shark?', 'm2')
      const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Shark', brief: 'Check the Shark.', key: 'k-shark' })
      await finish(f, turn.payload, 'completed', { text: 'On it.' })
      const work = await start(f, workId)
      f.clock.now += 60 * MIN
      work.prepared.authority.check(call)
      deadline()
      await finish(f, work.payload, 'interrupted', { text: 'The Shark has 2,200 Pa.', outcome: { interruptedBy: 'bot_wall' } })
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'budget_exhausted' })
      expect(f.store.openAsks(botId)).toEqual([])
      const rows = chatOf(f, botId).filter((row) => row.activationId === workId)
      expect(rows).toMatchObject([
        { kind: 'error', error: { text: 'I ran out of room on this run, so I stopped.' } },
        { kind: 'notice', text: 'The Shark has 2,200 Pa.', replyTo: { id: turn.message.id } }
      ])
    })

    it('Stop wins: stopped work never carries on, even after Allow', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      expect(await f.bots.service.workStop(botId, workId)).toEqual({ stopped: true })
      expect(f.store.activation(workId)).toMatchObject({ status: 'cancelled' })
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      await f.bots.maintain()
      expect(f.store.dispatches(workId)).toHaveLength(1)
      expect(f.store.activation(workId)).toMatchObject({ status: 'cancelled' })
      // The wider grant stays for later runs.
      expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(120 * MIN)
    })

    it('an Allow recorded just before Mousse stopped carries it on once after the restart, with no second notice', async () => {
      const { workId } = await outOfTime()
      const before = chatOf(f, botId).length
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      // Allowed, then Mousse stopped before the continuation was written (no run engine to send it).
      const runs = f.host.runs
      f.host.runs = () => null
      await f.bots.service.answer(botId, askId, 'allow')
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'room_allowed' })
      f.host.runs = runs
      const restart = async () => {
        f.bots.close()
        f.bots = new BotEngine(f.host)
        await f.bots.reconcileOnStartup()
        await flush()
      }
      await restart()
      expect(f.store.dispatches(workId)).toHaveLength(2)
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      // Another start finds it on its way and sends nothing more.
      await restart()
      expect(f.store.dispatches(workId)).toHaveLength(2)
      expect(chatOf(f, botId)).toHaveLength(before)
    })

    it('a waiting notice that Mousse never posted is posted at the next start, once', async () => {
      const work = await asked()
      const first = await start(f, work.workId)
      f.clock.now += 60 * MIN
      first.prepared.authority.check(call)
      deadline()
      // Mousse stopped before the turn ended: its run is ended by the next start, and no reply was written.
      f.runs.markTerminal(first.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      f.bots.close()
      f.bots = new BotEngine(f.host)
      await f.bots.reconcileOnStartup()
      await f.bots.reconcileOnStartup()
      const notices = chatOf(f, botId).filter((row) => row.activationId === work.workId && row.ask)
      expect(notices).toMatchObject([{ kind: 'notice', text: roomText(''), ask: { status: 'open' } }])
    })

    /** A chat turn that runs out of its hour too: it waits at a wall for the same limit, with the bot's one card for it. */
    async function chatOutOfTime(text: string, id: string) {
      const turn = await chat(text, id)
      f.clock.now += 60 * MIN
      turn.prepared.authority.check(call)
      deadline()
      await finish(f, turn.payload, 'interrupted', { text: 'Let me check.', outcome: { interruptedBy: 'bot_wall' } })
      expect(f.store.activation(turn.activation.id)).toMatchObject({ status: 'waiting_grant' })
      return turn
    }

    it('a chat turn at the same limit takes the work\'s card; a message sent instead of answering ends the work too', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      const turn = await chatOutOfTime('How long will it take?', 'm2')
      expect(f.store.escalation(askId)).toMatchObject({ activationId: turn.activation.id, mode: 'wall', status: 'open' })
      await f.bots.service.chatSend({ botId, text: 'Never mind, skip it.', clientRequestId: 'm3' })
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
      expect(summary().work).toBeUndefined()
    })

    it('Allow on that chat wall carries the work on too', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      await chatOutOfTime('How long will it take?', 'm2')
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      expect(f.store.dispatch(workId, 2)).toMatchObject({ kind: 'continue' })
    })

    it('an answer through respond settles the work that shares the wall', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      await chatOutOfTime('How long will it take?', 'm2')
      await f.bots.respond({ escalationId: askId, answer: 'deny' })
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
    })

    it('work that runs out while a chat waits at a wall for that limit shows the wall\'s card, and its answer settles it', async () => {
      const { workId } = await asked()
      const work = await start(f, workId)
      const turn = await chatOutOfTime('Sort my notes', 'm0')
      const wall = f.store.openAsks(botId)[0]!
      expect(wall).toMatchObject({ activationId: turn.activation.id, mode: 'wall' })
      work.prepared.authority.check(call)
      f.timers.filter((timer) => timer.ms === 60 * MIN).at(-2)!.fn()
      await finish(f, work.payload, 'interrupted', { text: 'Two picks so far: Roborock Q7 and Dyson V8.', outcome: { interruptedBy: 'bot_wall' } })
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      const notice = chatOf(f, botId).filter((row) => row.activationId === workId).at(-1)!
      expect(notice).toMatchObject({ kind: 'notice', text: roomText('Two picks so far: Roborock Q7 and Dyson V8.'), ask: { askId: wall.id, status: 'open' } })
      await f.bots.service.answer(botId, wall.id, 'not_now')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
    })

    it('Not now on a spend limit ends every piece of work that waits on it, not only the card\'s own', async () => {
      f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 1_000 } }))
      const big = { inputBound: 5_000, wireCap: 500, floor: 256, price: { input: 0, output: 0 } }
      const spendOut = async (text: string, id: string) => {
        const work = await asked(text, id)
        const turn = await start(f, work.workId)
        expect(turn.prepared.authority.spend!.reserve(big, {})).toMatchObject({ ok: false })
        await finish(f, turn.payload, 'interrupted', { text: `Partial ${id}.`, outcome: { interruptedBy: 'bot_wall' } })
        expect(f.store.activation(work.workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
        return work.workId
      }
      const first = await spendOut('First', 'm1')
      const second = await spendOut('Second', 'm2')
      const ask = f.store.openAsks(botId)[0]!
      expect(ask).toMatchObject({ activationId: second, permission: { budget: { key: 'maxInputTokens' } } })
      await f.bots.service.answer(botId, ask.id, 'not_now')
      await flush()
      expect(f.store.activation(first)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
      expect(f.store.activation(second)).toMatchObject({ status: 'failed', endReason: 'budget_denied' })
    })

    it('waiting work whose ask was answered without it hearing (a crash in between) ends with a line at the next tick', async () => {
      const { workId, message } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      // The answer is recorded, but the work was never moved on (Mousse stopped in between, on an older build).
      f.store.answerEscalation(askId, 'denied')
      await f.bots.maintain()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'nothing_to_wait_for' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'notice', text: 'I stopped "Vacuums": nothing could let it carry on any more. Ask me again if you still want it.', replyTo: { id: message.id } })
      // Once: later ticks say nothing more.
      const rows = chatOf(f, botId).length
      await f.bots.maintain()
      expect(chatOf(f, botId)).toHaveLength(rows)
    })

    it('the startup pass ends waiting work that nothing would wake', async () => {
      const { workId } = await outOfTime()
      f.store.answerEscalation(chatOf(f, botId).at(-1)!.ask!.askId, 'denied')
      f.bots.close()
      f.bots = new BotEngine(f.host)
      await f.bots.reconcileOnStartup()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'nothing_to_wait_for' })
    })

    it('a permission removed while it waits: Allow carries it on under the narrower grant, never the wider one', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      const narrower = (tools: readonly string[]) => tools.filter((tool) => tool !== 'web_fetch')
      f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, tools: narrower(manifest.tools) as typeof manifest.tools, appTools: narrower(manifest.appTools) }))
      expect(f.store.activation(workId)!.grantDigest).toBe(f.store.activeGrant(botId)!.digest)
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'running' })
      const second = await start(f, workId, 2)
      expect(second.prepared.policy.tools!.allow).not.toContain('web_fetch')
      expect(second.prepared.policy.tools!.allow).toContain('web_search')
      expect(errors()).toEqual([])
    })

    it('revoking the bot\'s grant ends its waiting work and withdraws its ask; approving again brings nothing back', async () => {
      const { workId, message } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      f.bots.revoke(botId)
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'cancelled', endReason: 'grant_revoked' })
      expect(f.store.openAsks(botId)).toEqual([])
      expect(chatOf(f, botId).find((row) => row.ask?.askId === askId)!.ask).toMatchObject({ status: 'withdrawn' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'notice', text: 'I stopped "Vacuums": my permissions changed.', replyTo: { id: message.id } })
      expect(summary().work).toBeUndefined()
      f.bots.approve(botId, botManifestDigest(f.bots.get(botId).published!.permissions))
      await expect(f.bots.service.answer(botId, askId, 'allow')).rejects.toMatchObject({ code: 'ask_answered' })
      await f.bots.maintain()
      expect(f.store.dispatches(workId)).toHaveLength(1)
    })

    /** Work asked for with `id` that runs its hour out (as `outOfTime`), while the run lane was free. */
    async function outOfTimeAs(text: string, id: string) {
      const work = await asked(text, id)
      const turn = await start(f, work.workId)
      f.clock.now += 60 * MIN
      turn.prepared.authority.check(call)
      deadline()
      await finish(f, turn.payload, 'interrupted', { text: `What ${id} had.`, outcome: { interruptedBy: 'bot_wall' } })
      expect(f.store.activation(work.workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      return work.workId
    }

    it('one Allow carries on every piece that waits on that limit, one after the other, and the card says how many', async () => {
      const first = await outOfTimeAs('First job', 'm1')
      const second = await outOfTimeAs('Second job', 'm2')
      const ask = f.store.openAsks(botId)[0]!
      expect(ask.activationId).toBe(second)
      await f.bots.service.answer(botId, ask.id, 'allow')
      await flush()
      expect(f.store.activation(first)).toMatchObject({ status: 'running' })
      expect(f.store.activation(second)).toMatchObject({ status: 'blocked', endReason: 'room_allowed' })
      await runDispatch(f, first, 2, { text: 'First done.' })
      expect(f.store.activation(second)).toMatchObject({ status: 'running' })
      await runDispatch(f, second, 2, { text: 'Second done.' })
      const card = chatOf(f, botId).find((row) => row.ask?.askId === ask.id)!.ask!
      expect(card).toMatchObject({ status: 'allowed', carriesOn: true, carried: 2 })
    })

    it('an Allow carries on only work that waits on that same limit: a spend limit waits for its own answer', async () => {
      f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 1_000 } }))
      const spend = await asked('Spend job', 'm1')
      const turn = await start(f, spend.workId)
      expect(turn.prepared.authority.spend!.reserve({ inputBound: 1_500, wireCap: 500, floor: 256, price: { input: 0, output: 0 } }, {})).toMatchObject({ ok: false })
      await finish(f, turn.payload, 'interrupted', { text: 'Half of it.', outcome: { interruptedBy: 'bot_wall' } })
      const time = await outOfTimeAs('Time job', 'm2')
      const timeAsk = f.store.openAsks(botId).find((ask) => 'budget' in ask.permission && ask.permission.budget.key === 'maxActiveMs')!
      await f.bots.service.answer(botId, timeAsk.id, 'allow')
      await flush()
      expect(f.store.activation(time)).toMatchObject({ status: 'running' })
      expect(f.store.activation(spend.workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      expect(f.store.dispatches(spend.workId)).toHaveLength(1)
      // Its own answer gives it room: twice the tokens.
      await runDispatch(f, time, 2, { text: 'Time done.' })
      const spendAsk = f.store.openAsks(botId).find((ask) => 'budget' in ask.permission && ask.permission.budget.key === 'maxInputTokens')!
      await f.bots.service.answer(botId, spendAsk.id, 'allow')
      await flush()
      expect(f.store.activation(spend.workId)).toMatchObject({ status: 'running' })
    })

    it('work that waited more than a day is not carried on by an Allow: it ends with one line and can be asked again', async () => {
      const { workId, message } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      f.clock.now += 25 * 60 * MIN
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'waited_too_long' })
      expect(f.store.dispatches(workId)).toHaveLength(1)
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'notice', text: '"Vacuums" waited too long, so I stopped it. Ask me again if you still want it.', replyTo: { id: message.id } })
      // The wider limit stays for later work.
      expect(f.store.activeGrant(botId)!.manifest.budget.maxActiveMs).toBe(120 * MIN)
    })

    it('work that waits more than a week ends at the next tick, whatever it waits for', async () => {
      const { workId } = await outOfTime()
      f.clock.now += 6 * 24 * 60 * MIN
      await f.bots.maintain(new Date(f.clock.now))
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked' })
      f.clock.now += 2 * 24 * 60 * MIN
      await f.bots.maintain(new Date(f.clock.now))
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'waited_too_long' })
      expect(chatOf(f, botId).at(-1)!.text).toBe('"Vacuums" waited too long, so I stopped it. Ask me again if you still want it.')
    })

    it('waiting work counts toward the run lane\'s 20: the oldest is dropped with a line when more is queued', async () => {
      const { workId } = await outOfTime()
      for (let i = 0; i < 20; i += 1) {
        f.clock.now += 1_000
        await f.bots.activate({ botId, input: `Run ${i}`, clientRequestId: `q${i}` })
      }
      // One runs; nineteen wait in the queue, and the waiting work is the twentieth.
      expect(f.store.laneActivations(botId, 'run', ['queued'])).toHaveLength(19)
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked' })
      f.clock.now += 1_000
      await f.bots.activate({ botId, input: 'Run 20', clientRequestId: 'q20' })
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'queue_full' })
      expect(f.store.laneActivations(botId, 'run', ['queued'])).toHaveLength(20)
      expect(chatOf(f, botId).at(-1)!.text).toBe('I had too much waiting, so I dropped "Vacuums". Ask me again when I\'m less busy.')
    })

    it('the owner\'s Continue is refused with a plain message: the work goes on through its ask, and never holds the lane', async () => {
      const { workId } = await outOfTime()
      expect(f.bots.getActivation(workId).canContinue).toBe(false)
      await expect(f.bots.continueActivation(workId)).rejects.toMatchObject({ code: 'bot_work_waiting', message: 'This work ran out of room. Answer its ask to let it carry on, or stop it.' })
      expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'budget_exhausted' })
      expect(f.store.laneActivations(botId, 'run', ['running', 'waiting_grant'])).toEqual([])
      expect(f.store.dispatches(workId)).toHaveLength(1)
    })

    it('the card says it carries the work on only when this answer really did', async () => {
      const { workId } = await outOfTime()
      const askId = chatOf(f, botId).at(-1)!.ask!.askId
      // As an older build left it: the work failed with its limit ask still open.
      f.store.moveActivation(workId, ['blocked'], 'failed', { endReason: 'budget_exhausted' })
      expect(chatOf(f, botId).find((row) => row.ask?.askId === askId)!.ask!.carriesOn).toBeUndefined()
      await f.bots.service.answer(botId, askId, 'allow')
      await flush()
      expect(f.store.dispatches(workId)).toHaveLength(1)
      const card = chatOf(f, botId).find((row) => row.ask?.askId === askId)!.ask!
      expect(card).toMatchObject({ status: 'allowed' })
      expect(card.carriesOn).toBeUndefined()
    })

    it('a scheduled run that runs out of room ends as before: failed, with an ask for later runs', async () => {
      const activation = await f.bots.activate({ botId, input: 'Top science news', clientRequestId: 'r1' })
      const { prepared } = await start(f, activation.id)
      f.clock.now += 60 * MIN
      prepared.authority.check(call)
      deadline()
      expect(f.store.activation(activation.id)).toMatchObject({ status: 'failed', endReason: 'budget_exhausted' })
      expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'notice', text: 'I ran out of room on this run. Pip wants to work for up to 2 hours per run.' })
      expect(chatOf(f, botId).at(-1)!.ask!.carriesOn).toBeUndefined()
    })
  })
})
