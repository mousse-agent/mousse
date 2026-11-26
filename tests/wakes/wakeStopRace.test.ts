/**
 * The poll thread wake-ups and bot wake-ups share (`WakeDetector`): a Stop that lands while a wake reads its pull
 * request wins, so nothing resumes; and each wake still fires into its own store (a thread's inbox from
 * `thread-wakes.json`, a bot's `bot_reminders`), even when both wait on the same thread.
 *
 * Orders: the pull request read resolves after the Stop (the race); a thread's run ends with a thread wake and a bot
 * wake both waiting on it; a thread's run ends while the thread still shows it live, and the next starts, while a pull
 * request is still being read; a slow read spans a later wake's deadline (the merge before it, or after it, or with no
 * time), or the next tick; a tick passes a stale time; checks overlap; the store fails to fire one wake, or fails after
 * firing it; the poll closes mid-read. At the deadline: the pull request merged after the last read and before the
 * deadline, with no read under way (it fires), or the last read fails (it gives up, saying so, even when its store
 * fails to take that the first time); one read shows a review before the deadline and a merge after it (the review
 * fires). At a restart, wakes past their deadlines are read one at a time. A read that never answers frees the wakes
 * behind it. A thread's run ended before the wake waiting on it was stored (it fires at the next check).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wakeThreadState, type WakePullRequestState, type WakeThreadState } from '../../src/mms/bots/wakeSources'
import { PR_WAKE_READ_TIMEOUT_MS } from '../../src/mms/wakes/wakeDetector'
import type { ThreadWakePayload } from '../../src/mms/run/types'
import { ThreadWakes } from '../../src/mms/wakes/ThreadWakes'
import { wakeFiredLabel } from '../../src/shared/bots/personal/wakes'
import { botFixture, createBot, flush, runDispatch, start, finish, type BotFixture } from '../bots/botFixture'

type PrRead = WakePullRequestState | { none: true } | { problem: string }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
/** How long a bot's delivery that could not go now waits before it is tried again. */

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
let f: BotFixture
let botId: string
/** How the host reads the pull request and the thread both kinds of wake wait on. */
let prRead: (repo: string, number: number) => Promise<PrRead>
let threadState: WakeThreadState
/** How the thread both kinds of wake wait on stands, for a wake on run `runId`: `threadState` unless a test says. */
let seeThread: (runId?: string) => WakeThreadState
let posts: Array<{ threadId: string; payload: ThreadWakePayload; key: string }>
/** How many of the next posts to a thread's inbox fail. */
let failPosts: number
let threadWakes: ThreadWakes
/** The thread wake-ups' armed timer: the daemon's tick. */
let tick: (() => void) | undefined

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-wake-race-'))
  prRead = async () => ({ state: 'open', title: 'Ship it' })
  threadState = { state: 'running', title: 'Port the parser' }
  seeThread = () => threadState
  posts = []
  failPosts = 0
  f = botFixture()
  f.host.pullRequestState = (repo, number) => prRead(repo, number)
  f.host.wakeThread = (_from, _threadId, runId) => seeThread(runId)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
  threadWakes = newThreadWakes()
})

/** The thread wake-ups kept in `thread-wakes.json` in `dir`, as the daemon starts them. */
function newThreadWakes(): ThreadWakes {
  return new ThreadWakes({
    file: join(dir, 'thread-wakes.json'),
    post: (threadId, payload, key) => {
      if (failPosts > 0) {
        failPosts -= 1
        throw new Error('the inbox could not be written')
      }
      posts.push({ threadId, payload, key })
    },
    threadState: (_from, _threadId, runId) => seeThread(runId),
    pullRequestState: (repo, number) => prRead(repo, number),
    personLastWroteAt: () => undefined,
    threadExists: (threadId) => threadId !== 'gone',
    now: () => f.clock.now,
    setTimer: (callback) => {
      tick = callback
      return {} as ReturnType<typeof setTimeout>
    },
    clearTimer: () => { tick = undefined }
  })
}

