/**
 * A bot that is always free: up to three pieces of its work run side by side (and six across a profile), a note
 * reaches running work while it works, and a turn whose context the runtime compacted gets its memory pack and its
 * job's brief again (docs/bots.md, Lanes and The chat and its work).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine, MAX_BACKGROUND_SLOTS_PER_BOT, MAX_BACKGROUND_SLOTS_PER_PROFILE, MAX_RUN_SLOTS_PER_BOT, MAX_RUN_SLOTS_PER_PROFILE, NOTE_REPEAT_LINE, noteSteerText } from '../../src/mms/bots/activation/BotEngine'
import { BOT_COMPACTION_HOLD_MS, type PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botInstructions } from '../../src/mms/bots/instructions'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { SteerHold } from '../../src/mms/orchestrator/steerHold'
import { BOT_SCHEDULE_SKIP_TEXT, MAX_QUEUED_ACTIVATIONS } from '../../src/shared/bots/personal/definition'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', description: 'Keep my day in order.', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

const MIN = 60_000
const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
const summaryOf = (id = botId) => f.bots.service.list().bots.find((bot) => bot.id === id)!
const runningWork = (id = botId) => f.store.laneActivations(id, 'run', ['running']).map((row) => row.id)

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string, bot = botId) {
  const { message } = await f.bots.service.chatSend({ botId: bot, text, clientRequestId: id })
  const activation = f.store.laneActivations(bot, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

/** One chat turn hands off each title as work and ends; the work ids, in order. */
async function handOff(titles: string[], id: string, bot = botId) {
  const turn = await chat(`Do ${titles.join(', ')}`, id, bot)
  const started = []
  for (const title of titles) {
    // A second apart, so "oldest first" has one answer.
    f.clock.now += 1_000
    started.push(await f.bots.tools.work.start(bot, turn.activation.id, { title, brief: `Do ${title}.`, key: `${id}:${title}` }))
  }
  await finish(f, turn.payload, 'completed', { text: 'On it.' })
  return { message: turn.message, chat: turn.activation.id, work: started }
}

