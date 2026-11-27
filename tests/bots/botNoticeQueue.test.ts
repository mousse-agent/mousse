/**
 * A bot's two queues (docs/bots.md, "Notices"): the owner's turns start first, always; notices (wake-ups, a thread's
 * notice or message, another bot's message) wait a short settle and reach the bot as one input. Each notice stays its
 * own row until its batch starts; those the batch took in end `merged` only when the turn that took them ends done,
 * and run after it as they were when it doesn't. A thread waiting on a person is fast; an owner's message sees the
 * acting notices that wait, as data; the owner writing during a notice turn tells it to wrap up. Each request's job
 * notices end with one line on whether its other jobs still go.
 *
 * Inputs: the notice classes (acting: wake, job, thread message; read-only: another bot's message), the owner's turn
 * on this computer or another device's (`owner.limit`), the leader ending done or failed, a burst within the settle,
 * one that keeps arriving past the max, a fast notice, a batch past the character cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTICE_BATCH_MAX_CHARS, NOTICE_SETTLE_MAX_MS, NOTICE_SETTLE_MS, OWNER_WAITS_STEER } from '../../src/mms/bots/activation/BotEngine'
import type { JobThreadView } from '../../src/mms/bots/jobs'
import { OWNER_TURN_NOTICES_HEADING } from '../../src/shared/bots/personal/jobs'
import { notice } from '../../src/shared/mousseContext'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const threads = new Map<string, JobThreadView>()

beforeEach(async () => {
  f = botFixture()
  f.host.noticeSettleMs = NOTICE_SETTLE_MS
  f.host.noticeSettleMaxMs = NOTICE_SETTLE_MAX_MS
  threads.clear()
  f.host.jobThread = (threadId) => threads.get(threadId)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Alpha', description: 'Help me with my work.', reply: 'Hello.' })).botId
})
afterEach(() => f.close())

const row = (id: string) => f.store.activation(id)!
const prompt = (id: string) => f.store.dispatch(id, 1)?.prompt.text ?? ''
const running = () => f.store.laneActivations(botId, 'chat', ['running'])
const queued = () => f.store.laneActivations(botId, 'chat', ['queued'])
/** A notice queued as its delivery queues it (`queueChatInTx`), then the lane looks. */
async function queueNotice(key: string, input: string, fromBot?: { botId: string; name: string; chain: number }): Promise<string> {
  const id = `act_${key.replace(/\W/g, '_')}`
  f.store.db.transaction(() => f.bots.queueChatInTx(botId, key, input, id, undefined, fromBot))
  await f.bots.startQueuedChat(botId, id)
  return id
}
const wake = (n: number) => notice({ kind: 'bot_wake', reply: 'if-needed' }, [`Wake-up ${n} is due.`])
/** The settle timer the lane set last, fired at its time. */
async function fireSettle(): Promise<void> {
  const timer = f.timers.at(-1)!
  f.clock.now += timer.ms
  timer.fn()
  await flush()
}

/** The owner asks; their turn hands each of `jobs` to a thread, as thread_create does, and ends. */
async function handOff(jobs: Array<{ threadId: string; title: string }>, clientRequestId: string): Promise<{ turn: string; jobIds: string[] }> {
  await f.bots.service.chatSend({ botId, text: 'Fix the three pages in Web', clientRequestId })
  const turn = running()[0]!
  const { payload } = await start(f, turn.id)
  const jobIds = jobs.map((job) => {
    threads.set(job.threadId, { status: 'running', title: job.title })
    return f.bots.openJob(botId, turn.id, { threadId: job.threadId, title: job.title, sent: job.title }).jobId
  })
  await finish(f, payload, 'completed', { text: 'Started threads for them.' })
  return { turn: turn.id, jobIds }
}
async function threadEnds(threadId: string, result: string): Promise<void> {
  threads.set(threadId, { status: 'done', title: threads.get(threadId)!.title, result })
  f.bots.threadRunEnded(threadId)
  await flush()
}
const noticeOf = (jobId: string) => f.store.listActivations(botId).find((activation) => activation.idempotencyKey.startsWith(`job:${jobId}:`))!