afterEach(() => {
  threadWakes.close()
  f.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Work the bot started from its chat, running its first turn. */
async function work() {
  await f.bots.service.chatSend({ botId, text: 'Ship the release', clientRequestId: 'w1' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Release', brief: 'Wait for the merge, then ship.', key: 'w1' })
  await runDispatch(f, chat.id, 1, { text: 'On it.' })
  return { workId, turn: await start(f, workId), chat }
}

describe('a Stop that lands while a wake reads its pull request wins', () => {
  it('a thread\'s wake-up: its thread is stopped mid-read, the pull request merges, and nothing is posted but the quiet cancel', async () => {
    threadWakes.start()
    const set = await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    const read = deferred<PrRead>()
    let reads = 0
    prRead = () => { reads += 1; return read.promise }
    f.clock.now += 3 * 60_000
    // The tick's pass reads the pull request; the person stops the thread meanwhile.
    tick!()
    await settle()
    expect(reads).toBe(1)
    expect(threadWakes.stopThread('t1', true)).toBe(1)
    read.resolve({ state: 'merged', title: 'Ship it' })
    await settle()
    expect(posts.map((post) => post.key)).toEqual([`thread-wake:${set.wakeId}:cancelled`])
    expect(posts[0]!.payload.attention).toBe('none')
    expect(threadWakes.list('t1')).toEqual([])
  })

  it('a bot\'s waiting work: the owner stops it mid-read, the pull request merges, and the work never resumes', async () => {
    const { workId, turn } = await work()
    const set = await f.bots.tools.wakes!.wait!(botId, workId, { brief: 'Ship once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await finish(f, turn.payload, 'completed', { text: '' })
    expect(f.store.activation(workId)).toMatchObject({ status: 'blocked', endReason: 'waiting' })
    const read = deferred<PrRead>()
    let reads = 0
    prRead = () => { reads += 1; return read.promise }
    f.clock.now += 3 * 60_000
    const pass = f.bots.maintain(new Date(f.clock.now))
    await settle()
    expect(reads).toBe(1)
    expect(await f.bots.stopWork(botId, workId)).toBe('stopped')
    read.resolve({ state: 'merged', title: 'Ship it' })
    await pass
    await f.bots.maintain(new Date(f.clock.now + 60_000))
    await flush()
    expect(f.store.reminder(set.wakeId)).toMatchObject({ status: 'cancelled', fired: null })
    expect(f.store.activation(workId)!.status).not.toMatch(/running|queued|blocked/)
    expect(f.store.dispatches(workId)).toHaveLength(1)
  })
})

describe('each wake fires into its own store', () => {
  it('a thread\'s wake and a bot\'s wake on the same thread: its run ends, the thread\'s goes to the thread\'s inbox and the bot\'s to bots.db', async () => {
    threadWakes.start()
    const forThread = await threadWakes.add('t1', { brief: 'Review what t2 wrote.', event: { kind: 'thread', threadId: 't2' } })
    await f.bots.service.chatSend({ botId, text: 'Tell me when t2 is done', clientRequestId: 'm1' })
    const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const turn = await start(f, chat.id)
    const forBot = await f.bots.tools.wakes!.add(botId, chat.id, { brief: 'Tell them t2 is done.', event: { kind: 'thread', threadId: 't2' } })
    await finish(f, turn.payload, 'completed', { text: 'Will do.' })
    // Each store keeps only its own.
    expect(JSON.parse(readFileSync(join(dir, 'thread-wakes.json'), 'utf8')).wakes.map((wake: { id: string }) => wake.id)).toEqual([forThread.wakeId])
    expect(f.store.reminder(forThread.wakeId)).toBeUndefined()

    threadState = { state: 'idle', title: 'Port the parser', lastRun: { status: 'completed' } }
    threadWakes.threadRunEnded('t2')
    f.bots.threadRunEnded('t2')
    await settle()
    await flush()
    expect(posts.map((post) => [post.threadId, post.key])).toEqual([['t1', `thread-wake:${forThread.wakeId}`]])
    expect(f.store.reminder(forBot.wakeId)?.fired).toMatchObject({ kind: 'thread', threadId: 't2', status: 'completed' })
    expect(posts.some((post) => post.key.includes(forBot.wakeId))).toBe(false)
  })
})

/** Counts the reads of each pull request; a number in `answers` answers its own way, the rest as open. */
function reads(answers: Record<number, () => Promise<PrRead>>): Record<number, number> {
  const count: Record<number, number> = {}
  prRead = (_repo, number) => {
    count[number] = (count[number] ?? 0) + 1
    return (answers[number] ?? (async () => ({ state: 'open' as const, title: 'Ship it' })))()
  }
  return count
}

/** A chat turn in which the bot sets each wake, then ends. */
async function botWakes(events: Array<{ brief: string; event: { kind: 'thread'; threadId: string } | { kind: 'pr'; repo: string; number: number }; hours?: number }>) {
  await f.bots.service.chatSend({ botId, text: 'Watch these', clientRequestId: 'm1' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const turn = await start(f, chat.id)
  const set = []
  for (const input of events) {
    set.push(await f.bots.tools.wakes!.add(botId, chat.id, input))
    // Wakes are looked at oldest first: each is set a moment after the one before.
    f.clock.now += 1
  }
  await finish(f, turn.payload, 'completed', { text: 'Will do.' })
  return set
}

describe('a slow pull request read holds nothing else up', () => {
  it('a thread\'s wake on another thread: that run ends and the next starts while a pull request is read, and the wake still sees the end', async () => {
    threadWakes.start()
    await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    const onThread = await threadWakes.add('t3', { brief: 'Review what t2 wrote.', event: { kind: 'thread', threadId: 't2' } })
    const read = deferred<PrRead>()
    const count = reads({ 12: () => read.promise })
    f.clock.now += 3 * 60_000
    tick!()
    await settle()
    expect(count[12]).toBe(1)
    // The run's end is told while its turn still holds the thread, and the next run starts straight after.
    threadWakes.threadRunEnded('t2', { status: 'failed' })
    await settle()
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${onThread.wakeId}`, 'Following up · "Port the parser" failed']])
    read.resolve({ state: 'open', title: 'Ship it' })
    await settle()
  })

  it('a bot\'s wake on a thread: that run ends and the next starts while a pull request is read, and the wake still fires with the end', async () => {
    const [, onThread] = await botWakes([
      { brief: 'Ship once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } },
      { brief: 'Tell them t2 is done.', event: { kind: 'thread', threadId: 't2' } }
    ])
    const read = deferred<PrRead>()
    const count = reads({ 12: () => read.promise })
    f.clock.now += 3 * 60_000
    const pass = f.bots.maintain(new Date(f.clock.now))
    await settle()
    expect(count[12]).toBe(1)
    // The run's end is told while its turn still holds the thread, and the next run starts straight after.
    f.bots.threadRunEnded('t2', { status: 'failed' })
    await settle()
    expect(f.store.reminder(onThread!.wakeId)?.fired).toMatchObject({ kind: 'thread', threadId: 't2', status: 'failed' })
    read.resolve({ state: 'open', title: 'Ship it' })
    await pass
  })

  /**
   * A wake on #13 with six minutes to wait (deadline at +6 min). Its read either waits behind a slow read of #12 until
   * +8 min (`queued`), or starts at +3 min and answers at +8 min. What it shows counts by the host's own time for it.
   */
  const deadlineRows: Array<{ name: string; queued: boolean; mergedAt: number | null; fires: 'merged' | 'expired' }> = [
    { name: 'merged at +5 min, read queued until +8 min: it fires', queued: true, mergedAt: 5, fires: 'merged' },
    { name: 'merged at +7 min, read queued until +8 min: it gives up', queued: true, mergedAt: 7, fires: 'expired' },
    { name: 'merged at +7 min, read started at +3 min: it gives up', queued: false, mergedAt: 7, fires: 'expired' },
    { name: 'merged at +5 min, read started at +3 min: it fires', queued: false, mergedAt: 5, fires: 'merged' },
    // No time from the host: as before, by when the read started.
    { name: 'merged with no time, read queued until +8 min: it gives up', queued: true, mergedAt: null, fires: 'expired' },
    { name: 'merged with no time, read started at +3 min: it fires', queued: false, mergedAt: null, fires: 'merged' }
  ]

  it.each(deadlineRows)('a thread\'s wake past its deadline: $name', async ({ queued, mergedAt, fires }) => {
    threadWakes.start()
    const setAt = f.clock.now
    if (queued) await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    const short = await threadWakes.add('t3', { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 })
    const slow = deferred<PrRead>()
    const merged = { state: 'merged' as const, title: 'Hotfix', ...(mergedAt === null ? {} : { mergedAt: new Date(setAt + mergedAt * 60_000).toISOString() }) }
    const count = reads(queued ? { 12: () => slow.promise, 13: async () => merged } : { 13: () => slow.promise })
    f.clock.now += 3 * 60_000
    tick!()
    await settle()
    f.clock.now = setAt + 8 * 60_000
    slow.resolve(queued ? { state: 'open', title: 'Ship it' } : merged)
    await settle()
    expect(count[13]).toBe(1)
    const label = fires === 'merged' ? wakeFiredLabel({ kind: 'pr', repo: 'acme/app', number: 13, state: 'merged' }) : wakeFiredLabel({ kind: 'ended', reason: 'expired' })
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${short.wakeId}`, label]])
    expect(threadWakes.list('t3')).toEqual([])
  })

  it.each([
    { name: 'merged at +5 min: its deadline timer waits for the read, and it fires', mergedAt: 5, fires: true },
    { name: 'merged at +7 min: it gives up', mergedAt: 7, fires: false }
  ])('a bot\'s wake whose read is queued past its deadline: $name', async ({ mergedAt, fires }) => {
    const setAt = f.clock.now
    const [, short] = await botWakes([
      { brief: 'Ship once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } },
      { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 }
    ])
    const slow = deferred<PrRead>()
    const count = reads({ 12: () => slow.promise, 13: async () => ({ state: 'merged', title: 'Hotfix', mergedAt: new Date(setAt + mergedAt * 60_000).toISOString() }) })
    f.clock.now += 3 * 60_000
    const pass = f.bots.maintain(new Date(f.clock.now))
    for (let i = 0; i < 20 && !count[12]; i++) await settle()
    expect(count[12]).toBe(1)
    // The deadline passes while #12 is read, and the wake's own timer comes.
    f.clock.now = setAt + 8 * 60_000
    await f.bots.deliverDueReminders(new Date(f.clock.now))
    expect(f.store.reminder(short!.wakeId)?.status).toBe('waiting')
    slow.resolve({ state: 'open', title: 'Ship it' })
    await pass
    expect(count[13]).toBe(1)
    await f.bots.maintain(new Date(f.clock.now))
    await flush()
    const row = f.store.reminder(short!.wakeId)!
    expect(row.status).toBe('delivered')
    if (fires) expect(row.fired).toMatchObject({ kind: 'pr', number: 13, state: 'merged' })
    else expect(row.fired).toBeNull()
  })

  it('a bot\'s wake: a tick that passes a stale time does not bring its pull request\'s next read forward', async () => {
    await botWakes([{ brief: 'Ship once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } }])
    const count = reads({})
    f.clock.now += 10 * 60_000
    // Maintenance delayed by five minutes still says the time it was due.
    await f.bots.maintain(new Date(f.clock.now - 5 * 60_000))
    expect(count[12]).toBe(1)
    f.clock.now += 60_000
    await f.bots.maintain(new Date(f.clock.now))
    expect(count[12]).toBe(1)
    f.clock.now += 61_000
    await f.bots.maintain(new Date(f.clock.now))
    expect(count[12]).toBe(2)
  })

  it('overlapping checks: a later check\'s reads wait their turn, one that ends never frees a wake a later check holds, and none is read twice at once', async () => {
    await botWakes([
      { brief: 'Ship once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } },
      { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 } }
    ])
    const first = deferred<PrRead>()
    const second = deferred<PrRead>()
    let reads12 = 0
    let live12 = 0
    let most12 = 0
    const count = reads({
      12: async () => {
        reads12 += 1
        if (reads12 === 1) return { state: 'open', title: 'Ship it' }
        live12 += 1
        most12 = Math.max(most12, live12)
        try { return reads12 === 2 ? await second.promise : { state: 'open' as const, title: 'Ship it' } } finally { live12 -= 1 }
      },
      13: () => count[13] === 1 ? first.promise : Promise.resolve({ state: 'open' as const, title: 'Hotfix' })
    })
    // Check A reads #12 at once and is held on #13.
    f.clock.now += 3 * 60_000
    const a = f.bots.checkWakeEvents(new Date(f.clock.now))
    await settle()
    // Check B, three minutes on: #12 is due again, and its read waits behind A's; #13 is still A's.
    f.clock.now += 3 * 60_000
    const b = f.bots.checkWakeEvents(new Date(f.clock.now))
    await settle()
    expect(count).toEqual({ 12: 1, 13: 1 })
    // A ends; B reads #12 now, and its read is held.
    first.resolve({ state: 'open', title: 'Hotfix' })
    await a
    await settle()
    expect(count).toEqual({ 12: 2, 13: 1 })
    f.clock.now += 3 * 60_000
    const c = f.bots.checkWakeEvents(new Date(f.clock.now))
    await settle()
    expect(count[12]).toBe(2)
    expect(most12).toBe(1)
    second.resolve({ state: 'open', title: 'Ship it' })
    await Promise.all([b, c])
  })

  it('each pull request\'s next read is timed from when its own read started, not from the start of the tick', async () => {
    threadWakes.start()
    await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await threadWakes.add('t3', { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 } })
    const read = deferred<PrRead>()
    const count = reads({ 12: () => read.promise })
    f.clock.now += 3 * 60_000
    const tickAt = f.clock.now
    tick!()
    await settle()
    f.clock.now += 90_000
    read.resolve({ state: 'open', title: 'Ship it' })
    await settle()
    expect(count).toEqual({ 12: 1, 13: 1 })
    // Two minutes after the first tick, but only 31 s after #13 was read.
    const again = reads({})
    f.clock.now = tickAt + 121_000
    tick!()
    await settle()
    expect(again).toEqual({ 12: 1 })
  })

  it('the bot store failing to fire one wake leaves the others to fire, and the one that fired is delivered', async () => {
    const [first, second] = await botWakes([
      { brief: 'Tell them t2 is done.', event: { kind: 'thread', threadId: 't2' } },
      { brief: 'Then check its tests.', event: { kind: 'thread', threadId: 't2' } }
    ])
    const fireWake = f.store.fireWake.bind(f.store)
    f.store.fireWake = (id, fired, dueAt) => {
      if (id === first!.wakeId) throw new Error('database is locked')
      return fireWake(id, fired, dueAt)
    }
    const timers = f.timers.length
    threadState = { state: 'idle', title: 'Port the parser', lastRun: { status: 'completed' } }
    f.bots.threadRunEnded('t2')
    await settle()
    expect(f.store.reminder(first!.wakeId)).toMatchObject({ status: 'waiting', fired: null })
    expect(f.store.reminder(second!.wakeId)?.fired).toMatchObject({ kind: 'thread', threadId: 't2' })
    // The delivery timer was armed for the one that fired; delivering it takes it out of waiting.
    const armed = f.timers.slice(timers).at(-1)
    expect(armed?.ms).toBe(0)
    armed!.fn()
    await flush()
    expect(f.store.reminder(second!.wakeId)!.status).not.toBe('waiting')
  })

  it('a bot\'s wake that fired is delivered at once, even when telling of the change fails', async () => {
    const [onThread] = await botWakes([{ brief: 'Tell them t2 is done.', event: { kind: 'thread', threadId: 't2' } }])
    const openAsks = f.store.openAsks.bind(f.store)
    f.store.openAsks = () => { throw new Error('database is locked') }
    const timers = f.timers.length
    try {
      f.bots.threadRunEnded('t2', { status: 'completed' })
      await settle()
    } finally {
      f.store.openAsks = openAsks
    }
    expect(f.store.reminder(onThread!.wakeId)?.fired).toMatchObject({ kind: 'thread', threadId: 't2', status: 'completed' })
    const armed = f.timers.slice(timers).at(-1)
    expect(armed?.ms).toBe(0)
    armed!.fn()
    await flush()
    expect(f.store.reminder(onThread!.wakeId)!.status).toBe('delivered')
  })

  it('closing mid-read: the read under way ends, and no pull request after it is read', async () => {
    threadWakes.start()
    await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await threadWakes.add('t3', { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 } })
    const read = deferred<PrRead>()
    const count = reads({ 12: () => read.promise })
    f.clock.now += 3 * 60_000
    tick!()
    await settle()
    threadWakes.close()
    read.resolve({ state: 'merged', title: 'Ship it' })
    await settle()
    expect(count).toEqual({ 12: 1 })
    expect(posts).toEqual([])
  })
})

describe('at its deadline a wake on a pull request is read once more', () => {
  /** A wake on #13 with six minutes to wait; its last read before the deadline was at +5 min, and showed it open. */
  async function threadWakeReadAtFive() {
    threadWakes.start()
    const setAt = f.clock.now
    const set = await threadWakes.add('t3', { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 })
    const count = reads({})
    f.clock.now = setAt + 5 * 60_000
    tick!()
    await settle()
    expect(count[13]).toBe(1)
    return { setAt, set }
  }

  it('a thread\'s wake: the pull request merged after its last read and before the deadline, and no read is under way: it fires as merged', async () => {
    const { setAt, set } = await threadWakeReadAtFive()
    const count = reads({ 13: async () => ({ state: 'merged', title: 'Hotfix', mergedAt: new Date(setAt + 5.5 * 60_000).toISOString() }) })
    f.clock.now = setAt + 6 * 60_000
    tick!()
    await settle()
    expect(count[13]).toBe(1)
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${set.wakeId}`, wakeFiredLabel({ kind: 'pr', repo: 'acme/app', number: 13, state: 'merged' })]])
  })

  it('a thread\'s wake: its last read, at the deadline, fails: it gives up, saying the pull request couldn\'t be read', async () => {
    const { setAt, set } = await threadWakeReadAtFive()
    reads({ 13: async () => ({ problem: 'gh: network unreachable' }) })
    f.clock.now = setAt + 6 * 60_000
    tick!()
    await settle()
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${set.wakeId}`, wakeFiredLabel({ kind: 'ended', reason: 'expired_unread' })]])
    expect(posts[0]!.payload.text).toContain('couldn\'t be read')
  })

  it('a thread\'s wake: its last read fails and its inbox can\'t be written then: the next tick still says the pull request couldn\'t be read', async () => {
    const { setAt, set } = await threadWakeReadAtFive()
    const count = reads({ 13: async () => ({ problem: 'gh: network unreachable' }) })
    failPosts = 1
    f.clock.now = setAt + 6 * 60_000
    tick!()
    await settle()
    expect(posts).toEqual([])
    f.clock.now += 30_000
    tick!()
    await settle()
    expect(count[13]).toBe(1)
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${set.wakeId}`, wakeFiredLabel({ kind: 'ended', reason: 'expired_unread' })]])
  })

  it('a bot\'s wake: its last read fails and bots.db refuses the write then: the next pass still says the pull request couldn\'t be read', async () => {
    const setAt = f.clock.now
    const [short] = await botWakes([{ brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 }])
    reads({ 13: async () => ({ problem: 'gh: network unreachable' }) })
    vi.spyOn(f.store, 'fireWake').mockImplementationOnce(() => { throw new Error('database is locked') })
    f.clock.now = setAt + 6 * 60_000
    await f.bots.deliverDueReminders(new Date(f.clock.now))
    await settle()
    expect(f.store.reminder(short!.wakeId)).toMatchObject({ status: 'waiting', fired: null })
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders(new Date(f.clock.now))
    await flush()
    expect(f.store.reminder(short!.wakeId)).toMatchObject({ status: 'delivered', fired: { kind: 'ended', reason: 'expired_unread' } })
  })

  it('a bot\'s wake: the pull request merged after its last read and before the deadline, and no read is under way: it fires as merged', async () => {
    const setAt = f.clock.now
    const [short] = await botWakes([{ brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 }, hours: 0.1 }])
    let count = reads({})
    f.clock.now = setAt + 5 * 60_000
    await f.bots.maintain(new Date(f.clock.now))
    expect(count[13]).toBe(1)
    count = reads({ 13: async () => ({ state: 'merged', title: 'Hotfix', mergedAt: new Date(setAt + 5.5 * 60_000).toISOString() }) })
    // The wake's own deadline timer, with no read under way.
    f.clock.now = setAt + 6 * 60_000
    await f.bots.deliverDueReminders(new Date(f.clock.now))
    await settle()
    expect(count[13]).toBe(1)
    await f.bots.deliverDueReminders(new Date(f.clock.now))
    await flush()
    const row = f.store.reminder(short!.wakeId)!
    expect(row.status).toBe('delivered')
    expect(row.fired).toMatchObject({ kind: 'pr', number: 13, state: 'merged' })
  })

  it('a thread\'s review wake: a review before the deadline, the merge after it, and the read answers after the merge: it fires as the review', async () => {
    threadWakes.start()
    const setAt = f.clock.now
    const set = await threadWakes.add('t3', { brief: 'Answer the review.', event: { kind: 'pr', repo: 'acme/app', number: 13, on: 'review' }, hours: 0.1 })
    const read = deferred<PrRead>()
    reads({ 13: () => read.promise })
    f.clock.now = setAt + 5.8 * 60_000
    tick!()
    await settle()
    f.clock.now = setAt + 7 * 60_000
    read.resolve({ state: 'merged', title: 'Hotfix', mergedAt: new Date(setAt + 6.5 * 60_000).toISOString(), reviews: [{ id: 'rv1', state: 'approved', author: 'kim', submittedAt: new Date(setAt + 5.5 * 60_000).toISOString() }] })
    await settle()
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${set.wakeId}`, wakeFiredLabel({ kind: 'pr', repo: 'acme/app', number: 13, state: 'review', reviewState: 'approved', reviewer: 'kim' })]])
  })
})

describe('wakes on pull requests past their deadlines at a restart', () => {
  it('are read one at a time, each once, and each gives up', async () => {
    threadWakes.start()
    const setAt = f.clock.now
    for (const [thread, number] of [['t1', 12], ['t2', 13], ['t3', 14]] as const) {
      await threadWakes.add(thread, { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number }, hours: 0.1 })
    }
    threadWakes.close()
    f.clock.now = setAt + 60 * 60_000
    const answers: Array<() => void> = []
    let live = 0
    let most = 0
    const held = () => {
      live += 1
      most = Math.max(most, live)
      return new Promise<PrRead>((resolve) => { answers.push(() => { live -= 1; resolve({ state: 'open', title: 'Ship it' }) }) })
    }
    const count = reads({ 12: held, 13: held, 14: held })
    // Starting looks at once.
    threadWakes = newThreadWakes()
    threadWakes.start()
    for (let i = 0; i < 3; i++) {
      await settle()
      expect(live).toBe(1)
      answers[i]!()
    }
    await settle()
    expect(most).toBe(1)
    expect(count).toEqual({ 12: 1, 13: 1, 14: 1 })
    expect(posts.map((post) => post.payload.label)).toEqual(Array(3).fill(wakeFiredLabel({ kind: 'ended', reason: 'expired' })))
  })
})

