/**
 * A bot's work subagent is a delegation in the run database (Run DB v29): the run engine writes its lineage, its run, its
 * `running` row with the bot, the root activation and the narrowing it inherits, and its bot `turn.start` in one
 * transaction, and asks the bots through their port (`BotExecutionPort`). Its result is the port's to deliver: rule 4,
 * boundary delivery and a wake turn never take it, and its inbox row is acknowledged only once the port recorded it.
 * Without a port nothing starts or is delivered; ordinary delegations never depend on the port at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverAtToolBoundary, wakeThreads } from '../../src/mms/run/delegation/wake'
import type { BotExecutionPort, BotSubagentOutcome } from '../../src/mms/run/delegation/botPort'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { isBotTurnPayload, type BotDelegation } from '../../src/mms/run/types'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const BOT: BotDelegation = { botId: 'bot-1', rootActivationId: 'act-1', access: 'ask', readOnly: false }

/** A stub of the bots' side: it records what it is asked, and answers as `answer` says. */
function stubPort() {
  const reserved: string[] = []
  const settled: BotSubagentOutcome[] = []
  const port = {
    reserved,
    settled,
    authorize: { ok: true } as ReturnType<BotExecutionPort['authorizeSubagent']>,
    answer: 'record' as 'record' | 'refuse' | 'throw',
    authorizeSubagent() {
      return port.authorize
    },
    reserveSubagent(input: { childRunId: string }) {
      reserved.push(input.childRunId)
    },
    onSubagentSettled(_root: string, _thread: string, outcome: BotSubagentOutcome) {
      if (port.answer === 'throw') throw new Error('bots.db is locked')
      if (port.answer === 'refuse') return false
      settled.push(outcome)
      return true
    }
  }
  return port
}

