/**
 * A bot that stays free while it works (docs/plans/bot-always-free.md): the chat is the front desk, work runs beside
 * it and reports as a reply, notes reach running work before it reports, reminders are said at their time, and every
 * reply says which message it answers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_WORK_ONLY_TOOLS, BOT_WORK_TOOLS } from '../../src/shared/bots/personal/manifest'
import { BOT_FAILURE_PAUSE_STREAK, MAX_TURN_CAP_CONTINUATIONS, sayOnce } from '../../src/mms/bots/activation/BotEngine'
import { reminderLabel, reminderTime } from '../../src/mms/run/mcp/appTools/bots'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
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

    it('a runtime that reaches the cap again and again is stopped after a few continuations', async () => {
      const { workId } = await asked()
      for (let n = 1; n <= MAX_TURN_CAP_CONTINUATIONS + 1; n += 1) {
        const turn = await start(f, workId, n)
        f.clock.now += MIN
        turn.prepared.authority.check(call)
        await finish(f, turn.payload, 'failed', { outcome: TURN_CAP })
      }
      expect(f.store.activation(workId)).toMatchObject({ status: 'failed', endReason: 'turn_cap_repeated' })
      expect(errors().at(-1)).toMatchObject({ error: { text: 'I kept going without finishing, so I stopped here.' } })
    })
  })
})