describe('a burst of notices', () => {
  it('three threads ending within the settle are one turn; the others end merged only once it is done', async () => {
    const { jobIds } = await handOff([{ threadId: 't1', title: 'Page A' }, { threadId: 't2', title: 'Page B' }, { threadId: 't3', title: 'Page C' }], 'm1')
    await threadEnds('t1', 'Fixed A.')
    f.clock.now += 1_000
    await threadEnds('t2', 'Fixed B.')
    f.clock.now += 1_000
    await threadEnds('t3', 'Fixed C.')
    // Nothing starts while they still arrive; the lane looks again the settle after the newest.
    expect(running()).toEqual([])
    expect(f.timers.at(-1)!.ms).toBe(NOTICE_SETTLE_MS)
    await fireSettle()

    const [leader, ...others] = running()
    expect(others).toEqual([])
    expect(leader!.id).toBe(noticeOf(jobIds[0]!).id)
    const text = prompt(leader!.id)
    for (const answer of ['Fixed A.', 'Fixed B.', 'Fixed C.']) expect(text).toContain(answer)
    expect(text.indexOf('Fixed A.')).toBeLessThan(text.indexOf('Fixed B.'))
    expect(text.indexOf('Fixed B.')).toBeLessThan(text.indexOf('Fixed C.'))
    // Every job of that request was in this batch: one line says nothing else goes.
    expect(text.match(/Nothing else for that request is still going\./g)).toHaveLength(1)
    // The others wait, untouched, while it runs.
    const followers = [noticeOf(jobIds[1]!).id, noticeOf(jobIds[2]!).id]
    expect(followers.map((id) => row(id).status)).toEqual(['queued', 'queued'])

    const { payload } = await start(f, leader!.id)
    await finish(f, payload, 'completed', { text: 'All three pages are fixed: mousse://thread/t1' })
    expect(followers.map((id) => [row(id).status, row(id).endReason])).toEqual([['cancelled', 'merged'], ['cancelled', 'merged']])
    expect(running()).toEqual([])
    // A notice that never ran shows nowhere as stopped.
    expect(f.bots.service.get(botId).summary.lastOutcome).toBe('ok')
    expect(f.bots.listActivations(botId).map((activation) => activation.id)).not.toEqual(expect.arrayContaining(followers))
  })

  it('a turn that fails leaves the notices it took in queued, and they run after it as the next batch', async () => {
    f.host.noticeSettleMs = 0
    const first = await queueNotice('wake:w1', wake(1))
    const second = await queueNotice('wake:w2', wake(2))
    expect(running().map((activation) => activation.id)).toEqual([first])
    // The second came while the first ran: the first's turn never listed it.
    expect(prompt(first)).not.toContain('Wake-up 2')
    const third = await queueNotice('wake:w3', wake(3))
    const { payload } = await start(f, first)
    await finish(f, payload, 'failed')
    expect(row(first).status).toBe('failed')
    // The next batch: the second leads and takes the third in.
    expect(running().map((activation) => activation.id)).toEqual([second])
    expect(prompt(second)).toContain('Wake-up 3')
    const again = await start(f, second)
    await finish(f, again.payload, 'failed')
    // Failed again: the third runs alone now, nothing lost.
    expect(row(third).status).toBe('running')
  })

  it('the settle extends while notices keep arriving, and the oldest never waits past the max', async () => {
    const first = await queueNotice('threadmsg:t0:k', notice({ kind: 'thread_message', reply: 'if-needed' }, ['Message 0']))
    for (let n = 1; f.clock.now + 3_000 < Date.parse(row(first).createdAt) + NOTICE_SETTLE_MAX_MS; n += 1) {
      f.clock.now += 3_000
      await queueNotice(`threadmsg:t${n}:k`, notice({ kind: 'thread_message', reply: 'if-needed' }, [`Message ${n}`]))
      expect(running()).toEqual([])
    }
    // The newest is under the settle old, but the oldest reached the max: the lane looks then, and they start.
    const maxAt = Date.parse(row(first).createdAt) + NOTICE_SETTLE_MAX_MS
    expect(f.clock.now + f.timers.at(-1)!.ms).toBe(maxAt)
    await fireSettle()
    expect(running().map((activation) => activation.id)).toEqual([first])
    expect(prompt(first)).toContain('Message 9')
    expect(queued()).toHaveLength(9)
  })

  it('takes whole notices up to the character cap; the rest start the next turn', async () => {
    f.host.noticeSettleMs = 0
    // The lane is busy, so the three wait together.
    const busy = await queueNotice('wake:busy', wake(0))
    const big = (n: number) => notice({ kind: 'bot_wake', reply: 'if-needed' }, [`Big ${n} ${'x'.repeat(Math.floor(NOTICE_BATCH_MAX_CHARS * 0.4))}`])
    const ids = [await queueNotice('wake:b1', big(1)), await queueNotice('wake:b2', big(2)), await queueNotice('wake:b3', big(3))]
    const busyTurn = await start(f, busy)
    await finish(f, busyTurn.payload, 'completed', { text: '[SILENT]' })
    expect(running().map((activation) => activation.id)).toEqual([ids[0]])
    expect(prompt(ids[0]!)).toContain('Big 2')
    expect(prompt(ids[0]!)).not.toContain('Big 3')
    const turn = await start(f, ids[0]!)
    await finish(f, turn.payload, 'completed', { text: '[SILENT]' })
    expect(row(ids[1]!).endReason).toBe('merged')
    expect(running().map((activation) => activation.id)).toEqual([ids[2]])
  })
})