describe('a bot subagent in the run database', () => {
  let fx: DelegationFixture
  let port: ReturnType<typeof stubPort>
  beforeEach(() => {
    fx = delegationFixture()
    port = stubPort()
    fx.engine.setBotPort(port)
  })
  afterEach(() => fx.dispose())

  const botDelegate = async (parentRunId: string, call: string, childThreadId = `sub-${call}`, newChild = true) =>
    fx.engine.requestBotDelegation({
      parentThreadId: fx.engine.getRun(parentRunId)!.threadId, parentRunId, childThreadId, newChild, clientRequestId: `botsub:${call}`,
      prompt: 'Find the prices.', instanceId: 'pi:openrouter', model: 'some/model', bot: BOT, subagent: { title: 'Prices' }
    })

  it('writes the delegation with its bot, root activation and inherited narrowing, its run and its bot turn together, and reserves before anything dispatches it', async () => {
    const work = await fx.runningRun('bot-work')
    const accepted = await botDelegate(work.runId, 'c1')
    expect(fx.engine.delegations.get(accepted.delegationId)).toMatchObject({ status: 'running', parentRunId: work.runId, bot: BOT })
    expect(fx.engine.delegations.getLineage(accepted.childThreadId)).toMatchObject({ parentThreadId: 'bot-work', relationship: 'subagent' })
    const effect = fx.outbox.listForRun(accepted.childRunId).find((entry) => entry.kind === 'turn.start')!
    expect(isBotTurnPayload(effect.payload)).toBe(true)
    expect(effect.payload).toMatchObject({ kind: 'bot', activationId: 'act-1', dispatchN: 0, delegationId: accepted.delegationId, subagent: { title: 'Prices' }, prompt: 'Find the prices.' })
    // Reserved right after the commit, before the effect could be claimed.
    expect(port.reserved).toEqual([accepted.childRunId])
    expect(fx.outbox.get(effect.effectId)!.status).toBe('pending')
    // A retry of the same call starts nothing new and reserves nothing again.
    expect(await botDelegate(work.runId, 'c1')).toMatchObject({ delegationId: accepted.delegationId })
    expect(port.reserved).toHaveLength(1)
    // An ordinary delegation carries no bot.
    const plain = await fx.delegate(work.runId, 'plain')
    expect(fx.engine.delegations.get(plain.delegationId)!.bot).toBeUndefined()
  })

  it('without a port, or when the bots refuse, nothing is written', async () => {
    const work = await fx.runningRun('bot-work')
    port.authorize = { ok: false, code: 'bot_subagent_refused', message: 'Your turn is ending.' }
    await expect(botDelegate(work.runId, 'c1')).rejects.toMatchObject({ reason: 'bot_subagent_refused' })
    fx.engine.setBotPort(null)
    await expect(botDelegate(work.runId, 'c2')).rejects.toMatchObject({ reason: 'bot_port_missing' })
    expect(fx.engine.delegations.listForParentRun(work.runId)).toEqual([])
    expect(fx.engine.store.listRuns('sub-c1')).toEqual([])
  })

  it('a bot subagent starts its own only through the bot port, only for its own work, and only when the port allows it', async () => {
    const work = await fx.runningRun('bot-work')
    const accepted = await botDelegate(work.runId, 'c1')
    fx.engine.markStarting(accepted.childRunId)
    fx.engine.markRunning(accepted.childRunId)
    // Not as a thread does.
    await expect(fx.delegate(accepted.childRunId, 'deeper')).rejects.toMatchObject({ reason: 'bot_subagent_nesting' })
    // Not for another work.
    const other = (call: string, bot: BotDelegation) => fx.engine.requestBotDelegation({
      parentThreadId: accepted.childThreadId, parentRunId: accepted.childRunId, childThreadId: `sub-${call}`, newChild: true, clientRequestId: `botsub:${call}`,
      prompt: 'Find the prices.', instanceId: 'pi:openrouter', model: 'some/model', bot, subagent: { title: 'Prices' }
    })
    await expect(other('foreign', { ...BOT, rootActivationId: 'act-2' })).rejects.toMatchObject({ reason: 'bot_subagent_nesting' })
    // Not when the port refuses, nor without it.
    port.authorize = { ok: false, code: 'bot_subagent_refused', message: 'Your turn is ending.' }
    await expect(botDelegate(accepted.childRunId, 'refused')).rejects.toMatchObject({ reason: 'bot_subagent_refused' })
    fx.engine.setBotPort(null)
    await expect(botDelegate(accepted.childRunId, 'portless')).rejects.toMatchObject({ reason: 'bot_port_missing' })
    expect(fx.engine.delegations.listForParentRun(accepted.childRunId)).toEqual([])
    // Through the port: under the subagent's run and thread, in the work's chain.
    fx.engine.setBotPort(port)
    port.authorize = { ok: true }
    const nested = await botDelegate(accepted.childRunId, 'deeper-bot')
    expect(fx.engine.delegations.get(nested.delegationId)).toMatchObject({ parentRunId: accepted.childRunId, parentThreadId: accepted.childThreadId, bot: BOT })
    expect(fx.engine.delegations.getLineage(nested.childThreadId)).toMatchObject({ parentThreadId: accepted.childThreadId, relationship: 'subagent' })
    // An ordinary subagent still starts its own.
    const plain = await fx.delegate(work.runId, 'plain')
    fx.engine.markStarting(plain.childRunId)
    fx.engine.markRunning(plain.childRunId)
    await expect(fx.delegate(plain.childRunId, 'nested')).resolves.toHaveProperty('delegationId')
  })

  it('more work for a finished subagent goes on its thread; one still working is busy', async () => {
    const work = await fx.runningRun('bot-work')
    const first = await botDelegate(work.runId, 'c1')
    await expect(botDelegate(work.runId, 'c2', first.childThreadId, false)).rejects.toMatchObject({ reason: 'subagent_busy' })
    fx.finish(first.childRunId, 'Prices: 199.')
    const second = await botDelegate(work.runId, 'c2', first.childThreadId, false)
    expect(second.childThreadId).toBe(first.childThreadId)
    expect(fx.engine.delegations.listForRootActivation('act-1').map((row) => row.childRunId)).toEqual([first.childRunId, second.childRunId])
  })

  it.each([
    ['its work\'s turn runs (a steer)', true],
    ['its work\'s turn ended (a wake)', false]
  ] as const)('a result while %s is never taken by rule 4, boundary delivery or a wake; it is acknowledged only once the port records it', async (_name, live) => {
    const work = await fx.runningRun('bot-work')
    const accepted = await botDelegate(work.runId, 'c1')
    fx.finish(accepted.childRunId, 'Prices: 199, 249.')
    if (!live) fx.engine.markTerminal(work.runId, 'completed')
    const [row] = fx.engine.inbox.listPending('bot-work')
    expect(row).toMatchObject({ kind: 'child_result', status: 'pending' })
    // Rule 4 and boundary delivery leave it.
    const report = wakeThreads(fx.store, fx.outbox, () => PI_TEST_CAPABILITIES, fx.now())
    expect([...report.wakes, ...report.steers]).toEqual([])
    if (live) expect(deliverAtToolBoundary(fx.store, fx.outbox, { threadId: 'bot-work', runId: work.runId, caps: CLAUDE_SUBSCRIPTION_CAPABILITIES, plan: (rows) => planWakeNotice(rows) })).toBeNull()
    expect(fx.engine.store.listRuns('bot-work')).toHaveLength(1)
    expect(fx.engine.inbox.get(row!.inboxId)!.status).toBe('pending')
    // The bots can't record it (bots.db locked, a refusal): it stays pending, and the delegation waits.
    port.answer = 'throw'
    expect(fx.engine.deliverBotResults()).toEqual([])
    port.answer = 'refuse'
    expect(fx.engine.deliverBotResults()).toEqual([])
    expect(fx.engine.inbox.get(row!.inboxId)!.status).toBe('pending')
    expect(fx.engine.delegations.get(accepted.delegationId)!.status).toBe('result_available')
    // Recorded: acknowledged with its delegation, once.
    port.answer = 'record'
    expect(fx.engine.deliverBotResults()).toEqual([row!.inboxId])
    expect(port.settled).toEqual([{ delegationId: accepted.delegationId, childRunId: accepted.childRunId, result: expect.objectContaining({ runStatus: 'completed', text: 'Prices: 199, 249.' }) }])
    expect(fx.engine.inbox.get(row!.inboxId)!.status).toBe('acknowledged')
    expect(fx.engine.delegations.get(accepted.delegationId)!.status).toBe('acknowledged')
    expect(fx.engine.deliverBotResults()).toEqual([])
  })

  it('a Stop of a subagent\'s thread is told through the port too, never as a notice on the work\'s thread', async () => {
    const work = await fx.runningRun('bot-work')
    const accepted = await botDelegate(work.runId, 'c1')
    fx.engine.markStarting(accepted.childRunId)
    fx.engine.markRunning(accepted.childRunId)
    fx.engine.stopSubtree({ threadId: accepted.childThreadId, reason: 'user', clientRequestId: 'stop-sub' })
    const notice = fx.engine.inbox.listPending('bot-work').find((row) => row.kind === 'reconcile_notice')
    expect(notice).toBeDefined()
    expect(wakeThreads(fx.store, fx.outbox, () => PI_TEST_CAPABILITIES, fx.now()).steers).toEqual([])
    expect(fx.engine.deliverBotResults()).toEqual([notice!.inboxId])
    expect(port.settled).toEqual([expect.objectContaining({ childRunId: accepted.childRunId })])
    expect(fx.engine.inbox.get(notice!.inboxId)!.status).toBe('acknowledged')
  })

  it('without a port no result is delivered or consumed', async () => {
    const work = await fx.runningRun('bot-work')
    const accepted = await botDelegate(work.runId, 'c1')
    fx.finish(accepted.childRunId)
    fx.engine.setBotPort(null)
    expect(fx.engine.deliverBotResults()).toEqual([])
    expect(fx.engine.inbox.listPending('bot-work')).toHaveLength(1)
    expect(fx.engine.delegations.get(accepted.delegationId)!.status).toBe('result_available')
  })
})

