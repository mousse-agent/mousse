/**
 * A bot's work subagents run as delegations of the run database (Run DB v27), through the bot port: the run database owns
 * their lifecycle and lineage, bots.db their place on the work's counts and spend (`bot_subagent_runs`, v15). Each
 * reserves before its turn can be dispatched, is charged once whatever crashes in between, reaches its work only through
 * the bot port (acknowledged once recorded), and holds no more than the work did when it started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botInstructions } from '../../src/mms/bots/instructions'
import { wakeThreads } from '../../src/mms/run/delegation/wake'
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

  /** Mousse stops and starts again: a new bot engine over the same databases, attached as the bot port, reconciled. */
  async function restart() {
    f.bots.close()
    f.bots = new BotEngine(f.host)
    f.runs.setBotPort(f.bots)
    await f.bots.reconcileOnStartup()
    await flush()
  }

  const ledger = (activationId: string) => f.store.subagentRuns(activationId)

  it('siblings started at once each hold their place before either turn is dispatched, and share the work\'s spend caps', async () => {
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, budget: { ...manifest.budget, maxInputTokens: 1_000 } }))
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    const [prices, reviews] = await Promise.all([subagents.start({ title: 'Prices', brief: 'Find the prices.' }), subagents.start({ title: 'Reviews', brief: 'Find reviews.' })])
    expect(prices).toHaveProperty('started')
    expect(reviews).toHaveProperty('started')
    const [first, second] = subagentRuns(f, job.id)
    // Both reserved, neither dispatched yet.
    expect(ledger(job.id).map((row) => ({ childRunId: row.childRunId, startedAt: row.startedAt })).sort((a, b) => a.childRunId.localeCompare(b.childRunId)))
      .toEqual([first!, second!].sort().map((childRunId) => ({ childRunId, startedAt: null })))
    for (const runId of [first!, second!]) expect(f.outbox.listForRun(runId).find((effect) => effect.kind === 'turn.start')!.status).toBe('pending')
    const a = await startSubagent(f, first!)
    const b = await startSubagent(f, second!)
    const ask = { inputBound: 600, wireCap: 100, floor: 64, price: { input: 0, output: 0 } }
    expect(a.prepared.authority.spend!.reserve(ask, {})).toMatchObject({ ok: true })
    // The sibling's reservation counts against the same cap: the second one is refused.
    expect(b.prepared.authority.spend!.reserve(ask, {})).toMatchObject({ ok: false })
    expect(f.store.all('SELECT run_id FROM bot_spend_reservations WHERE activation_id = ? AND settled_at IS NULL', job.id)).toEqual([{ run_id: first }])
  })

  it('a crash after a subagent\'s run ended and before its time was charged: the restart charges it once, and a late settle changes nothing', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })
    const [childRun] = subagentRuns(f, job.id)
    const child = await startSubagent(f, childRun!)
    f.clock.now += 5_000
    // Its run ended in the run database; the bots never heard (the process died).
    f.runs.markTerminal(childRun!, 'completed', undefined, { resultText: 'Prices: 199.' })
    expect(f.store.subagentRun(job.id, childRun!)!.chargedAt).toBeNull()
    await restart()
    const entry = f.store.subagentRun(job.id, childRun!)!
    expect(entry).toMatchObject({ usedMs: 5_000, chargedAt: expect.any(String) })
    const mainUsed = f.store.dispatch(job.id, 1)!.usedMs ?? 0
    const charged = f.store.counters(job.id).activeMs
    // The work's time is its main turn's and its subagent's, each counted once (the main turn's prepaid time is settled).
    expect(charged).toBe(mainUsed + 5_000)
    // Again: nothing more.
    f.bots.settle(child.payload, { text: 'Prices: 199.' })
    await restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
    expect(f.store.subagentRun(job.id, childRun!)!.usedMs).toBe(5_000)
    // Settled once per (work, child run), whoever asks again.
    expect(f.store.chargeSubagentRun(job.id, childRun!, 5_000)).toBe(false)
    expect(f.store.counters(job.id).activeMs).toBe(charged)
  })

  it('a crash between the run database\'s commit and the reservation: the restart reserves it from its turn, it never runs, and its work hears it stopped', async () => {
    const job = await work('w1')
    vi.spyOn(f.store, 'reserveSubagentRun').mockImplementationOnce(() => { throw new Error('bots.db is locked') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })).toHaveProperty('started')
    const [childRun] = subagentRuns(f, job.id)
    expect(f.store.subagentRun(job.id, childRun!)).toBeUndefined()
    await restart()
    expect(f.store.subagentRun(job.id, childRun!)).toMatchObject({ spec: { title: 'Prices' }, startedAt: null, chargedAt: null, outcome: 'stopped', deliveredAt: expect.any(String) })
    expect(f.runs.getRun(childRun!)).toMatchObject({ status: 'cancelled', outcome: { error: 'bot_dispatch_restarted' } })
    const charged = f.store.counters(job.id).activeMs
    await restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
  })

  it('a result while the work\'s turn runs reaches the work at its next step and wakes subagent_wait; the work\'s thread is never woken or steered', async () => {
    const job = await work('w1')
    const subagents = job.prepared.authority.subagents!
    await subagents.start({ title: 'Prices', brief: 'Find the prices.' })
    const child = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    const waiting = subagents.wait({ subagent: 'Prices' })
    f.runs.markTerminal(child.payload.runId, 'completed', undefined, { resultText: 'Prices: 199, 249.' })
    const [row] = f.runs.inbox.listPending(job.payload.threadId)
    expect(row).toMatchObject({ kind: 'child_result' })
    // Rule 4 leaves it for the bot port.
    expect(wakeThreads(f.runs.store, f.outbox, () => PI_TEST_CAPABILITIES, new Date(f.clock.now).toISOString())).toMatchObject({ wakes: [], steers: [] })
    f.bots.settle(child.payload, { text: 'Prices: 199, 249.' })
    expect(f.runs.deliverBotResults()).toEqual([row!.inboxId])
    expect(await waiting).toMatchObject({ subagents: [{ subagent: 'Prices', state: 'done', result: 'Prices: 199, 249.' }] })
    expect(f.store.subagentRun(job.id, child.payload.runId)).toMatchObject({ outcome: 'done', deliveredAt: expect.any(String) })
    expect(f.runs.inbox.get(row!.inboxId)!.status).toBe('acknowledged')
    expect(f.runs.store.listRuns(job.payload.threadId)).toHaveLength(1)
  })

  it('a subagent that ends after its work\'s turn ended is recorded, and the work moves on to done; no wake turn starts on its thread', async () => {
    const job = await work('w1')
    await job.prepared.authority.subagents!.start({ title: 'Slow', brief: 'Take your time.' })
    const slow = await startSubagent(f, subagentRuns(f, job.id)[0]!)
    await finish(f, job.payload, 'completed', { text: 'Here is what I found.' })
    expect(f.store.activation(job.id)!.status).toBe('running')
    f.runs.markTerminal(slow.payload.runId, 'interrupted', { interruptedBy: 'user' })
    expect(wakeThreads(f.runs.store, f.outbox, () => PI_TEST_CAPABILITIES, new Date(f.clock.now).toISOString())).toMatchObject({ wakes: [], steers: [] })
    f.bots.settle(slow.payload, {})
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

  it('a subagent an older build wrote as a dispatch is settled at startup: its run ends, its time is charged once, it never runs again', async () => {
    const job = await work('w1')
    const spec = { title: 'Prices', brief: 'Find the prices.', selection: { instanceId: 'pi:openrouter', model: 'some/model' } }
    f.store.insertDispatch({ activationId: job.id, n: 2, kind: 'subagent', mainN: 1, clientRequestId: `${job.id}:s2`, threadId: 'legacy-sub', prompt: { text: 'Find the prices.', subagent: spec } as never, policyDigest: f.store.activation(job.id)!.grantDigest })
    const sent = await f.runs.dispatch({ kind: 'send', threadId: 'legacy-sub', clientRequestId: `${job.id}:s2:run`, source: 'bot' })
    if (sent.status !== 'accepted') throw new Error('rejected')
    f.runs.markStarting(sent.runId)
    f.runs.markRunning(sent.runId)
    f.store.run('UPDATE bot_dispatches SET run_id = ?, started_at = ? WHERE activation_id = ? AND n = 2', sent.runId, f.clock.now, job.id)
    f.clock.now += 3_000
    await restart()
    expect(f.runs.getRun(sent.runId)).toMatchObject({ status: 'interrupted' })
    expect(f.store.dispatch(job.id, 2)).toMatchObject({ kind: 'subagent', usedMs: 3_000, settledBy: 'run', endedAt: expect.any(String) })
    const charged = f.store.counters(job.id).activeMs
    await restart()
    expect(f.store.counters(job.id).activeMs).toBe(charged)
    expect(f.store.dispatch(job.id, 2)!.usedMs).toBe(3_000)
  })

  it('without the bot port nothing starts: refused, and nothing is written in either database', async () => {
    const job = await work('w1')
    f.runs.setBotPort(null)
    expect(await job.prepared.authority.subagents!.start({ title: 'Prices', brief: 'Find the prices.' })).toMatchObject({ refused: expect.stringMatching(/Bots are not running here/) })
    expect(subagentRuns(f, job.id)).toEqual([])
    expect(ledger(job.id)).toEqual([])
    expect(f.runs.deliverBotResults()).toEqual([])
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
    const effect = f.outbox.listForRun(queued!).find((entry) => entry.kind === 'turn.start')!
    await f.bots.refresh(effect.payload as never)
    expect(f.bots.prepare(effect.payload as never)).toMatchObject({ code: 'bot_grant_revoked' })
  })
})