describe('several pieces of work at once', () => {
  it('runs three at once beside the chat, lists each above the composer, and a fourth waits for a slot', async () => {
    const { work } = await handOff(['Long research', 'Weather', 'Train times', 'Recipes'], 'm1')
    expect(work.map((item) => item.status)).toEqual(['started', 'started', 'started', 'queued'])
    expect(work[3]!.ahead).toEqual(['Long research', 'Weather', 'Train times'])
    expect(MAX_RUN_SLOTS_PER_BOT).toBe(3)
    const lines = summaryOf().work!
    expect(lines.map((line) => [line.title, line.status])).toEqual([['Long research', 'running'], ['Weather', 'running'], ['Train times', 'running'], ['Recipes', 'queued']])
    expect(summaryOf()).toMatchObject({ state: 'working', stateText: 'Working on 4 things' })
    // The chat stays free: a message is answered while the three run.
    const next = await chat('What time is it in Tokyo?', 'm2')
    expect(summaryOf().chat).toEqual({ activationId: next.activation.id })
    await finish(f, next.payload, 'completed', { text: 'It is 18:00 there.' })
    // Each runs its own dispatch at once, each with its own deadline and thread.
    const live = await Promise.all(work.slice(0, 3).map((item) => start(f, item.workId)))
    expect(new Set(live.map((entry) => entry.payload.threadId)).size).toBe(3)
    for (const entry of live) expect(entry.prepared.authority.time.deadline() - f.clock.now).toBe(60 * MIN)
    // The quick one ends first; the waiting one starts in its slot while the long one goes on.
    await finish(f, live[1]!.payload, 'completed', { text: 'Sunny.' })
    expect(f.store.activation(work[3]!.workId)!.status).toBe('running')
    expect(f.store.activation(work[0]!.workId)!.status).toBe('running')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Sunny.' })
  })

  it("starts the owner's work first, then a reminder's work, then scheduled runs, oldest first in each", async () => {
    const { work, chat: from } = await handOff(['A', 'B', 'C'], 'm1')
    // A scheduled run, then a reminder's work, then the owner's work wait, in that order of arrival.
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Tidy the notes.', occurrenceAt: new Date(f.clock.now).toISOString() })
    expect(scheduled.kind).toBe('started')
    f.bots.tools.reminders.add(botId, from, { dueAt: new Date(f.clock.now + MIN).toISOString(), text: 'Checking.', work: { title: 'Reminder work', brief: 'Check it.' } })
    f.clock.now += 2 * MIN
    await f.bots.deliverDueReminders()
    f.clock.now += MIN
    const later = await handOff(['Owner work'], 'm2')
    expect(later.work[0]!.status).toBe('queued')
    const order: string[] = []
    for (const done of work) {
      await finish(f, (await start(f, done.workId)).payload, 'completed', { text: 'Done.' })
      const started = f.store.laneActivations(botId, 'run', ['running']).filter((row) => !work.some((item) => item.workId === row.id))
      order.push(...started.map((row) => (row.trigger.kind === 'schedule' ? 'schedule' : row.idempotencyKey.startsWith('reminder:') ? 'reminder' : 'owner')).filter((kind) => !order.includes(kind)))
    }
    expect(order).toEqual(['owner', 'reminder', 'schedule'])
  })

  it("a scheduled run leaves the last free slot to the owner's work that waits for one", async () => {
    const { work } = await handOff(['A', 'B', 'C'], 'm1')
    const live = await Promise.all(work.map((item) => start(f, item.workId)))
    // B ran out of room and the owner allowed more: it goes on once its turn has let go.
    f.store.moveActivation(work[1]!.workId, ['running'], 'blocked', { endReason: 'room_allowed' })
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Tidy.', occurrenceAt: new Date(f.clock.now).toISOString() })
    await flush()
    const id = scheduled.kind === 'started' ? scheduled.activationId : ''
    // A and C hold two slots; the last free one is B's: the schedule waits.
    expect(f.store.activation(id)!.status).toBe('queued')
    await finish(f, live[1]!.payload, 'completed', { text: 'B so far.' })
    expect(f.store.activation(work[1]!.workId)!.status).toBe('running')
    expect(f.store.activation(id)!.status).toBe('queued')
    // With a slot free and no owner work waiting for it, the schedule starts.
    await finish(f, live[0]!.payload, 'completed', { text: 'A done.' })
    expect(f.store.activation(id)!.status).toBe('running')
  })

  it("runs at most six pieces across the profile's bots; the rest wait and say so, and start as slots free", async () => {
    expect(MAX_RUN_SLOTS_PER_PROFILE).toBe(6)
    const other = (await createBot(f, { name: 'Ada', reply: 'Hi.' })).botId
    const third = (await createBot(f, { name: 'Bo', reply: 'Hi.' })).botId
    const mine = await handOff(['A1', 'A2', 'A3'], 'm1')
    const theirs = await handOff(['B1', 'B2', 'B3'], 'm2', other)
    const late = await handOff(['C1'], 'm3', third)
    expect(mine.work.every((item) => item.status === 'started') && theirs.work.every((item) => item.status === 'started')).toBe(true)
    expect(late.work[0]).toMatchObject({ status: 'queued', ahead: [expect.stringContaining('other bots')] })
    expect(f.store.laneActivations(third, 'run', ['running'])).toHaveLength(0)
    // A slot of another bot frees: the waiting bot's work starts in it.
    await finish(f, (await start(f, mine.work[0]!.workId)).payload, 'completed', { text: 'Done.' })
    expect(f.store.activation(late.work[0]!.workId)!.status).toBe('running')
    // Stopping one frees a slot too.
    const more = await handOff(['C2'], 'm4', third)
    expect(more.work[0]!.status).toBe('queued')
    await f.bots.service.workStop(other, theirs.work[0]!.workId)
    await flush()
    expect(f.store.activation(more.work[0]!.workId)!.status).toBe('running')
  })

  it('keeps at most 20 pieces, running ones counted: the oldest waiting one is dropped and says so', async () => {
    const titles = Array.from({ length: MAX_QUEUED_ACTIVATIONS + 1 }, (_, index) => `Job ${index}`)
    const { work } = await handOff(titles, 'm1')
    expect(runningWork()).toHaveLength(3)
    // 3 running + 17 waiting = 20: the 21st dropped the oldest waiting piece (Job 3), never a running one.
    expect(f.store.activation(work[3]!.workId)).toMatchObject({ status: 'cancelled', endReason: 'queue_full' })
    expect(work.slice(0, 3).every((item) => f.store.activation(item.workId)!.status === 'running')).toBe(true)
    expect(f.store.laneActivations(botId, 'run', ['queued'])).toHaveLength(MAX_QUEUED_ACTIVATIONS - 3)
    expect(chatOf(f, botId).some((message) => message.error?.text.includes('"Job 3"'))).toBe(true)
  })

  it("scheduled runs hold at most 2 of a bot's 3 slots: the owner's work starts at once in the one kept for it", async () => {
    expect(MAX_BACKGROUND_SLOTS_PER_BOT).toBe(2)
    const ids = ['s1', 's2', 's3'].map((scheduleId) => {
      f.clock.now += 1_000
      const run = f.bots.runScheduledOccurrence({ botId, scheduleId, prompt: `Run ${scheduleId}.`, occurrenceAt: new Date(f.clock.now).toISOString() })
      return run.kind === 'started' ? run.activationId : ''
    })
    await flush()
    expect(ids.map((id) => f.store.activation(id)!.status)).toEqual(['running', 'running', 'queued'])
    const { work } = await handOff(['Quick lookup'], 'm1')
    expect(work[0]!.status).toBe('started')
    expect(f.store.activation(work[0]!.workId)!.status).toBe('running')
    expect(runningWork()).toHaveLength(3)
  })

  it("scheduled runs hold at most 4 of the profile's 6 slots, so another bot's owner work starts at once", async () => {
    expect(MAX_BACKGROUND_SLOTS_PER_PROFILE).toBe(4)
    const other = (await createBot(f, { name: 'Ada', reply: 'Hi.' })).botId
    const third = (await createBot(f, { name: 'Bo', reply: 'Hi.' })).botId
    for (const bot of [botId, other, third]) {
      for (const scheduleId of ['s1', 's2']) {
        f.clock.now += 1_000
        f.bots.runScheduledOccurrence({ botId: bot, scheduleId, prompt: 'Tidy.', occurrenceAt: new Date(f.clock.now).toISOString() })
      }
    }
    await flush()
    const running = (bot: string) => f.store.laneActivations(bot, 'run', ['running']).length
    expect([running(botId), running(other), running(third)]).toEqual([2, 2, 0])
    const { work } = await handOff(['Lookup'], 'm1', third)
    expect(work[0]!.status).toBe('started')
    // A schedule ends: the oldest waiting one takes its place, still 4 in all.
    const ended = f.store.laneActivations(botId, 'run', ['running'])[0]!
    await finish(f, (await start(f, ended.id)).payload, 'completed', { text: 'Done.' })
    expect([running(botId), running(other), running(third)]).toEqual([1, 2, 2])
  })

  it("when a slot frees at the profile's limit, the next piece is picked across its bots: another bot's owner work before this bot's schedule", async () => {
    const other = (await createBot(f, { name: 'Ada', reply: 'Hi.' })).botId
    const third = (await createBot(f, { name: 'Bo', reply: 'Hi.' })).botId
    const mine = await handOff(['A1', 'A2', 'A3'], 'm1')
    await handOff(['B1', 'B2', 'B3'], 'm2', other)
    // This bot's scheduled run comes first, then the third bot's owner work: both wait for the profile.
    f.clock.now += 1_000
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Tidy.', occurrenceAt: new Date(f.clock.now).toISOString() })
    const late = await handOff(['C1'], 'm3', third)
    await flush()
    const id = scheduled.kind === 'started' ? scheduled.activationId : ''
    expect(f.store.activation(id)!.status).toBe('queued')
    expect(late.work[0]!.status).toBe('queued')
    // The slot this bot frees goes to the third bot's owner work, not to this bot's own schedule.
    await finish(f, (await start(f, mine.work[0]!.workId)).payload, 'completed', { text: 'Done.' })
    expect(f.store.activation(late.work[0]!.workId)!.status).toBe('running')
    expect(f.store.activation(id)!.status).toBe('queued')
  })

  it('a restart with the profile at its limit (three live on this bot) carries each piece on once and starts nothing over it', async () => {
    const other = (await createBot(f, { name: 'Ada', reply: 'Hi.' })).botId
    const third = (await createBot(f, { name: 'Bo', reply: 'Hi.' })).botId
    const mine = await handOff(['A1', 'A2', 'A3'], 'm1')
    const theirs = await handOff(['B1', 'B2', 'B3'], 'm2', other)
    const late = await handOff(['C1'], 'm3', third)
    const all = [...mine.work, ...theirs.work]
    const live = await Promise.all(all.map((item) => start(f, item.workId)))
    f.clock.now += 5 * MIN
    for (const entry of live) f.runs.markTerminal(entry.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    for (const [index, item] of all.entries()) {
      expect(f.store.dispatch(item.workId, 2)).toMatchObject({ kind: 'continue', threadId: live[index]!.payload.threadId })
      expect(f.store.dispatch(item.workId, 2)!.prompt.text).toContain('Mousse restarted while you were working.')
    }
    expect(f.store.activation(late.work[0]!.workId)!.status).toBe('queued')
    await f.bots.reconcileOnStartup()
    expect(all.map((item) => f.store.dispatches(item.workId).length)).toEqual([2, 2, 2, 2, 2, 2])
    // A slot frees: the waiting piece starts in it.
    await finish(f, (await start(f, mine.work[0]!.workId, 2)).payload, 'completed', { text: 'Done.' })
    expect(f.store.activation(late.work[0]!.workId)!.status).toBe('running')
  })

  it('a scheduled run dropped from a full queue says why on its automation, and the chat says so once a day', async () => {
    const schedules = ['Inbox.', 'News.'].map((prompt) => f.book.add(botId, { when: { kind: 'interval', minutes: 60 }, prompt }, 'owner'))
    await handOff(['A', 'B', 'C'], 'm1')
    // Both schedules' runs wait behind the three pieces running.
    const ids = schedules.map((entry) => {
      f.clock.now += 1_000
      const run = f.bots.runScheduledOccurrence({ botId, scheduleId: entry.scheduleId, prompt: entry.prompt, occurrenceAt: new Date(f.clock.now).toISOString() })
      return run.kind === 'started' ? run.activationId : ''
    })
    await flush()
    expect(ids.map((id) => f.store.activation(id)!.status)).toEqual(['queued', 'queued'])
    // 17 more pieces: 3 running and 19 waiting is two over 20, so the two oldest that wait, the scheduled runs, go.
    await handOff(Array.from({ length: 17 }, (_, index) => `Job ${index}`), 'm2')
    for (const id of ids) expect(f.store.activation(id)).toMatchObject({ status: 'cancelled', endReason: 'queue_full' })
    for (const entry of schedules) expect(f.book.get(botId, entry.scheduleId)!.skip).toEqual({ at: expect.any(String), reason: 'dropped_queue_full' })
    expect(BOT_SCHEDULE_SKIP_TEXT.dropped_queue_full).toBe('dropped: the bot had too much waiting')
    expect(chatOf(f, botId).filter((message) => message.error?.text.includes('dropping some of my scheduled runs'))).toHaveLength(1)
  })

  it("only the same schedule's previous run skips it; other runs and the owner's work run beside it", async () => {
    await handOff(['Owner work'], 'm1')
    const first = f.bots.runScheduledOccurrence({ botId, scheduleId: 'inbox', prompt: 'Inbox.', occurrenceAt: new Date(f.clock.now).toISOString() })
    expect(first.kind).toBe('started')
    await flush()
    const other = f.bots.runScheduledOccurrence({ botId, scheduleId: 'news', prompt: 'News.', occurrenceAt: new Date(f.clock.now).toISOString() })
    expect(other.kind).toBe('started')
    await flush()
    expect(runningWork()).toHaveLength(3)
    f.clock.now += 10 * MIN
    expect(f.bots.runScheduledOccurrence({ botId, scheduleId: 'inbox', prompt: 'Inbox.', occurrenceAt: new Date(f.clock.now).toISOString() })).toEqual({ kind: 'skipped', reason: 'previous_run_still_running' })
    // Its previous run waiting for the internet skips it too, as before.
    const inbox = first.kind === 'started' ? first.activationId : ''
    f.store.setOffline(inbox, true)
    expect(f.bots.runScheduledOccurrence({ botId, scheduleId: 'inbox', prompt: 'Inbox.', occurrenceAt: new Date(f.clock.now + 1).toISOString() })).toEqual({ kind: 'skipped', reason: 'waiting_for_internet' })
  })
})

describe('what assumed one live run, with two pieces live', () => {
  it('failures: two failed scheduled runs count two, and work never counts; a usage limit counts nothing and says it once', async () => {
    const a = f.bots.runScheduledOccurrence({ botId, scheduleId: 's1', prompt: 'One.', occurrenceAt: new Date(f.clock.now).toISOString() })
    const b = f.bots.runScheduledOccurrence({ botId, scheduleId: 's2', prompt: 'Two.', occurrenceAt: new Date(f.clock.now).toISOString() })
    await flush()
    const ids = [a, b].map((entry) => (entry.kind === 'started' ? entry.activationId : ''))
    const live = await Promise.all(ids.map((id) => start(f, id)))
    // One limited entry stops both: neither counts as a failure, and the bot says it is paused once.
    const until = new Date(f.clock.now + 60 * MIN).toISOString()
    f.candidates = [f.candidates[0]!]
    for (const entry of live) await finish(f, entry.payload, 'failed', { outcome: { error: 'provider_usage_limit', usageLimitUntil: until } })
    // Each retried on no other candidate, so each ended at the limit.
    expect(ids.map((id) => f.store.activation(id)!.endReason)).toEqual(['usage_limit', 'usage_limit'])
    expect(f.store.registry(botId)).toMatchObject({ pausedReason: 'usage_limit', failureStreak: 0 })
    expect(chatOf(f, botId).filter((message) => message.error?.text.startsWith('Paused until'))).toHaveLength(1)
  })

  it('asks: two pieces refused the same permission make one ask, and an Allow reaches both when their turns end', async () => {
    const { work } = await handOff(['Check a', 'Check b'], 'm1')
    const [a, b] = await Promise.all(work.map((item) => start(f, item.workId)))
    expect(a!.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { askId: expect.any(String) } })
    expect(b!.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, refused: { askId: expect.any(String) } })
    expect(f.store.escalations({ botId }).filter((row) => row.fingerprint === askFingerprintOf({ tool: 'shell' }))).toHaveLength(1)
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    for (const entry of [a!, b!]) await finish(f, entry.payload, 'completed', { text: 'Skipped the command.' })
    for (const item of work) {
      expect(f.store.activation(item.workId)!.status).toBe('running')
      const continued = await start(f, item.workId, 2)
      expect(continued.prepared.authority.check(command('ls'))).toEqual({ ok: true })
      await finish(f, continued.payload, 'completed', { text: 'Ran it.' })
    }
  })

  it('stop, the internet, work_list and the status line: each piece is its own', async () => {
    const { work } = await handOff(['A', 'B', 'C'], 'm1')
    const live = await Promise.all(work.map((item) => start(f, item.workId)))
    f.store.setOffline(work[0]!.workId, true)
    expect(summaryOf()).toMatchObject({ stateText: 'Working on 3 things' })
    expect(summaryOf().waiting).toBeUndefined()
    expect(f.bots.tools.work.list(botId).now.map((item) => item.status)).toEqual(['waiting_for_internet', 'running', 'running'])
    // Stop on one piece: the others carry on, and its slot frees.
    await f.bots.service.workStop(botId, work[1]!.workId)
    expect(f.store.activation(work[1]!.workId)!.status).toBe('cancelled')
    expect(f.stopped).toEqual([live[1]!.payload.threadId])
    expect([work[0], work[2]].map((item) => f.store.activation(item!.workId)!.status)).toEqual(['running', 'running'])
    expect(summaryOf().work!.map((line) => line.title)).toEqual(['A', 'C'])
  })

  it('a restart with two pieces live carries each on once, in its own thread', async () => {
    const { work } = await handOff(['A', 'B'], 'm1')
    const live = await Promise.all(work.map((item) => start(f, item.workId)))
    f.clock.now += 5 * MIN
    for (const entry of live) f.runs.markTerminal(entry.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    for (const [index, item] of work.entries()) {
      const next = f.store.dispatch(item.workId, 2)!
      expect(next).toMatchObject({ kind: 'continue', threadId: live[index]!.payload.threadId })
      expect(next.prompt.text).toContain('Mousse restarted while you were working.')
      expect(f.store.activation(item.workId)!.status).toBe('running')
    }
    await f.bots.reconcileOnStartup()
    expect(work.map((item) => f.store.dispatches(item.workId).length)).toEqual([2, 2])
  })

  it('delete ends every live piece; pause stops only schedules', async () => {
    // The fixture's runs never end by themselves: the delete gives up waiting for them at once.
    f.host.quiesceTimeoutMs = 50
    const { work } = await handOff(['A', 'B'], 'm1')
    await Promise.all(work.map((item) => start(f, item.workId)))
    f.bots.pauseBot(botId)
    expect(runningWork()).toHaveLength(2)
    expect(f.bots.runScheduledOccurrence({ botId, scheduleId: 's', prompt: 'x', occurrenceAt: new Date(f.clock.now).toISOString() })).toEqual({ kind: 'skipped', reason: 'paused' })
    await f.bots.remove(botId)
    expect(work.map((item) => f.store.activation(item.workId)!.status)).toEqual(['cancelled', 'cancelled'])
  })
})