describe('a pull request read that never answers', () => {
  afterEach(() => { vi.useRealTimers() })

  it('counts as failed once its time is up: the wake behind it is read, and its own is read again at the next tick', async () => {
    threadWakes.start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await threadWakes.add('t1', { brief: 'Ship it once merged.', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    await threadWakes.add('t3', { brief: 'Ship the hotfix once merged.', event: { kind: 'pr', repo: 'acme/app', number: 13 } })
    const count = reads({ 12: () => new Promise<PrRead>(() => {}) })
    f.clock.now += 3 * 60_000
    tick!()
    await settle()
    expect(count).toEqual({ 12: 1 })
    await vi.advanceTimersByTimeAsync(PR_WAKE_READ_TIMEOUT_MS)
    await settle()
    expect(count).toEqual({ 12: 1, 13: 1 })
    f.clock.now += 3 * 60_000
    tick!()
    await settle()
    expect(count).toEqual({ 12: 2, 13: 1 })
    await vi.advanceTimersByTimeAsync(PR_WAKE_READ_TIMEOUT_MS)
    await settle()
    expect(count).toEqual({ 12: 2, 13: 2 })
  })
})

describe('a wake on a thread stored just after the run it waits for ended', () => {
  /**
   * The thread's runs, as the real `wakeThreadState` reads them. The first look at the thread (setting the wake) sees
   * run r1 working; r1 then fails, its end is told, and r2 starts, all before the wake is stored.
   */
  function endsAsTheWakeIsSet(told: () => void) {
    const runs: Record<string, { status: string; ended: boolean }> = { r1: { status: 'running', ended: false } }
    const order = ['r1']
    let looked = false
    seeThread = (runId) => {
      const seen = wakeThreadState({
        thread: () => ({ name: 'Port the parser' }),
        trashed: () => false,
        reachable: () => true,
        working: () => order.some((id) => !runs[id]!.ended),
        lastRun: () => runs[order.at(-1)!],
        currentRun: () => order.find((id) => !runs[id]!.ended),
        run: (_threadId, id) => runs[id]
      }, 'home', 't2', runId)
      if (!looked) {
        looked = true
        runs.r1 = { status: 'failed', ended: true }
        told()
        runs.r2 = { status: 'running', ended: false }
        order.push('r2')
      }
      return seen
    }
  }

  it('a thread\'s wake fires at the next tick with that run\'s outcome, though the next run works', async () => {
    threadWakes.start()
    endsAsTheWakeIsSet(() => threadWakes.threadRunEnded('t2', { status: 'failed', runId: 'r1' }))
    const set = await threadWakes.add('t3', { brief: 'Review what t2 wrote.', event: { kind: 'thread', threadId: 't2' } })
    await settle()
    expect(posts).toEqual([])
    tick!()
    await settle()
    expect(posts.map((post) => [post.key, post.payload.label])).toEqual([[`thread-wake:${set.wakeId}`, 'Following up · "Port the parser" failed']])
  })

  it('a bot\'s wake fires at the next check with that run\'s outcome, though the next run works', async () => {
    endsAsTheWakeIsSet(() => f.bots.threadRunEnded('t2', { status: 'failed', runId: 'r1' }))
    const [onThread] = await botWakes([{ brief: 'Tell them t2 is done.', event: { kind: 'thread', threadId: 't2' } }])
    await settle()
    expect(f.store.reminder(onThread!.wakeId)?.fired).toBeNull()
    await f.bots.maintain(new Date(f.clock.now))
    expect(f.store.reminder(onThread!.wakeId)?.fired).toMatchObject({ kind: 'thread', threadId: 't2', status: 'failed' })
  })
})