describe('a thread that waits on a person', () => {
  it('is a fast notice: its turn starts at once, with what it asks as data, and takes in what else waits', async () => {
    await handOff([{ threadId: 't1', title: 'Page A' }], 'm1')
    const message = await queueNotice('threadmsg:t9:k', notice({ kind: 'thread_message', reply: 'if-needed' }, ['A blocker']))
    expect(running()).toEqual([])
    threads.set('t1', {
      status: 'needs_input',
      title: 'Page A',
      asks: [{ requestId: 'req-1', approval: true, questions: [{ id: 'q1', text: 'Run npm test?', options: [{ id: 'once', label: 'Approve once' }, { id: 'no', label: 'Reject' }] }] }]
    })
    f.bots.checkJobs('t1')
    await flush()
    // No settle: the thread is waiting.
    expect(running().map((activation) => activation.id)).toEqual([message])
    const text = prompt(message)
    expect(text).toContain('A blocker')
    expect(text).toContain('<quoted from="approval req-1">\n[q1] Run npm test?\nOptions: once = "Approve once"; no = "Reject"\n</quoted>')
    expect(text).toContain('request_answer')
  })
})

describe('the owner\'s turn', () => {
  const sender = { botId: 'other', name: 'Plusy', chain: 1 }

  it('starts before notices that wait, and takes the acting ones in as data; another bot\'s message runs after it', async () => {
    const acting = await queueNotice('wake:w1', wake(1))
    const fromBot = await queueNotice('botmsg:other:m1', notice({ kind: 'bot_message', reply: 'if-needed' }, ['Hello from Plusy']), sender)
    expect(running()).toEqual([])
    await f.bots.service.chatSend({ botId, text: 'How are things?', clientRequestId: 'o1' })
    const [owner] = running()
    expect(owner!.idempotencyKey).toBe('chat:o1')
    const text = prompt(owner!.id)
    expect(text.indexOf('How are things?')).toBeLessThan(text.indexOf(OWNER_TURN_NOTICES_HEADING))
    expect(text).toContain('<mousse_notice kind="bot_wake">\nWake-up 1 is due.')
    // Data only: nothing in the owner's turn reads as leave to answer with silence.
    expect(text).not.toContain('if-needed')
    expect(text).not.toContain('Hello from Plusy')

    const { payload } = await start(f, owner!.id)
    await finish(f, payload, 'completed', { text: 'All good, and your wake-up is handled.' })
    expect([row(acting).status, row(acting).endReason]).toEqual(['cancelled', 'merged'])
    // The other bot's message only reads the owner's threads: it runs on its own, after.
    f.clock.now += NOTICE_SETTLE_MS
    await f.bots.startQueuedChat(botId, fromBot)
    expect(running().map((activation) => activation.id)).toEqual([fromBot])
  })

  it('from another device takes nothing in', async () => {
    const acting = await queueNotice('wake:w1', wake(1))
    await f.bots.service.chatSend({ botId, text: 'From my phone', clientRequestId: 'p1', from: { limit: 'ask' } })
    const [owner] = running()
    expect(owner!.idempotencyKey).toBe('chat:p1')
    expect(prompt(owner!.id)).not.toContain(OWNER_TURN_NOTICES_HEADING)
    const { payload } = await start(f, owner!.id)
    await finish(f, payload, 'completed', { text: 'Hi.' })
    expect(row(acting).status).toBe('queued')
  })

  it('written while a notice turn runs: that turn is told to wrap up without their words, and their message goes next', async () => {
    f.host.noticeSettleMs = 0
    const first = await queueNotice('wake:w1', wake(1))
    const { payload, prepared } = await start(f, first)
    const later = await queueNotice('wake:w2', wake(2))
    await f.bots.service.chatSend({ botId, text: 'Stop what you are doing and look at this', clientRequestId: 'o1' })
    expect(running().map((activation) => activation.id)).toEqual([first])
    const steer = prepared.steer!
    expect(steer.peek()).toBe(OWNER_WAITS_STEER)
    const taken = steer.take()!
    steer.accepted(taken.token)
    expect(steer.peek()).toBeUndefined()

    await finish(f, payload, 'completed', { text: '[SILENT]' })
    const [owner] = running()
    expect(owner!.idempotencyKey).toBe('chat:o1')
    // The notice that waited is the owner's turn's data now.
    expect(prompt(owner!.id)).toContain('Wake-up 2 is due.')
    expect(row(later).status).toBe('queued')
  })
})

