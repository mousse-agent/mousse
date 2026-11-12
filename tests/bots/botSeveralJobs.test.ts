/**
 * A bot that is always free: up to three pieces of its work run side by side (and six across a profile), a note
 * reaches running work while it works, and a turn whose context the runtime compacted gets its memory pack and its
 * job's brief again (docs/bots.md, Lanes and The chat and its work).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine, MAX_RUN_SLOTS_PER_BOT, MAX_RUN_SLOTS_PER_PROFILE, noteSteerText } from '../../src/mms/bots/activation/BotEngine'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botInstructions } from '../../src/mms/bots/instructions'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { MAX_QUEUED_ACTIVATIONS } from '../../src/shared/bots/personal/definition'
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
