/**
 * A bot's wakes: follow-ups it sets for itself, at a time or when a thread finishes or a pull request merges. When one
 * comes, the bot carries on in its own chat, in a turn no person started (`wake:`), after a quiet line saying why. A wake
 * on an event ends once anyway when the event can't come (closed, archived, deleted, out of sight, past its time). Limits:
 * a chain of at most five with no owner's message between, and thirty a day. A wake starts when it is due, at any hour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerChatTurn } from '../../src/mms/bots/activation/BotEngine'
import { MAX_WAKE_CHAIN, MAX_WAKES_PER_DAY, type BotWakeEvent } from '../../src/shared/bots/personal/wakes'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

const MIN = 60_000
const HOUR = 60 * MIN

let f: BotFixture
let botId: string
/** The thread wakes wait on, as the host reads it now. */
let thread: { state: 'running' | 'idle' | 'archived' | 'deleted' | 'unreachable'; title?: string; lastRun?: { status: string; endedAt?: string } }
/** The pull request wakes wait on, and how often it was read. */
let pr: { state: 'open' | 'closed' | 'merged'; title?: string } | { none: true } | { problem: string }
let prReads: number

beforeEach(async () => {
  f = botFixture()
  thread = { state: 'running', title: 'Fix login' }
  pr = { state: 'open', title: 'Fix login' }
  prReads = 0
  f.host.wakeThread = () => thread
  f.host.pullRequestState = async () => {
    prReads += 1
    return pr
  }
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

const wake = (from: string, input: { brief: string; dueAt?: string; event?: BotWakeEvent; hours?: number }) => f.bots.tools.wakes!.add(botId, from, input)
const inMinutes = (minutes: number) => new Date(f.clock.now + minutes * MIN).toISOString()
/** The chat turn a wake started, if any. */
const wakeTurn = (wakeId: string) => f.store.listActivations(botId).find((row) => row.idempotencyKey === `wake:${wakeId}`)
const fireDue = async () => {
  for (const timer of f.timers.splice(0)) timer.fn()
  await flush()
}
/** The quiet line a wake leaves above the bot's reply. */
const lineOf = (wakeId: string) => chatOf(f, botId).find((message) => message.id === `bm_wake_${wakeId}`)

describe('a wake at a time', () => {
  it('starts a chat turn of the bot\'s own at its time, after a quiet line, with what it wrote for itself; once', async () => {
    const turn = await chat('Check the deploy in 20 minutes', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Check whether the deploy finished and tell them.', dueAt: inMinutes(20) })
    await finish(f, turn.payload, 'completed', { text: 'I\'ll check in 20 minutes.' })
    expect(f.bots.tools.reminders.list(botId)).toEqual([{ reminderId: set.wakeId, dueAt: set.dueAt, text: 'Check whether the deploy finished and tell them.', wake: 'at its time' }])
    f.clock.now += 19 * MIN
    await f.bots.deliverDueReminders()
    expect(wakeTurn(set.wakeId)).toBeUndefined()
    f.clock.now += MIN
    await fireDue()
    const row = wakeTurn(set.wakeId)!
    expect(row.lane).toBe('chat')
    // Not the owner's turn: it can't start, message or stop their threads.
    expect(ownerChatTurn(row)).toBe(false)
    expect(lineOf(set.wakeId)).toMatchObject({ kind: 'notice', systemLine: true, text: 'Following up' })
    const { prepared } = await start(f, row.id)
    expect(prepared.prompt).toContain('[Mousse] A wake-up you set at')
    expect(prepared.prompt).toContain('Check whether the deploy finished and tell them.')
    expect(f.bots.tools.reminders.list(botId)).toEqual([])
    await f.bots.deliverDueReminders()
    expect(f.store.listActivations(botId).filter((entry) => entry.idempotencyKey.startsWith('wake:'))).toHaveLength(1)
  })

  it('is not held for the night: one due at 23:00 (this computer\'s time) starts at 23:00', async () => {
    f.clock.now = new Date(2026, 10, 7, 21, 30).getTime()
    const turn = await chat('Look at it again in 90 minutes', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Look at the logs again.', dueAt: inMinutes(90) })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    f.clock.now = new Date(2026, 10, 7, 23, 0).getTime()
    await f.bots.deliverDueReminders()
    expect(wakeTurn(set.wakeId)).toBeDefined()
    expect(f.store.reminder(set.wakeId)?.status).toBe('delivered')
  })

  it('a paused bot does not follow up: the wake is said as a line, and no turn starts', async () => {
    const turn = await chat('Ping me back', 'm1')
    const set = await wake(turn.activation.id, { brief: 'See if they replied.', dueAt: inMinutes(5) })
    await finish(f, turn.payload, 'completed', { text: 'Sure.' })
    f.bots.pauseBot(botId)
    f.clock.now += 5 * MIN
    await f.bots.deliverDueReminders()
    expect(wakeTurn(set.wakeId)).toBeUndefined()
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'run_report', text: 'Following up. I didn\'t follow up on this: I\'m paused.\n\nSee if they replied.' })
    expect(f.store.waitingReminders(botId)).toEqual([])
  })
})

describe('a wake on an event', () => {
  it('on a thread: fires when its run ends, with the thread and its status', async () => {
    const turn = await chat('Tell me when the login thread is done', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Read what it changed and sum it up.', event: { kind: 'thread', threadId: 't1' } })
    await finish(f, turn.payload, 'completed', { text: 'I\'ll tell you.' })
    expect(set.label).toBe('when "Fix login" finishes')
    // Still working: nothing yet.
    f.bots.threadRunEnded('t1')
    await flush()
    expect(wakeTurn(set.wakeId)).toBeUndefined()
    thread = { state: 'idle', title: 'Fix login', lastRun: { status: 'completed', endedAt: new Date(f.clock.now).toISOString() } }
    f.bots.threadRunEnded('t1')
    await flush()
    await fireDue()
    const row = wakeTurn(set.wakeId)!
    expect(lineOf(set.wakeId)?.text).toBe('Following up · "Fix login" finished')
    const { prepared } = await start(f, row.id)
    expect(prepared.prompt).toContain('thread t1 ("Fix login") finished its turn (status: completed)')
    expect(prepared.prompt).toContain('Read what it changed and sum it up.')
  })

  it('on a pull request: fires when it merges, reading it at most every two minutes', async () => {
    const turn = await chat('Tell me when #12 merges', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Tell them it shipped.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    expect(set.label).toBe('when acme/app#12 merges')
    const readsAtSet = prReads
    await f.bots.maintain(new Date(f.clock.now))
    await f.bots.maintain(new Date(f.clock.now + 30_000))
    expect(prReads).toBe(readsAtSet + 1)
    pr = { state: 'merged', title: 'Fix login' }
    f.clock.now += 2 * MIN
    await f.bots.maintain(new Date(f.clock.now))
    const row = wakeTurn(set.wakeId)!
    expect(lineOf(set.wakeId)?.text).toBe('Following up · acme/app#12 merged')
    const { prepared } = await start(f, row.id)
    expect(prepared.prompt).toContain('pull request acme/app#12 ("Fix login") merged')
  })

  // Every way a wake on an event ends without it: it still wakes, once, saying why.
  it.each([
    ['the pull request is closed', { kind: 'pr', repo: 'acme/app', number: 12 } as BotWakeEvent, () => { pr = { state: 'closed' } }, 'the pull request was closed without merging'],
    ['the thread is archived', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { thread = { state: 'archived' } }, 'the thread was archived'],
    ['the thread is deleted', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { thread = { state: 'deleted' } }, 'the thread was deleted'],
    ['the thread goes out of the bot\'s sight', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { thread = { state: 'unreachable' } }, 'you can no longer see that thread'],
    ['its time passes first', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { f.clock.now += 3 * HOUR }, 'it didn\'t happen in time']
  ])('ends without it when %s, and wakes once saying why', async (_name, event, happen, reason) => {
    const turn = await chat('Watch it', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Say what happened.', event, hours: 2 })
    await finish(f, turn.payload, 'completed', { text: 'Watching.' })
    happen()
    f.clock.now += 2 * MIN
    await f.bots.maintain(new Date(f.clock.now))
    const row = wakeTurn(set.wakeId)!
    expect(lineOf(set.wakeId)?.text).toBe(`Following up · ${reason}`)
    const { prepared } = await start(f, row.id)
    expect(prepared.prompt).toContain(`ended without it: ${reason}.`)
    await f.bots.maintain(new Date(f.clock.now + 10 * MIN))
    expect(f.store.listActivations(botId).filter((entry) => entry.idempotencyKey.startsWith('wake:'))).toHaveLength(1)
  })

  it.each([
    ['a thread that is not working', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { thread = { state: 'idle', lastRun: { status: 'completed' } } }, "isn't working now"],
    ['a thread the bot can\'t see', { kind: 'thread', threadId: 't1' } as BotWakeEvent, () => { thread = { state: 'unreachable' } }, 'not available to you'],
    ['a pull request already merged', { kind: 'pr', repo: 'acme/app', number: 12 } as BotWakeEvent, () => { pr = { state: 'merged' } }, 'merged already'],
    ['a repository that is not a project', { kind: 'pr', repo: 'other/app', number: 3 } as BotWakeEvent, () => { pr = { none: true } }, "not one of your owner's projects"]
  ])('is refused on %s', async (_name, event, before, words) => {
    const turn = await chat('Watch it', 'm1')
    before()
    await expect(wake(turn.activation.id, { brief: 'Say what happened.', event })).rejects.toThrow(words)
    expect(f.store.waitingReminders(botId)).toEqual([])
  })
})

describe('limits', () => {
  it('at most five wakes in a row without the owner; the owner\'s next message starts a new chain', async () => {
    let turn = await chat('Keep an eye on the build', 'm1')
    let from = turn.activation.id
    let payload = turn.payload
    for (let n = 1; n <= MAX_WAKE_CHAIN; n += 1) {
      const set = await wake(from, { brief: `Look again (${n}).`, dueAt: inMinutes(1) })
      await finish(f, payload, 'completed', { text: 'Still going.' })
      f.clock.now += MIN
      await f.bots.deliverDueReminders()
      const row = wakeTurn(set.wakeId)!
      const started = await start(f, row.id)
      expect(started.prepared.prompt).toContain(`This is wake-up ${n} of at most ${MAX_WAKE_CHAIN}`)
      from = row.id
      payload = started.payload
    }
    await expect(wake(from, { brief: 'Once more.', dueAt: inMinutes(1) })).rejects.toThrow(`${MAX_WAKE_CHAIN} times in a row`)
    await finish(f, payload, 'completed', { text: 'Done watching.' })
    turn = await chat('Carry on watching', 'm2')
    await expect(wake(turn.activation.id, { brief: 'Look again.', dueAt: inMinutes(1) })).resolves.toMatchObject({ wakeId: expect.any(String) })
  })

  it(`at most ${MAX_WAKES_PER_DAY} a day, cancelled ones included; a day later there is room again`, async () => {
    const turn = await chat('Lots of follow-ups', 'm1')
    for (let n = 0; n < MAX_WAKES_PER_DAY; n += 1) {
      const set = await wake(turn.activation.id, { brief: `Follow up ${n}.`, dueAt: inMinutes(60) })
      expect(f.bots.tools.reminders.cancel(botId, set.wakeId)).toBe(true)
    }
    await expect(wake(turn.activation.id, { brief: 'One more.', dueAt: inMinutes(60) })).rejects.toThrow(`${MAX_WAKES_PER_DAY} wake-ups in the last 24 hours`)
    f.clock.now += 24 * HOUR + MIN
    await expect(wake(turn.activation.id, { brief: 'One more.', dueAt: inMinutes(60) })).resolves.toMatchObject({ wakeId: expect.any(String) })
  })

  it('only the chat sets wakes: work is refused', async () => {
    const turn = await chat('Research this', 'm1')
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Research', brief: 'Look it up.', key: 'k1' })
    await expect(wake(workId, { brief: 'Look again.', dueAt: inMinutes(5) })).rejects.toThrow('Only your chat')
  })
})

describe('About → Runs', () => {
  it('lists a wake with what it waits for, and one cancelled there never fires', async () => {
    const turn = await chat('Tell me when #12 merges', 'm1')
    const set = await wake(turn.activation.id, { brief: 'Tell them it shipped.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    expect(f.bots.service.get(botId).reminders).toEqual([{ id: set.wakeId, dueAt: set.dueAt, text: 'Tell them it shipped.', wake: 'when acme/app#12 merges' }])
    f.bots.service.reminderCancel(botId, set.wakeId)
    pr = { state: 'merged' }
    f.clock.now += 3 * MIN
    await f.bots.maintain(new Date(f.clock.now))
    expect(wakeTurn(set.wakeId)).toBeUndefined()
    expect(lineOf(set.wakeId)).toBeUndefined()
  })
})
