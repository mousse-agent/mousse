/**
 * A bot that stays free while it works (docs/plans/bot-always-free.md): the chat is the front desk, work runs beside
 * it and reports as a reply, notes reach running work before it reports, reminders are said at their time, and every
 * reply says which message it answers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_WORK_ONLY_TOOLS, BOT_WORK_TOOLS } from '../../src/shared/bots/personal/manifest'
import { BOT_FAILURE_PAUSE_STREAK } from '../../src/mms/bots/activation/BotEngine'
import { reminderLabel, reminderTime } from '../../src/mms/run/mcp/appTools/bots'
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
  it('running work takes the note before it reports: no early message, one report', async () => {
    const first = await chat('Compare vacuums', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, first.activation.id, { title: 'Vacuums', brief: 'Compare vacuums.', key: 'k' })
    await finish(f, first.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    expect(f.bots.tools.work.note(botId, workId, 'Only ones under £200.')).toBe('noted')
    const before = chatOf(f, botId).length
    await finish(f, work.payload, 'completed', { text: 'Here are three under £250.' })
    // Nothing was posted: the work continues with the note.
    expect(chatOf(f, botId)).toHaveLength(before)
    expect(f.store.activation(workId)!.status).toBe('running')
    const continued = await start(f, workId, 2)
    expect(continued.prepared.prompt).toContain('Only ones under £200.')
    expect(continued.prepared.prompt).toContain('report')
    await finish(f, continued.payload, 'completed', { text: 'Here are two under £200.' })
    const reports = chatOf(f, botId).filter((message) => message.kind === 'run_report')
    expect(reports.map((message) => message.text)).toEqual(['Here are two under £200.'])
    expect(f.store.pendingWorkNotes(workId)).toEqual([])
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