describe('the related-jobs line', () => {
  it('names the request\'s other jobs that still go, a job opened from a notice turn included, until none is left', async () => {
    const { jobIds } = await handOff([{ threadId: 't1', title: 'Page A' }, { threadId: 't2', title: 'Page B' }], 'm1')
    f.host.noticeSettleMs = 0
    await threadEnds('t1', 'Fixed A.')
    const first = noticeOf(jobIds[0]!)
    expect(prompt(first.id)).toContain('Fixed A.\n')
    expect(prompt(first.id)).toContain('Still going for the same request: "Page B".')
    // The notice turn carries the request on: a new thread for it.
    const turn = await start(f, first.id)
    threads.set('t3', { status: 'running', title: 'Page C' })
    const followUp = f.bots.openJob(botId, first.id, { threadId: 't3', title: 'Page C', sent: 'Now page C.' }).jobId
    await finish(f, turn.payload, 'completed', { text: '[SILENT]' })

    await threadEnds('t2', 'Fixed B.')
    const second = noticeOf(jobIds[1]!)
    expect(prompt(second.id)).toContain('Still going for the same request: "Page C".')
    const next = await start(f, second.id)
    await finish(f, next.payload, 'completed', { text: '[SILENT]' })

    await threadEnds('t3', 'Fixed C.')
    expect(prompt(noticeOf(followUp).id)).toContain('Nothing else for that request is still going.')
  })

  it('a job opened from a turn that took notices of two requests belongs to neither', async () => {
    const a = await handOff([{ threadId: 't1', title: 'Page A1' }, { threadId: 't2', title: 'Page A2' }], 'm1')
    const b = await handOff([{ threadId: 't3', title: 'Page B1' }, { threadId: 't4', title: 'Page B2' }], 'm2')
    // A1 and B1 end within the settle: one notice turn takes both requests in.
    await threadEnds('t1', 'Fixed A1.')
    f.clock.now += 1_000
    await threadEnds('t3', 'Fixed B1.')
    await fireSettle()
    const [leader] = running()
    expect(prompt(leader!.id)).toContain('Fixed B1.')
    // The bot opens a job from that turn (for B, say): nothing tells which request it carries on.
    const turn = await start(f, leader!.id)
    threads.set('t5', { status: 'running', title: 'Page B3' })
    f.bots.openJob(botId, leader!.id, { threadId: 't5', title: 'Page B3', sent: 'Now page B3.' })
    await finish(f, turn.payload, 'completed', { text: '[SILENT]' })

    f.host.noticeSettleMs = 0
    const related = (id: string) => prompt(id).split('\n').find((line) => /^(Still going|Nothing else)/.test(line))
    await threadEnds('t2', 'Fixed A2.')
    const aNotice = noticeOf(a.jobIds[1]!).id
    expect(related(aNotice)).toBe('Nothing else for that request is still going.')
    const next = await start(f, aNotice)
    await finish(f, next.payload, 'completed', { text: '[SILENT]' })
    await threadEnds('t4', 'Fixed B2.')
    expect(related(noticeOf(b.jobIds[1]!).id)).toBe('Nothing else for that request is still going.')
  })

  it('names the bot\'s own work for the same request while it has not ended, never work for another request', async () => {
    f.host.noticeSettleMs = 0
    const related = (id: string) => prompt(id).split('\n').find((line) => /^(Still going|Nothing else)/.test(line))
    // Another request's work, still running throughout.
    await f.bots.service.chatSend({ botId, text: 'Watch the build', clientRequestId: 'm0' })
    const other = running()[0]!
    const otherTurn = await start(f, other.id)
    await f.bots.tools.work.start(botId, other.id, { title: 'Build watch', brief: 'Watch the build.', key: 'm0:build' })
    await finish(f, otherTurn.payload, 'completed', { text: 'Watching it.' })
    // This request: two threads, and work of the bot's own beside them.
    await f.bots.service.chatSend({ botId, text: 'Fix pages A and B in Web and compare prices', clientRequestId: 'm1' })
    const turn = running()[0]!
    const { payload } = await start(f, turn.id)
    const jobIds = ['Page A', 'Page B'].map((title, index) => {
      threads.set(`t${index + 1}`, { status: 'running', title })
      return f.bots.openJob(botId, turn.id, { threadId: `t${index + 1}`, title, sent: title }).jobId
    })
    const { workId } = await f.bots.tools.work.start(botId, turn.id, { title: 'Compare prices', brief: 'Compare prices.', key: 'm1:prices' })
    await finish(f, payload, 'completed', { text: 'On all three.' })

    await threadEnds('t1', 'Fixed A.')
    const first = noticeOf(jobIds[0]!).id
    expect(related(first)).toMatch(/^Still going for the same request: /)
    expect(related(first)).toContain('"Page B"')
    expect(related(first)).toContain('"Compare prices"')
    expect(related(first)).not.toContain('Build watch')
    const notice = await start(f, first)
    await finish(f, notice.payload, 'completed', { text: '[SILENT]' })

    // The work ends: it no longer goes on for the request.
    const work = await start(f, workId)
    await finish(f, work.payload, 'completed', { text: 'Prices compared.' })
    expect(f.store.activation(workId)!.status).toBe('done')
    await threadEnds('t2', 'Fixed B.')
    expect(related(noticeOf(jobIds[1]!).id)).toBe('Nothing else for that request is still going.')
  })

  it('names only work that goes on, as work_list lists it: never work stopped for good, and work held for the owner says so', async () => {
    f.host.noticeSettleMs = 0
    const related = (id: string) => prompt(id).split('\n').find((line) => /^(Still going|Nothing else)/.test(line))
    await f.bots.service.chatSend({ botId, text: 'Fix pages A, B and C, compare prices and book the trip', clientRequestId: 'm1' })
    const turn = running()[0]!
    const { payload } = await start(f, turn.id)
    const jobIds = ['Page A', 'Page B', 'Page C'].map((title, index) => {
      threads.set(`t${index + 1}`, { status: 'running', title })
      return f.bots.openJob(botId, turn.id, { threadId: `t${index + 1}`, title, sent: title }).jobId
    })
    const prices = (await f.bots.tools.work.start(botId, turn.id, { title: 'Compare prices', brief: 'Compare prices.', key: 'm1:prices' })).workId
    const trip = (await f.bots.tools.work.start(botId, turn.id, { title: 'Book the trip', brief: 'Book the trip.', key: 'm1:trip' })).workId
    await finish(f, payload, 'completed', { text: 'On it.' })
    // Its permissions changed: it stopped and can't go on by itself (work_list leaves it out). The trip waits on the owner's answer.
    expect(f.store.moveActivation(prices, ['queued', 'running'], 'blocked', { endReason: 'bot_grant_revoked' })).toBe(true)
    expect(f.store.moveActivation(trip, ['queued', 'running'], 'blocked', { endReason: 'question' })).toBe(true)
    expect(f.bots.tools.work.list(botId).now.map((work) => work.title)).toEqual(['Book the trip'])

    await threadEnds('t1', 'Fixed A.')
    const line = related(noticeOf(jobIds[0]!).id)!
    expect(line).toContain('"Page B"')
    expect(line).toContain('"Book the trip" (waits for the owner)')
    expect(line).not.toContain('Compare prices')
    expect(line).not.toMatch(/"Page B" \(waits/)
  })

  it('a batch near the cap with many related jobs stays within it: the notices that no longer fit wait for the next turn', async () => {
    // Each request: one thread that ends with a long answer, and nine others still at work, with long titles.
    const report = (r: number) => `Report ${r}: ${'the detail of what changed and why. '.repeat(110)}`.slice(0, 3_900)
    expect(report(0).length).toBeGreaterThan(2_000)
    expect(report(0).length).toBeLessThanOrEqual(4_000)
    const requests: Array<{ turn: string; jobIds: string[] }> = []
    for (let r = 0; r < 5; r += 1) requests.push(await handOff(Array.from({ length: 10 }, (_, j) => ({ threadId: `t${r}-${j}`, title: `Task ${r}-${j}: ${'a long description of the part to fix '.repeat(4)}` })), `m${r}`))
    for (let r = 0; r < 5; r += 1) {
      await threadEnds(`t${r}-0`, report(r))
      f.clock.now += 500
    }
    await fireSettle()
    const [leader] = running()
    const text = prompt(leader!.id)
    expect(text.length).toBeLessThanOrEqual(24_000)
    expect(text.length).toBeLessThanOrEqual(NOTICE_BATCH_MAX_CHARS)
    // Each answer the batch holds is whole, past the old 2,000-character cap, with its request's line after it, bounded.
    expect(text).toContain(report(0))
    const lines = text.split('\n').filter((line) => line.startsWith('Still going for the same request: '))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/, and 1 more\.$/)
      expect(line.match(/"Task /g)).toHaveLength(8)
    }
    // What did not fit waits, untouched, and starts the next turn.
    const held = requests.flatMap((request, r) => text.includes(report(r)) ? [] : [noticeOf(request.jobIds[0]!).id])
    expect(held.length).toBeGreaterThan(0)
    for (const id of held) expect(row(id).status).toBe('queued')
  })
})
