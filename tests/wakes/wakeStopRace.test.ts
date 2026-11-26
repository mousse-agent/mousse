/**
 * The poll thread wake-ups and bot wake-ups share (`WakeDetector`): a Stop that lands while a wake reads its pull
 * request wins, so nothing resumes; and each wake still fires into its own store (a thread's inbox from
 * `thread-wakes.json`, a bot's `bot_reminders`), even when both wait on the same thread.
 *
 * Orders: the pull request read resolves after the Stop (the race); a thread's run ends with a thread wake and a bot
 * wake both waiting on it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WakePullRequestState, WakeThreadState } from '../../src/mms/bots/wakeSources'
import type { ThreadWakePayload } from '../../src/mms/run/types'
import { ThreadWakes } from '../../src/mms/wakes/ThreadWakes'
import { botFixture, createBot, flush, runDispatch, start, finish, type BotFixture } from '../bots/botFixture'

type PrRead = WakePullRequestState | { none: true } | { problem: string }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

let dir: string
let f: BotFixture
let botId: string
/** How the host reads the pull request and the thread both kinds of wake wait on. */
let prRead: () => Promise<PrRead>
let threadState: WakeThreadState
let posts: Array<{ threadId: string; payload: ThreadWakePayload; key: string }>
let threadWakes: ThreadWakes
/** The thread wake-ups' armed timer: the daemon's tick. */
let tick: (() => void) | undefined

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mousse-wake-race-'))
  prRead = async () => ({ state: 'open', title: 'Ship it' })
  threadState = { state: 'running', title: 'Port the parser' }
  posts = []
  f = botFixture()
  f.host.pullRequestState = () => prRead()
  f.host.wakeThread = () => threadState
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
  threadWakes = new ThreadWakes({
    file: join(dir, 'thread-wakes.json'),
    post: (threadId, payload, key) => { posts.push({ threadId, payload, key }) },
    threadState: () => threadState,
    pullRequestState: () => prRead(),
    personLastWroteAt: () => undefined,
    threadExists: (threadId) => threadId !== 'gone',
    now: () => f.clock.now,
    setTimer: (callback) => {
      tick = callback
      return {} as ReturnType<typeof setTimeout>
    },
    clearTimer: () => { tick = undefined }
  })
})

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
