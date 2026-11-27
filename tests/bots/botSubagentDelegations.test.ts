/**
 * A bot's work subagents run as delegations of the run database (Run DB v29), through the bot port: the run database owns
 * their lifecycle and lineage, bots.db their place on the work's counts and spend (`bot_subagent_runs`, v15). Each
 * holds room on the work's spend before its turn can be dispatched, is charged once (up to when it was last known alive)
 * whatever crashes in between, reaches its work only through the bot port (acknowledged once recorded, told to the work's
 * next model step once), and holds no more than the work did when it started, checked again right before it binds.
 *
 * Restarts are real: both databases close and open again, the run engine boots (a new daemon epoch) and then the bots.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { BOTS_MIGRATIONS } from '../../src/mms/bots/store/BotStore'
import { BotSpendScope } from '../../src/mms/bots/store/scopes'
import { budgetLimitsOf, RunCounterBook } from '../../src/mms/harness/budget'
import { RUN_MIGRATIONS } from '../../src/mms/run/db/migrations'
import { reviseTree } from '../../src/mms/run/delegation/treeCorrection'
import { wakeThreads } from '../../src/mms/run/delegation/wake'
import { BOT_TOOLS, subagentData } from '../../src/mms/run/mcp/appTools/bots'
import type { BotTurnPayload } from '../../src/mms/run/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botFixture, createBot, finish, flush, start, startSubagent, subagentRuns, type BotFixture } from './botFixture'

const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })

describe('a bot\'s work subagents as delegations', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => {
    vi.restoreAllMocks()
    f.close()
  })

  async function work(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Compare three vacuum cleaners.', clientRequestId: id })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }

  const ledger = (activationId: string) => f.store.subagentRuns(activationId)
  const turnStart = (runId: string) => f.outbox.listForRun(runId).find((effect) => effect.kind === 'turn.start')!
  const openHolds = (activationId: string) => f.store.all('SELECT id FROM bot_spend_reservations WHERE activation_id = ? AND settled_at IS NULL ORDER BY id', activationId).map((row) => String(row.id))
  /** The budget the runtime runs a turn under, handed over as the orchestrator and the gateway hand it (`startTurn`). */
  const runtimeBudget = (book: RunCounterBook, turn: { payload: BotTurnPayload; prepared: PreparedBotTurn }) =>
    book.acquire(turn.payload.runId, budgetLimitsOf(turn.prepared.policy) ?? {}, turn.prepared.runtimeCounters ?? turn.prepared.authority.counters, { spend: turn.prepared.authority.spend! }).budget
  const request = { inputBound: 1_000, wireCap: 100, floor: 64, price: { input: 0, output: 0 } }

  it('siblings started at once each hold room on the work\'s spend before any turn is dispatched; one with no room never starts, and the runtimes draw on their own holds', async () => {
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 10_000 } }))
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    const started = await Promise.all(['Prices', 'Reviews', 'Stock'].map((title) => subagents.start({ title, brief: `Find the ${title.toLowerCase()}.` })))
    for (const answer of started) expect(answer).toHaveProperty('started')
    const [first, second, third] = subagentRuns(f, job.id)
    // Two holds fit under the cap, each made as its delegation committed: none of the turns is dispatched yet.
    expect(openHolds(job.id)).toEqual([`subagent:${first}`, `subagent:${second}`].sort())
    for (const runId of [first!, second!, third!]) expect(turnStart(runId).status).toBe('pending')
    // The third finds no room when its turn comes: it does not start.
    const late = turnStart(third!).payload as BotTurnPayload
    await f.bots.refresh(late)
    expect(f.bots.prepare(late)).toMatchObject({ code: 'bot_spend_exhausted' })
    // The runtimes reserve on the scope their turn hands over, against the same cap. Each request draws on its own run's
    // hold and takes its place: 5,000 fits beside the sibling's hold of 4,096, then 4,900 beside that 5,000. Counting the
    // requester's own hold as well would refuse both.
    const book = new RunCounterBook()
    const a = runtimeBudget(book, await startSubagent(f, first!))
    const b = runtimeBudget(book, await startSubagent(f, second!))
    expect(a.reserve({ ...request, inputBound: 5_000 })).toMatchObject({ ok: true })
    expect(openHolds(job.id).filter((id) => id.startsWith('subagent:'))).toEqual([`subagent:${second}`])
    expect(b.reserve({ ...request, inputBound: 4_900 })).toMatchObject({ ok: true })
    expect(openHolds(job.id).filter((id) => id.startsWith('subagent:'))).toEqual([])
  })

  it('a lone subagent\'s first request draws on the room held for it, so it can use what is left of the cap; a sibling\'s hold still counts against it', async () => {
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 10_000 } }))
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const [lone] = subagentRuns(f, job.id)
    // 6,500 and its own hold of 4,096 would be over 10,000; the hold is its room, not a rival's.
    expect(runtimeBudget(new RunCounterBook(), await startSubagent(f, lone!)).reserve({ ...request, inputBound: 6_500 })).toMatchObject({ ok: true })
    expect(openHolds(job.id).filter((id) => id.startsWith('subagent:'))).toEqual([])
    const other = await work('w2')
    await other.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    await other.prepared.authority.subagents!.start({ title: 'Reviews', brief: 'Find the reviews.' })
    const [one] = subagentRuns(f, other.id)
    // Beside a sibling's hold of 4,096, 5,905 is one token over.
    expect(runtimeBudget(new RunCounterBook(), await startSubagent(f, one!)).reserve({ ...request, inputBound: 5_905 })).toMatchObject({ ok: false, limit: { kind: 'input_tokens', limit: 10_000 } })
  })

  it.each([
    ['a restart', true],
    ['its turn ending', false]
  ])('a subagent\'s hold whose release fails (bots.db locked) at %s is let go by the next upkeep pass, and never charged', async (_name, restart) => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const [childRun] = subagentRuns(f, job.id)
    const child = await startSubagent(f, childRun!)
    const committed = () => f.store.get('SELECT committed_input AS input, committed_output AS output, committed_usd_micros AS usd FROM bot_spend WHERE activation_id = ?', job.id)
    const before = committed()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Every release of the hold fails while bots.db is locked.
    const settle = BotSpendScope.prototype.settle
    const locked = vi.spyOn(BotSpendScope.prototype, 'settle').mockImplementation(function (this: BotSpendScope, id, outcome) {
      if (id.startsWith('subagent:')) throw new Error('database is locked')
      return settle.call(this, id, outcome)
    })
    if (restart) await f.restart({ crashed: true })
    else {
      f.runs.markTerminal(childRun!, 'completed', undefined, { resultText: 'Prices: 199.' })
      f.bots.settle(child.payload, { text: 'Prices: 199.' })
      await flush()
    }
    expect(openHolds(job.id)).toEqual([`subagent:${childRun}`])
    expect(committed()).toEqual(before)
    // bots.db is free again: the next pass lets it go, and nothing of it is charged.
    locked.mockRestore()
    await f.bots.maintain()
    expect(openHolds(job.id)).toEqual([])
    expect(committed()).toEqual(before)
  })

  it('a subagent with no spending limit still runs on the work\'s spend scope, and its tokens count in the work\'s', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    expect(child.prepared.authority.spend).toBeDefined()
    const before = f.store.counters(job.id).inputTokens
    child.prepared.usage!({ input: 1_200, output: 300, cacheRead: 0, cacheWrite: 0 })
    expect(f.store.counters(job.id).inputTokens).toBe(before + 1_200)
  })

  it('a crash after a subagent\'s run ended and before its time was charged: the restart charges it once, and a late settle changes nothing', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const [childRun] = subagentRuns(f, job.id)
    const child = await startSubagent(f, childRun!)
    f.clock.now += 5_000
    // Its run ended in the run database; the bots never heard (the process died).
    vi.spyOn(f.bots, 'onSubagentSettled').mockImplementation(() => {})
    f.runs.markTerminal(childRun!, 'completed', undefined, { resultText: 'Prices: 199.' })
    expect(f.store.subagentRun(job.id, childRun!)!.chargedAt).toBeNull()
    await f.restart({ crashed: true, down: 60_000 })
    const entry = f.store.subagentRun(job.id, childRun!)!
    expect(entry).toMatchObject({ usedMs: 5_000, chargedAt: expect.any(String) })
    const charged = f.store.counters(job.id).activeMs
    // Again: nothing more.
    f.bots.settle(child.payload, { text: 'Prices: 199.' })
    await f.restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
    expect(f.store.subagentRun(job.id, childRun!)!.usedMs).toBe(5_000)
    // Settled once per (work, child run), whoever asks again.
    expect(f.store.chargeSubagentRun(job.id, childRun!, 5_000)).toBe(false)
    expect(f.store.counters(job.id).activeMs).toBe(charged)
  })

  it.each([
    ['a crash', { crashed: true }, 4_000],
    ['a clean shutdown', { crashed: false }, 5_000]
  ])('a subagent cut off by %s is charged up to when it was last known alive, not for the hour Mousse was down', async (_name, how, used) => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const [childRun] = subagentRuns(f, job.id)
    await startSubagent(f, childRun!)
    f.clock.now += 4_000
    f.runs.heartbeat(childRun!)
    f.clock.now += 1_000
    await f.restart({ ...how, down: 3_600_000 })
    expect(f.runs.getRun(childRun!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'daemon_restart' } })
    expect(f.store.subagentRun(job.id, childRun!)).toMatchObject({ usedMs: used, chargedAt: expect.any(String) })
    const charged = f.store.counters(job.id).activeMs
    await f.restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
  })

  it('a crash between the run database\'s commit and the reservation: the restart reserves it from its turn, it never runs, and its work hears it stopped', async () => {
    const job = await work('w1')
    vi.spyOn(f.store, 'reserveSubagentRun').mockImplementationOnce(() => { throw new Error('bots.db is locked') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })).toHaveProperty('started')
    const [childRun] = subagentRuns(f, job.id)
    expect(f.store.subagentRun(job.id, childRun!)).toBeUndefined()
    await f.restart({ crashed: true })
    expect(f.store.subagentRun(job.id, childRun!)).toMatchObject({ spec: { title: 'Prices' }, startedAt: null, chargedAt: null, outcome: 'stopped', deliveredAt: expect.any(String) })
    // Its run ended at the boot, never having started.
    expect(f.runs.getRun(childRun!)).toMatchObject({ status: expect.stringMatching(/^(cancelled|interrupted)$/) })
    expect(f.runs.getRun(childRun!)!.startedAt).toBeFalsy()
    expect(openHolds(job.id)).toEqual([])
    const charged = f.store.counters(job.id).activeMs
    await f.restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
  })

  it('a result while the work\'s turn runs reaches the work\'s next model step once; the work\'s thread is never woken or steered', async () => {
    const job = await work('w1')
    const steer = job.prepared.steer!
    steer.attached()
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    expect(steer.peek()).toBeUndefined()
    f.runs.markTerminal(child.payload.runId, 'completed', undefined, { resultText: 'Prices: 199, 249.' })
    // Rule 4 leaves it for the bot port.
    expect(wakeThreads(f.runs.store, f.outbox, () => PI_TEST_CAPABILITIES, new Date(f.clock.now).toISOString())).toMatchObject({ wakes: [], steers: [] })
    f.runs.deliverBotResults()
    await flush()
    // The next step the model takes carries it.
    expect(steer.peek()).toContain('Your subagent "Prices" finished')
    const taken = steer.take()!
    expect(taken.text).toContain('Your subagent "Prices" finished')
    steer.accepted(taken.token)
    expect(steer.peek()).toBeUndefined()
    // Told once the turn that took it in settles, not before.
    expect(f.store.subagentRun(job.id, child.payload.runId)).toMatchObject({ outcome: 'done', deliveredAt: expect.any(String), toldAt: null })
    expect(f.runs.inbox.listPending(job.payload.threadId)).toEqual([])
    expect(f.runs.store.listRuns(job.payload.threadId)).toHaveLength(1)
    await finish(f, job.payload, 'completed', { text: 'Done.' })
    expect(f.store.subagentRun(job.id, child.payload.runId)!.toldAt).toEqual(expect.any(String))
  })

  it('a crash after subagent_result returned and before the work\'s turn settled: its continuation still tells it the subagent ended', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    await finish(f, child.payload, 'completed', { text: 'Prices: 199.' })
    expect(subagents.result({ subagent: 'Prices' })).toMatchObject({ subagents: [{ subagent: 'Prices', state: 'done', result: 'Prices: 199.' }] })
    // The reply never became part of the work's turn.
    await f.restart({ crashed: true })
    const next = f.store.dispatches(job.id).filter((dispatch) => dispatch.kind !== 'subagent').at(-1)!
    expect(next.n).toBeGreaterThan(1)
    expect((await start(f, job.id, next.n)).prepared.prompt).toContain('Your subagents "Prices" ended since you last looked')
  })

  it('more work for a subagent before its work read what it returned is refused (nothing would read that result); subagent_result marks told only the turn whose result it carried, once the work\'s turn settles', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const first = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    await finish(f, first.payload, 'completed', { text: 'Prices: 199.' })
    expect(await subagents.send({ subagent: 'Prices', message: 'Only ones under 300.' })).toMatchObject({ refused: expect.stringContaining('Read what "Prices" returned first') })
    expect(subagentRuns(f, job.id)).toHaveLength(1)
    expect(subagents.result({ subagent: 'Prices' })).toMatchObject({ subagents: [{ result: 'Prices: 199.' }] })
    expect(await subagents.send({ subagent: 'Prices', message: 'Only ones under 300.' })).toMatchObject({ sent: { subagent: 'Prices' } })
    const second = await startSubagent(f, subagentRuns(f, job.id)[1]!)
    await finish(f, second.payload, 'completed', { text: 'Prices under 300: 199, 249.' })
    expect(f.store.subagentRun(job.id, first.payload.runId)!.toldAt).toBeNull()
    // The first, read in this turn, is not offered again at its next step; the second, never read, is, once.
    job.prepared.steer!.attached()
    expect(job.prepared.steer!.peek()!.match(/Your subagent "Prices" finished/g)).toHaveLength(1)
    f.runs.markTerminal(job.payload.runId, 'completed')
    f.bots.settle(job.payload, { text: 'Here are the prices.' })
    expect(f.store.subagentRun(job.id, first.payload.runId)!.toldAt).toEqual(expect.any(String))
    expect(f.store.subagentRun(job.id, second.payload.runId)!.toldAt).toBeNull()
  })

  it('subagent_wait wakes when the result is delivered; what it read is not told again at the next step', async () => {
    const job = await work('w1')
    const steer = job.prepared.steer!
    steer.attached()
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const waiting = subagents.wait({ subagent: 'Prices' })
    await finish(f, child.payload, 'completed', { text: 'Prices: 199, 249.' })
    expect(await waiting).toMatchObject({ subagents: [{ subagent: 'Prices', state: 'done', result: 'Prices: 199, 249.' }] })
    expect(steer.peek()).toBeUndefined()
  })

  it('a subagent that ends after its work\'s turn ended is recorded with no settle from its executor, and the work moves on to done; no wake turn starts on its thread', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Slow', brief: 'Take your time.' })
    const slow = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    await finish(f, job.payload, 'completed', { text: 'Here is what I found.' })
    expect(f.store.activation(job.id)!.status).toBe('running')
    f.runs.markTerminal(slow.payload.runId, 'interrupted', { interruptedBy: 'user' })
    expect(wakeThreads(f.runs.store, f.outbox, () => PI_TEST_CAPABILITIES, new Date(f.clock.now).toISOString())).toMatchObject({ wakes: [], steers: [] })
    f.runs.deliverBotResults()
    await flush()
    expect(f.store.subagentRun(job.id, slow.payload.runId)).toMatchObject({ outcome: 'stopped', deliveredAt: expect.any(String) })
    expect(f.store.activation(job.id)!.status).toBe('done')
    expect(f.runs.store.listRuns(job.payload.threadId)).toHaveLength(1)
    expect(f.runs.inbox.listPending(job.payload.threadId)).toEqual([])
  })

  it('its inbox row is acknowledged only once bots.db recorded the delivery', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const record = vi.spyOn(f.store, 'recordSubagentDelivery').mockImplementation(() => { throw new Error('bots.db is locked') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await finish(f, child.payload, 'completed', { text: 'Prices: 199.' })
    const [row] = f.runs.inbox.listPending(job.payload.threadId)
    expect(row).toMatchObject({ kind: 'child_result', status: 'pending' })
    expect(f.runs.delegations.getByChildRun(child.payload.runId)!.status).toBe('result_available')
    expect(f.store.subagentRun(job.id, child.payload.runId)!.deliveredAt).toBeNull()
    record.mockRestore()
    expect(f.runs.deliverBotResults()).toEqual([row!.inboxId])
    expect(f.runs.inbox.get(row!.inboxId)!.status).toBe('acknowledged')
    expect(f.runs.delegations.getByChildRun(child.payload.runId)!.status).toBe('acknowledged')
    expect(f.store.subagentRun(job.id, child.payload.runId)).toMatchObject({ outcome: 'done', deliveredAt: expect.any(String) })
  })

  it('a crash right after bots.db recorded the delivery and before the inbox row was acknowledged: delivered again, and the work is told once', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const real = f.store.recordSubagentDelivery.bind(f.store)
    vi.spyOn(f.store, 'recordSubagentDelivery').mockImplementationOnce((...args) => {
      real(...args)
      throw new Error('the process died')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await finish(f, child.payload, 'completed', { text: 'Prices: 199.' })
    expect(f.store.subagentRun(job.id, child.payload.runId)).toMatchObject({ deliveredAt: expect.any(String), toldAt: null })
    expect(f.runs.inbox.listPending(job.payload.threadId)).toHaveLength(1)
    await f.restart({ crashed: true })
    f.runs.deliverBotResults()
    await flush()
    expect(f.runs.inbox.listPending(job.payload.threadId)).toEqual([])
    expect(f.runs.delegations.getByChildRun(child.payload.runId)!.status).toBe('acknowledged')
    // The work's turn was cut off by the crash; its next turn hears of it once, and its steer does not repeat it.
    const next = f.store.dispatches(job.id).filter((dispatch) => dispatch.kind !== 'subagent').at(-1)!
    expect(next.n).toBeGreaterThan(1)
    const again = await start(f, job.id, next.n)
    expect(again.prepared.prompt.match(/"Prices"/g)).toHaveLength(1)
    expect(again.prepared.prompt).toContain('ended since you last looked')
    again.prepared.steer!.attached()
    expect(again.prepared.steer!.peek()).toBeUndefined()
    expect(f.store.subagentRun(job.id, child.payload.runId)!.toldAt).toEqual(expect.any(String))
  })

  it.each([
    ['after a crash and restart', true],
    ['in the same process, on the next pass', false]
  ])('a failure right after bots.db recorded the delivery to a work whose turn had ended: delivered again %s, and the work moves on to done', async (_name, crash) => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Slow', brief: 'Take your time.' })
    const slow = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    await finish(f, job.payload, 'completed', { text: 'Here is what I found.' })
    expect(f.store.activation(job.id)!.status).toBe('running')
    const real = f.store.recordSubagentDelivery.bind(f.store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(f.bots, 'onSubagentSettled').mockImplementationOnce(() => {
      // The process dies inside the delivery: bots.db has the marker, nothing after it ran.
      real(job.id, slow.payload.runId, 'done', null)
      throw new Error('the process died')
    })
    f.runs.markTerminal(slow.payload.runId, 'completed', undefined, { resultText: 'Slow: done.' })
    f.runs.deliverBotResults()
    expect(f.store.subagentRun(job.id, slow.payload.runId)).toMatchObject({ deliveredAt: expect.any(String) })
    expect(f.store.activation(job.id)!.status).toBe('running')
    if (crash) await f.restart({ crashed: true })
    f.runs.deliverBotResults()
    await flush(12)
    expect(f.runs.inbox.listPending(job.payload.threadId)).toEqual([])
    expect(f.store.activation(job.id)!.status).toBe('done')
  })

  it('a Stop of the work while bots.db is locked leaves its subagent\'s result pending; it is delivered once bots.db opens', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const record = vi.spyOn(f.store, 'recordSubagentDelivery').mockImplementation(() => { throw new Error('bots.db is locked') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await finish(f, child.payload, 'completed', { text: 'Prices: 199.' })
    const [row] = f.runs.inbox.listPending(job.payload.threadId)
    expect(row).toMatchObject({ kind: 'child_result' })
    f.runs.stopSubtree({ threadId: job.payload.threadId, reason: 'user', clientRequestId: 'stop-1' })
    await flush()
    expect(f.runs.inbox.get(row!.inboxId)!.status).toBe('pending')
    expect(f.store.subagentRun(job.id, child.payload.runId)!.deliveredAt).toBeNull()
    record.mockRestore()
    expect(f.runs.deliverBotResults()).toEqual([row!.inboxId])
    expect(f.runs.inbox.get(row!.inboxId)!.status).toBe('acknowledged')
    expect(f.store.subagentRun(job.id, child.payload.runId)).toMatchObject({ outcome: 'done', deliveredAt: expect.any(String) })
  })

  it('a subagent older builds wrote as a dispatch is settled at startup: its run ends, it is charged once up to its last heartbeat, it never runs again', async () => {
    const job = await work('w1')
    const spec = { title: 'Prices', brief: 'Find the prices.', selection: { instanceId: 'pi:openrouter', model: 'some/model' } }
    f.store.insertDispatch({ activationId: job.id, n: 2, kind: 'subagent', mainN: 1, clientRequestId: `${job.id}:s2`, threadId: 'legacy-sub', prompt: { text: 'Find the prices.', subagent: spec } as never, policyDigest: f.store.activation(job.id)!.grantDigest })
    const sent = await f.runs.dispatch({ kind: 'send', threadId: 'legacy-sub', clientRequestId: `${job.id}:s2:run`, source: 'bot' })
    if (sent.status !== 'accepted') throw new Error('rejected')
    f.runs.markStarting(sent.runId)
    f.runs.markRunning(sent.runId)
    f.store.run('UPDATE bot_dispatches SET run_id = ?, started_at = ? WHERE activation_id = ? AND n = 2', sent.runId, f.clock.now, job.id)
    f.clock.now += 3_000
    f.runs.heartbeat(sent.runId)
    f.clock.now += 2_000
    await f.restart({ crashed: true, down: 3_600_000 })
    expect(f.runs.getRun(sent.runId)).toMatchObject({ status: 'interrupted' })
    expect(f.store.dispatch(job.id, 2)).toMatchObject({ kind: 'subagent', usedMs: 3_000, settledBy: 'run', endedAt: expect.any(String) })
    const charged = f.store.counters(job.id).activeMs
    await f.restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
    expect(f.store.dispatch(job.id, 2)!.usedMs).toBe(3_000)
  })

  it('an upgrade from Run DB v28 and bots.db v14 with work in flight: both migrate, the older subagent settles once, and new subagents run as delegations', async () => {
    const job = await work('w1')
    const spec = { title: 'Prices', brief: 'Find the prices.', selection: { instanceId: 'pi:openrouter', model: 'some/model' } }
    f.store.insertDispatch({ activationId: job.id, n: 2, kind: 'subagent', mainN: 1, clientRequestId: `${job.id}:s2`, threadId: 'legacy-sub', prompt: { text: 'Find the prices.', subagent: spec } as never, policyDigest: f.store.activation(job.id)!.grantDigest })
    const sent = await f.runs.dispatch({ kind: 'send', threadId: 'legacy-sub', clientRequestId: `${job.id}:s2:run`, source: 'bot' })
    if (sent.status !== 'accepted') throw new Error('rejected')
    f.runs.markStarting(sent.runId)
    f.runs.markRunning(sent.runId)
    f.store.run('UPDATE bot_dispatches SET run_id = ?, started_at = ? WHERE activation_id = ? AND n = 2', sent.runId, f.clock.now, job.id)
    f.clock.now += 2_000
    f.runs.heartbeat(sent.runId)
    // The files as the previous build left them: Run DB v28 (no bot columns on delegations) and bots.db v14.
    const previous = new DatabaseSync(':memory:')
    for (const migration of RUN_MIGRATIONS.filter((entry) => entry.version <= 28)) previous.exec(migration.sql)
    const previousBots = new DatabaseSync(':memory:')
    for (const migration of BOTS_MIGRATIONS.filter((entry) => entry.version <= 14)) previousBots.exec(migration.sql)
    // Every table too: a later migration the rewind below does not undo shows here, not as a failed migration at boot.
    const tables = (db: DatabaseSync) => db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT IN (\'run_schema_migrations\') AND name NOT LIKE \'sqlite_%\' ORDER BY name').all()
    const shape = (db: DatabaseSync) => ({
      tables: tables(db),
      columns: db.prepare('SELECT name, type, "notnull", dflt_value FROM pragma_table_info(\'delegations\') ORDER BY cid').all(),
      indexes: db.prepare('SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'delegations\' ORDER BY name').all()
    })
    await f.restart({
      crashed: true,
      whileDown: (paths) => {
        const run = new DatabaseSync(paths.runDb)
        run.exec(`DROP TABLE agent_chain_holds; DROP TABLE agent_chains; DELETE FROM run_schema_migrations WHERE version = 31;
          DROP TABLE tree_revisions; DELETE FROM run_schema_migrations WHERE version = 30;
          DROP INDEX delegations_by_root_activation; DROP INDEX delegations_child_run;
          ALTER TABLE delegations DROP COLUMN bot_id; ALTER TABLE delegations DROP COLUMN root_activation_id;
          ALTER TABLE delegations DROP COLUMN bot_access; ALTER TABLE delegations DROP COLUMN bot_read_only;
          DELETE FROM run_schema_migrations WHERE version = 29; PRAGMA user_version = 28;`)
        expect(shape(run)).toEqual(shape(previous))
        run.close()
        const bots = new DatabaseSync(paths.botsDb)
        bots.exec(`DROP TABLE bot_chain_holds; DELETE FROM run_schema_migrations WHERE version = 16;
          DROP TABLE bot_subagent_runs; DELETE FROM run_schema_migrations WHERE version = 15; PRAGMA user_version = 14;`)
        expect(tables(bots)).toEqual(tables(previousBots))
        bots.close()
      }
    })
    previous.close()
    previousBots.close()
    expect(f.runs.store.db.statement('PRAGMA user_version').get()).toEqual({ user_version: RUN_MIGRATIONS.at(-1)!.version })
    expect(f.store.get('PRAGMA user_version')).toEqual({ user_version: BOTS_MIGRATIONS.at(-1)!.version })
    // The older subagent: its run ended at the boot, charged once up to its last heartbeat.
    expect(f.runs.getRun(sent.runId)).toMatchObject({ status: 'interrupted' })
    expect(f.store.dispatch(job.id, 2)).toMatchObject({ kind: 'subagent', usedMs: 2_000, settledBy: 'run' })
    // The work goes on; a subagent it starts now is a delegation.
    const next = f.store.dispatches(job.id).filter((dispatch) => dispatch.kind !== 'subagent').at(-1)!
    expect(f.store.activation(job.id)!.status).toBe('running')
    expect(next.n).toBeGreaterThan(2)
    const again = await start(f, job.id, next.n)
    expect(await again.prepared.authority.subagents!.start({ title: 'Reviews', brief: 'Find reviews.' })).toHaveProperty('started')
    expect(subagentRuns(f, job.id)).toHaveLength(1)
    expect(ledger(job.id)).toHaveLength(1)
    // Settled once: another restart charges the older one nothing more.
    await f.restart({ crashed: true })
    expect(f.store.dispatch(job.id, 2)!.usedMs).toBe(2_000)
  })

  it('without the bot port nothing starts: refused, no thread is made, and nothing is written in either database', async () => {
    const job = await work('w1')
    const threads = vi.spyOn(f.host.threads, 'ensureExecutionThread')
    f.runs.setBotPort(null)
    expect(await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })).toMatchObject({ refused: expect.stringMatching(/Bots are not running here/) })
    expect(threads).not.toHaveBeenCalled()
    expect(subagentRuns(f, job.id)).toEqual([])
    expect(ledger(job.id)).toEqual([])
    expect(f.runs.deliverBotResults()).toEqual([])
  })

  it.each([
    ['a Stop of the work lands between its thread being made and its delegation', 'stop'],
    ['its delegation\'s transaction throws', 'throws']
  ])('%s: refused, and neither the thread nor its ownership row is left behind', async (_name, how) => {
    const job = await work('w1')
    const made = vi.spyOn(f.host.threads, 'ensureExecutionThread')
    const discarded = vi.spyOn(f.host.threads, 'discardUnusedThread')
    const real = f.runs.requestBotDelegation.bind(f.runs)
    vi.spyOn(f.runs, 'requestBotDelegation').mockImplementationOnce(async (input) => {
      if (how === 'throws') throw new Error('database is locked')
      f.runs.markTerminal(job.payload.runId, 'interrupted', { interruptedBy: 'user' })
      return real(input)
    })
    expect(await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })).toHaveProperty('refused')
    const thread = made.mock.results[0]!.value as { id: string }
    expect(discarded).toHaveBeenCalledWith(thread.id, job.payload.threadId)
    expect(f.store.botThreads(botId).filter((entry) => entry.threadId === thread.id)).toEqual([])
    expect(subagentRuns(f, job.id)).toEqual([])
    expect(ledger(job.id)).toEqual([])
  })

  it('a brief over the limit is refused whole and makes no thread; a result over the run database\'s cut is kept whole and read page by page', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    const threads = vi.spyOn(f.host.threads, 'ensureExecutionThread')
    expect(await subagents.start({ title: 'Long', brief: 'x'.repeat(32 * 1024 + 1) })).toMatchObject({ refused: expect.stringMatching(/at most 32,768.*Nothing was sent/) })
    expect(threads).not.toHaveBeenCalled()
    expect(subagentRuns(f, job.id)).toEqual([])
    // The tools' schemas name the same limit the work is held to.
    const limitOf = (tool: string, field: string) => (BOT_TOOLS.find((entry) => entry.name === tool)!.parameters as { properties: Record<string, { maxLength?: number }> }).properties[field]!.maxLength
    expect([limitOf('subagent_start', 'brief'), limitOf('subagent_send', 'content')]).toEqual([32 * 1024, 32 * 1024])
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    expect(threads).toHaveBeenCalledTimes(1)
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const text = `${'a'.repeat(70_000)}END`
    await finish(f, child.payload, 'completed', { text })
    const read = subagents.result({ subagent: 'Prices' })
    if ('refused' in read) throw new Error(read.refused)
    expect(read.subagents[0]!.result).toBe(text)
    // Through `subagent_result`: a page, where the next starts, and the end reached with `from`.
    expect(subagentData(read).text).toContain('"from": 16000')
    expect(subagentData(read, 64_000).text).toContain('aEND')
  })

  it('a running subagent takes its own work\'s message at its next step, once; before its runtime takes messages it is refused, and another work can\'t reach it', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const steer = child.prepared.steer!
    expect(await subagents.send({ subagent: 'Prices', message: 'Only ones under 300.' })).toMatchObject({ refused: expect.stringMatching(/can't take a message/) })
    steer.attached()
    expect(await subagents.send({ subagent: 'Prices', message: 'Only ones under 300.' })).toMatchObject({ sent: { subagent: 'Prices', state: 'running' } })
    expect(steer.peek()).toContain('Only ones under 300.')
    const taken = steer.take()!
    steer.accepted(taken.token)
    expect(steer.peek()).toBeUndefined()
    // Another work of the same bot knows no such subagent.
    const other = await work('w2')
    expect(await other.prepared.authority.subagents!.send({ subagent: 'Prices', message: 'Stop.' })).toHaveProperty('refused')
    expect(steer.peek()).toBeUndefined()
  })

  it('the owner\'s correction of the work reaches its subagents through the port as the work\'s own message: a running one at its next step, a queued one and one started later at their start', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    await subagents.start({ title: 'Stock', brief: 'Find the stock.' })
    const [prices, stock] = subagentRuns(f, job.id)
    const child = await startSubagent(f, prices!)
    child.prepared.steer!.attached()
    expect(f.bots.tools.work.noteSubagents!(botId, job.id, 'Only ones under 300.')).toEqual([{ subagent: 'Prices', sent: true }, { subagent: 'Stock', sent: true }])
    // The model wrote the note: each reads it as its work's message, never as the person's.
    const text = child.prepared.steer!.peek()!
    expect(text).toContain('The work that started you sent this')
    expect(text).toContain('Only ones under 300.')
    // "Stock" had not started: it starts with it. "Reviews", started later by the same run of the work, inherits it.
    const queued = await startSubagent(f, stock!)
    await subagents.start({ title: 'Reviews', brief: 'Find the reviews.' })
    const later = await startSubagent(f, subagentRuns(f, job.id)[2]!)
    for (const turn of [queued, later]) {
      expect(turn.prepared.prompt).toContain('The work that started you sent this')
      expect(turn.prepared.prompt).toContain('Only ones under 300.')
    }
    for (const prompt of [text, queued.prepared.prompt, later.prepared.prompt]) expect(prompt).not.toMatch(/The person told/)
    const [revision] = f.runs.store.db.statement('SELECT text, deliveries FROM tree_revisions').all()
    expect(revision!.text).toBe('Only ones under 300.')
    expect(JSON.parse(String(revision!.deliveries))).toMatchObject([
      { title: 'Prices', state: 'pending', how: 'next_step' }, { title: 'Stock', state: 'pending', how: 'starts_with_it' }, { state: 'pending', how: 'inherited' }
    ])
    // Never directly: the thread API's correction of the work's thread posts nothing to its subagents' threads either.
    const workThread = f.runs.delegations.listForRootActivation(job.id)[0]!.parentThreadId
    const { revision: direct } = await reviseTree(f.runs, { threadId: workThread, text: 'Stop.', clientRequestId: 'direct-1', titleOf: () => null, strategyOf: () => 'native', waitsOnPerson: () => false })
    expect(direct.deliveries).toEqual([])
    for (const runId of subagentRuns(f, job.id)) expect(f.runs.inbox.listForThread(f.runs.getRun(runId!)!.threadId)).toEqual([])
  })

  it('a grant narrowed after a subagent\'s turn was prepared and before it binds: refused at the bind; one not narrowed binds to the policy compiled then', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const control = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    expect(control.prepared.beforeBind!()).toEqual({ policy: control.prepared.policy })
    await subagents.start({ title: 'Reviews', brief: 'Find reviews.' })
    const raced = await startSubagent(f, subagentRuns(f, job.id)[1]!)
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'web_search') }))
    expect(raced.prepared.beforeBind!()).toMatchObject({ code: 'bot_grant_revoked' })
  })

  it('a subagent inherits the narrowing its work had on the owner\'s threads when it started, and keeps it', async () => {
    const job = await work('w1')
    // The control: the work itself may act on the owner's threads, with no device limit.
    expect(f.bots.ownerTurn(job.id)).toEqual({})
    expect(job.prepared.authority.threadsReadOnly).toBeUndefined()

    // Started while the work's turn was held to the limit of the device its owner wrote from.
    const limited = vi.spyOn(f.bots, 'ownerTurn').mockReturnValue({ limit: 'ask' })
    await job.prepared.authority.subagents!.start({ title: 'Asks', brief: 'Tidy my threads.' })
    limited.mockRestore()
    const asks = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    expect(f.runs.delegations.getByChildRun(asks.payload.runId)!.bot).toMatchObject({ access: 'ask', readOnly: false })
    expect(f.bots.ownerTurn(job.id, asks.payload.threadId)).toEqual({ limit: 'ask' })
    expect(asks.prepared.authority.threadsReadOnly).toBeUndefined()

    // Started while the work's turn could only read them.
    const readOnly = vi.spyOn(f.bots, 'ownerTurn').mockReturnValue(undefined)
    await job.prepared.authority.subagents!.start({ title: 'Reads', brief: 'Read my threads.' })
    readOnly.mockRestore()
    const reads = await startSubagent(f, subagentRuns(f, job.id)[1]!)
    expect(f.runs.delegations.getByChildRun(reads.payload.runId)!.bot).toMatchObject({ access: null, readOnly: true })
    expect(f.bots.ownerTurn(job.id, reads.payload.threadId)).toBeUndefined()
    expect(reads.prepared.authority.threadsReadOnly).toBe('not_owner')
  })

  it('a grant narrowed while subagents run: the running work and subagent refuse what was taken away at their next call; one not started yet blocks as the work\'s own next turn would', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Running', brief: 'Search.' })
    await subagents.start({ title: 'Queued', brief: 'Search later.' })
    const [running, queued] = subagentRuns(f, job.id)
    const child = await startSubagent(f, running!)
    expect(job.prepared.authority.check(app('web_search'))).toEqual({ ok: true })
    expect(child.prepared.authority.check(app('web_search'))).toEqual({ ok: true })
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, appTools: manifest.appTools.filter((tool) => tool !== 'web_search') }))
    await flush()
    expect(job.prepared.authority.check(app('web_search'))).toMatchObject({ ok: false })
    expect(child.prepared.authority.check(app('web_search'))).toMatchObject({ ok: false })
    // What it still holds goes on.
    expect(child.prepared.authority.check(app('web_fetch'))).toEqual({ ok: true })
    // The queued one is prepared under the wider grant's work: refused as a main turn of it is.
    const effect = turnStart(queued!)
    await f.bots.refresh(effect.payload as never)
    expect(f.bots.prepare(effect.payload as never)).toMatchObject({ code: 'bot_grant_revoked' })
  })
})