describe('ordinary delegations never depend on the bots', () => {
  let fx: DelegationFixture
  beforeEach(() => {
    fx = delegationFixture()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fx.dispose()
  })

  it('with a port whose every call throws (bots.db unreadable), a plain subagent starts, its result wakes its parent, and the reconciler\'s other rules run', async () => {
    const broken: BotExecutionPort = {
      authorizeSubagent: () => { throw new Error('bots.db unreadable') },
      reserveSubagent: () => { throw new Error('bots.db unreadable') },
      onSubagentSettled: () => { throw new Error('bots.db unreadable') }
    }
    fx.engine.setBotPort(broken)
    const reconciler = new Reconciler({ store: fx.store, outbox: fx.outbox, tools: fx.tools, now: fx.now, capabilitiesFor: () => PI_TEST_CAPABILITIES, botResults: () => fx.engine.deliverBotResults() })
    // Its delivery rule failing outright (the bots' side of the run database unreadable) holds up no other rule.
    const failing = new Reconciler({ store: fx.store, outbox: fx.outbox, tools: fx.tools, now: fx.now, capabilitiesFor: () => PI_TEST_CAPABILITIES, botResults: () => { throw new Error('bots.db unreadable') } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parent = await fx.runningRun('parent')
    const accepted = await fx.delegate(parent.runId, 'plain')
    fx.finish(accepted.childRunId, 'Plain result.')
    fx.engine.markTerminal(parent.runId, 'completed')
    const report = failing.runOnce()
    expect(report.botResults).toEqual([])
    expect(report.wakes.wakes).toHaveLength(1)
    // The bots' own delivery, over a port that throws, consumes nothing of it either.
    expect(reconciler.runOnce().botResults).toEqual([])
    expect(fx.engine.inbox.listForDelegation(accepted.delegationId)[0]!.status).toBe('delivered')
  })
})