describe('a note reaches running work while it works', () => {
  /** Work that runs, on a turn whose runtime takes steers (the orchestrator wired its steer). */
  async function runningWithSteer(title = 'Vacuums') {
    const { work, message } = await handOff([title], 'm1')
    const live = await start(f, work[0]!.workId)
    live.prepared.steer!.attached()
    return { workId: work[0]!.workId, message, ...live }
  }

  it('goes in at the next safe point, framed as the owner\'s addition, once; the dispatch reports with it and ends', async () => {
    const work = await runningWithSteer()
    expect(f.bots.tools.work.reach!(botId, work.workId)).toBe('now')
    expect(f.bots.tools.work.note(botId, work.workId, 'Only ones under £200.')).toBe('noted')
    const steer = work.prepared.steer!
    expect(steer.peek()).toBe(noteSteerText(['Only ones under £200.']))
    const taken = steer.take()!
    expect(taken.text).toContain('The owner added this to your job')
    expect(taken.text).toContain('lead with what changed')
    // Taken is not read: nothing else offers it meanwhile.
    expect(steer.peek()).toBeUndefined()
    steer.accepted(taken.token)
    steer.accepted(taken.token)
    expect(f.store.pendingWorkNotes(work.workId)).toEqual([])
    await finish(f, work.payload, 'completed', { text: 'Under £200: two picks. Changed: dropped the £240 one.' })
    // One dispatch: no continuation followed, and its report is the report.
    expect(f.store.dispatches(work.workId)).toHaveLength(1)
    expect(f.store.activation(work.workId)!.status).toBe('done')
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Under £200: two picks. Changed: dropped the £240 one.', replyTo: { id: work.message.id } })
  })

  it('a note the runtime handed back, or never took, reaches the work when its turn ends, once (as before)', async () => {
    const work = await runningWithSteer()
    f.bots.tools.work.note(botId, work.workId, 'Cordless only.')
    const steer = work.prepared.steer!
    steer.handedBack(steer.take()!.token)
    // Back to wait: offered again, and taken again unread when the turn ends.
    steer.take()
    await finish(f, work.payload, 'completed', { text: 'Three picks.' })
    const continued = f.store.dispatch(work.workId, 2)!
    expect(continued.prompt.text.match(/Cordless only\./g)).toHaveLength(1)
    const next = await start(f, work.workId, 2)
    expect(next.prepared.steer!.peek()).toBeUndefined()
    await finish(f, next.payload, 'completed', { text: 'Two cordless picks.' })
    expect(f.store.pendingWorkNotes(work.workId)).toEqual([])
  })

  it('on a runtime that takes no notes while it runs, the chat is told the work gets it when the step ends', async () => {
    const { work } = await handOff(['Vacuums'], 'm1')
    const live = await start(f, work[0]!.workId)
    expect(f.bots.tools.work.reach!(botId, work[0]!.workId)).toBe('step_end')
    f.bots.tools.work.note(botId, work[0]!.workId, 'Cordless only.')
    await finish(f, live.payload, 'completed', { text: 'Three picks.' })
    expect(f.store.dispatch(work[0]!.workId, 2)!.prompt.text).toContain('Cordless only.')
  })

  it('across a restart: one read before it is not sent again, one taken unread goes with the restart once', async () => {
    const work = await runningWithSteer()
    const steer = work.prepared.steer!
    f.bots.tools.work.note(botId, work.workId, 'Read before the crash.')
    steer.accepted(steer.take()!.token)
    f.bots.tools.work.note(botId, work.workId, 'Taken, never read.')
    steer.take()
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    const prompt = f.store.dispatch(work.workId, 2)!.prompt.text
    expect(prompt).not.toContain('Read before the crash.')
    expect(prompt.match(/Taken, never read\./g)).toHaveLength(1)
    // The model may have read it before the crash: it says it may be a repeat, so the work does not redo it.
    expect(prompt).toContain('- (may be a repeat) Taken, never read.')
    expect(prompt).toContain(NOTE_REPEAT_LINE)
    await f.bots.reconcileOnStartup()
    expect(f.store.dispatches(work.workId)).toHaveLength(2)
  })

  it('at least once: a note taken but never reported read goes again marked as a possible repeat; one handed back is no repeat', async () => {
    const work = await runningWithSteer()
    const steer = work.prepared.steer!
    f.bots.tools.work.note(botId, work.workId, 'Cordless only.')
    // The runtime took it and the turn ended before it said the model read it (a result that came first).
    steer.take()
    f.bots.tools.work.note(botId, work.workId, 'Under £200.')
    steer.handedBack(steer.take()!.token)
    await finish(f, work.payload, 'completed', { text: 'Three picks.' })
    const prompt = f.store.dispatch(work.workId, 2)!.prompt.text
    expect(prompt).toContain('- (may be a repeat) Cordless only.')
    expect(prompt).toContain('- Under £200.')
    expect(prompt).not.toContain('(may be a repeat) Under £200.')
    expect(prompt).toContain(NOTE_REPEAT_LINE)
    // A note that never went in says nothing of the kind.
    const next = await start(f, work.workId, 2)
    f.bots.tools.work.note(botId, work.workId, 'Black ones.')
    await finish(f, next.payload, 'completed', { text: 'Two picks.' })
    expect(f.store.dispatch(work.workId, 3)!.prompt.text).not.toContain('may be a repeat')
  })

  it('a forget after a note went in mid-turn removes it from the note, the prompts and a re-give; the run thread keeps what it read', async () => {
    const work = await runningWithSteer('Clinics')
    const second = await chat('Only ones treating condition X-17', 'm2')
    f.bots.tools.work.note(botId, work.workId, 'Only clinics treating condition X-17.', second.activation.id)
    await finish(f, second.payload, 'completed', { text: 'Passed on.' })
    const steer = work.prepared.steer!
    // Delivered mid-turn: the model read it.
    steer.accepted(steer.take()!.token)
    expect(f.store.pendingWorkNotes(work.workId)).toEqual([])
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${second.message.id}`, who: 'owner', text: second.message.text }))
    const row = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${second.message.id}`)!
    memory.forget(botId, { refs: [`j${row.seq as number}`], by: 'owner_ui' })
    expect(f.store.all('SELECT text FROM bot_work_notes WHERE activation_id = ?', work.workId).map((note) => String(note.text)).join('\n')).not.toContain('X-17')
    // After a compaction the work is given what the owner added again: not the forgotten note.
    steer.compacted()
    expect(steer.peek()).toContain('Your context was just summarised')
    expect(steer.peek()).not.toContain('X-17')
    for (const dispatch of f.store.dispatches(work.workId)) expect(dispatch.prompt.text).not.toContain('X-17')
  })

  it('Stop always wins: nothing goes in once the work is stopped, and its notes stay unread', async () => {
    const work = await runningWithSteer()
    f.bots.tools.work.note(botId, work.workId, 'Also check prices.')
    await f.bots.service.workStop(botId, work.workId)
    expect(work.prepared.steer!.peek()).toBeUndefined()
    expect(work.prepared.steer!.take()).toBeUndefined()
    expect(f.store.pendingWorkNotes(work.workId)).toHaveLength(1)
  })

  it('a note whose message the owner forgot goes in without its words', async () => {
    const work = await runningWithSteer('Clinics')
    const second = await chat('Only ones treating condition X-17', 'm2')
    f.bots.tools.work.note(botId, work.workId, 'Only clinics treating condition X-17.', second.activation.id)
    await finish(f, second.payload, 'completed', { text: 'Passed on.' })
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'owner_msg', lane: 'chat', sourceKey: `bm:${second.message.id}`, who: 'owner', text: second.message.text }))
    const row = f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${second.message.id}`)!
    memory.forget(botId, { refs: [`j${row.seq as number}`], by: 'owner_ui' })
    expect(work.prepared.steer!.peek() ?? '').not.toContain('X-17')
  })

  it('with under 30 seconds of the dispatch left, a note waits for its end', async () => {
    const work = await runningWithSteer()
    f.bots.tools.work.note(botId, work.workId, 'One more thing.')
    f.clock.now = work.prepared.authority.time.deadline() - 20_000
    expect(work.prepared.steer!.peek()).toBeUndefined()
    expect(f.bots.tools.work.reach!(botId, work.workId)).toBe('step_end')
  })
})

describe('a compaction that never reports its end', () => {
  it('holds a note at most 3 minutes, and work_note says the work gets it in a few minutes meanwhile', async () => {
    const { work } = await handOff(['Vacuums'], 'm1')
    const live = await start(f, work[0]!.workId)
    const steer = live.prepared.steer!
    steer.attached()
    expect(f.bots.tools.work.reach!(botId, work[0]!.workId)).toBe('now')
    steer.compacting!(true)
    expect(f.bots.tools.work.reach!(botId, work[0]!.workId)).toBe('after_compaction')
    f.clock.now += BOT_COMPACTION_HOLD_MS
    expect(f.bots.tools.work.reach!(botId, work[0]!.workId)).toBe('now')
    // Its end reported: now again at once.
    steer.compacting!(true)
    steer.compacting!(false)
    expect(f.bots.tools.work.reach!(botId, work[0]!.workId)).toBe('now')
  })

  it("a bot turn's hold waits for a compaction no longer than its limit; a person's still waits for the end", () => {
    let now = 0
    const caps = { steer: 'native', steerBoundary: 'start' } as never
    const bot = new SteerHold({ caps, strict: false, foreground: () => [], compactionLimitMs: BOT_COMPACTION_HOLD_MS, now: () => now })
    const person = new SteerHold({ caps, strict: false, foreground: () => [], now: () => now })
    bot.compacting(true)
    person.compacting(true)
    expect(bot.foregroundTools()).toEqual([{ callId: 'compaction', toolName: 'compaction' }])
    now += BOT_COMPACTION_HOLD_MS - 1
    expect(bot.foregroundTools()).toHaveLength(1)
    now += 1
    expect(bot.foregroundTools()).toEqual([])
    expect(person.foregroundTools()).toEqual([{ callId: 'compaction', toolName: 'compaction' }])
  })
})

describe('the bot stays itself through a compaction', () => {
  it('after a compaction its memory pack and brief go in again, once per compaction', async () => {
    const { work } = await handOff(['Vacuums'], 'm1')
    const live = await start(f, work[0]!.workId)
    const steer = live.prepared.steer!
    expect(steer.peek()).toBeUndefined()
    steer.compacted()
    const regive = steer.peek()!
    expect(regive).toContain('Your context was just summarised')
    expect(regive).toContain('<bot_memory>run pack manual</bot_memory>')
    expect(regive).toContain('Do Vacuums.')
    const taken = steer.take()!
    expect(steer.peek()).toBeUndefined()
    steer.accepted(taken.token)
    expect(steer.peek()).toBeUndefined()
    // Two compactions before it went in: given once.
    steer.compacted()
    steer.compacted()
    steer.accepted(steer.take()!.token)
    expect(steer.peek()).toBeUndefined()
    // It counts against nothing: no chat row, no note, no extra dispatch.
    const rows = chatOf(f, botId).length
    await finish(f, live.payload, 'completed', { text: 'Done.' })
    expect(f.store.dispatches(work[0]!.workId)).toHaveLength(1)
    expect(chatOf(f, botId)).toHaveLength(rows + 1)
  })

  it('a re-give handed back waits; one the turn never read is dropped at its end (the next turn carries the pack)', async () => {
    const { work } = await handOff(['Vacuums'], 'm1')
    const live = await start(f, work[0]!.workId)
    const steer = live.prepared.steer!
    steer.compacted()
    steer.handedBack(steer.take()!.token)
    expect(steer.peek()).toContain('Your context was just summarised')
    steer.take()
    await finish(f, live.payload, 'completed', { text: 'Done.' })
    expect(f.store.dispatches(work[0]!.workId)).toHaveLength(1)
  })

  it('the system text is the same on every turn of an activation, and holds no per-turn value', async () => {
    f.host.instructions = botInstructions
    const work = await (async () => {
      const { work: started } = await handOff(['Vacuums'], 'm1')
      return start(f, started[0]!.workId)
    })()
    const first: PreparedBotTurn = work.prepared
    f.bots.tools.work.note(botId, first.activationId, 'Cordless only.')
    f.clock.now += 7 * MIN
    await finish(f, work.payload, 'completed', { text: 'Three picks.' })
    const second = await start(f, first.activationId, 2)
    expect(second.prepared.instructions).toBe(first.instructions)
    expect(first.instructions).toContain('Your name is Pip.')
    // The pack and the request stay out of it: they are in the turn's message.
    expect(first.instructions).not.toContain('bot_memory')
    expect(first.instructions).not.toContain('Do Vacuums.')
    expect(first.instructions).not.toContain(new Date(f.clock.now).toISOString().slice(0, 10))
  })
})
