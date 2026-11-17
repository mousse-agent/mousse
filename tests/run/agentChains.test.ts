/**
 * The causal chain record (issues #1442, #1443): one chain per run no agent message led to, carried by every run that
 * carries its work on (a delegation, a wake, a provider's continuation, a resume, an agent's message), counted to its
 * budget, and holding what comes past it for the person's Continue or Stop. Nothing is dropped. The end-to-end paths
 * (thread_send, thread_create, notices, the card) are in threadActionsDaemon, threadCreateDaemon and
 * threadSettleNoticeDaemon.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentChains, CHAIN_BUDGET, ChainBudgetReached, chainIdOf, type ChainMessage } from '../../src/mms/run/AgentChains'
import { inheritedAgentChain } from '../../src/mms/run/agentHops'
import { agentMessage } from '../../src/mms/run/mcp/appTools/agentMessage'
import { isQuietNoteRow, type AgentActor, type ChainHoldSettledPayload } from '../../src/mms/run/types'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { spendChain } from './chainFixture'

describe('the chain record', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** A run a person started on `threadId`, running: the root of a chain of its own. */
  const personRun = async (fx: DelegationFixture, threadId: string, key = 'person') => {
    const sent = await fx.engine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    fx.engine.markStarting(sent.runId)
    return fx.engine.markRunning(sent.runId)
  }
  const message = (chainId: string, key: string, extra: Partial<ChainMessage> = {}): ChainMessage =>
    ({ chainId, senderThreadId: 'a', senderRunId: null, targetThreadId: 'b', kind: 'work', requestKey: key, payload: { key }, ...extra })

  it('counts each message to the budget; past it a message is held, every later one waits behind it, and a retry finds its hold', async () => {
    f = delegationFixture()
    const root = await personRun(f, 'a')
    const chains = f.engine.chains
    const chainId = chainIdOf(f.store, root.runId)
    expect(chainId).toBe(`chain:${root.runId}`)
    const seqs = Array.from({ length: CHAIN_BUDGET }, (_, index) => {
      // Open until its budget is spent, and checking counts nothing.
      chains.assertOpen(chainId)
      return chains.admit(message(chainId, `m${index}`))
    })
    expect(seqs.map((admission) => admission.status === 'go' && admission.seq)).toEqual(Array.from({ length: CHAIN_BUDGET }, (_, index) => index + 1))
    // It started where its run ran.
    expect(chains.get(chainId)).toMatchObject({ rootThreadId: 'a', rootRunId: root.runId, used: CHAIN_BUDGET, total: CHAIN_BUDGET })

    const held = chains.admit(message(chainId, 'past', { targetThreadId: 'c' }))
    expect(held).toMatchObject({ status: 'held', replayed: false, hold: { status: 'held', targetThreadId: 'c', payload: { key: 'past' } } })
    expect(chains.admit(message(chainId, 'past'))).toMatchObject({ status: 'held', replayed: true, hold: { holdId: held.status === 'held' ? held.hold.holdId : '' } })
    // A message that cannot wait (a steer, a queue edit) is refused instead.
    expect(() => chains.admit(message(chainId, 'steer', { holdable: false }))).toThrow(ChainBudgetReached)
    expect(() => chains.assertOpen(chainId)).toThrow(ChainBudgetReached)

    // A new budget (a person wrote, or Continue) still holds what waits: Continue sends it, and nothing else passes it.
    chains.restartBudget(chainId)
    expect(() => chains.assertOpen(chainId)).toThrow(ChainBudgetReached)
    expect(chains.admit(message(chainId, 'behind'))).toMatchObject({ status: 'held', replayed: false })
    expect(chains.heldFor(chainId).map((hold) => hold.requestKey)).toEqual(['past', 'behind'])
    expect(chains.heldChains('a').map((chain) => chain.chainId)).toEqual([chainId])
    expect(f.store.listEvents('a').filter((event) => event.type === 'chain.held')).toHaveLength(2)
  })

  it('a hold is settled once; Continue counts it in the new budget, a send that then fails ends failed, and a released step is given back', async () => {
    f = delegationFixture()
    const root = await personRun(f, 'a')
    const chains = f.engine.chains
    const chainId = chainIdOf(f.store, root.runId)
    spendChain(f.engine, chainId, 'a', 'b')
    const first = chains.admit(message(chainId, 'one'))
    const second = chains.admit(message(chainId, 'two'))
    if (first.status !== 'held' || second.status !== 'held') throw new Error('not held')
    chains.restartBudget(chainId)
    expect(chains.settleHold(first.hold.holdId, 'continued')).toBe(true)
    expect(chains.settleHold(first.hold.holdId, 'stopped')).toBe(false)
    expect(chains.countContinued(chainId)).toBe(1)
    chains.failContinued(first.hold.holdId, 'the thread was archived')
    expect(chains.getHold(first.hold.holdId)).toMatchObject({ status: 'failed', result: { reason: 'the thread was archived' } })
    // Only a hold Continue claimed can fail.
    chains.failContinued(second.hold.holdId, 'nope')
    expect(chains.getHold(second.hold.holdId)?.status).toBe('held')
    expect(chains.settleHold(second.hold.holdId, 'stopped')).toBe(true)
    expect(chains.heldChains()).toEqual([])
    // Nothing is held now: the chain goes on in its new budget.
    expect(chains.admit(message(chainId, 'three'))).toMatchObject({ status: 'go', seq: 2 })
    chains.release(chainId)
    expect(chains.get(chainId)).toMatchObject({ used: 1 })
  })

  it('a delegation, a wake, a provider\'s continuation and a resume carry the chain on; a person\'s run starts its own and gives the chain before it a new budget', async () => {
    f = delegationFixture()
    // An agent's message started this run: it is in the sender's chain.
    const actor: AgentActor = { kind: 'agent', threadId: 'sender', runId: 'run:sender', toolCallId: 'mcp:t', hops: 2, chain: 'chain:run:origin' }
    const sent = await f.engine.dispatch({ kind: 'send', threadId: 'p', clientRequestId: 'agent-send', source: 'mcp', actor })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    f.engine.markStarting(sent.runId)
    const parent = f.engine.markRunning(sent.runId)
    expect(parent.outcome?.agentChain).toBe('chain:run:origin')

    const child = await f.delegate(parent.runId, 'call-1')
    expect(f.engine.getRun(child.childRunId)?.outcome?.agentChain).toBe('chain:run:origin')
    f.finish(child.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    const wake = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.getRun(wake)).toMatchObject({ source: 'wake', outcome: { agentChain: 'chain:run:origin' } })
    f.engine.markStarting(wake)
    f.engine.markRunning(wake)
    f.engine.markTerminal(wake, 'completed')

    for (const source of ['provider-continuation', 'wake']) expect(inheritedAgentChain(f.store, 'p', source), source).toBe('chain:run:origin')
    for (const source of ['resume', 'resume_now']) expect(inheritedAgentChain(f.store, 'p', source, parent.runId), source).toBe('chain:run:origin')
    for (const source of ['gui', 'cli', 'continue', 'schedule', 'remote']) expect(inheritedAgentChain(f.store, 'p', source, parent.runId), source).toBeUndefined()

    // A person writes in the thread: their run is a chain of its own, and the chain the thread was in starts a new budget.
    f.engine.chains.admit(message('chain:run:origin', 'counted', { senderThreadId: 'p' }))
    expect(f.engine.chains.get('chain:run:origin')).toMatchObject({ used: 1 })
    const person = await personRun(f, 'p', 'person-p')
    expect(person.outcome?.agentChain).toBeUndefined()
    expect(chainIdOf(f.store, person.runId)).toBe(`chain:${person.runId}`)
    expect(f.engine.chains.get('chain:run:origin')).toMatchObject({ used: 0, total: 1 })
  })

  it('a sender hears what became of its held message with a notice that starts no turn and quotes the message as data', () => {
    f = delegationFixture()
    const payload: ChainHoldSettledPayload = { kind: 'chain_hold_settled', holdId: 'hold:1', outcome: 'stopped', targetThreadId: 'b', targetTitle: 'Reviewer', excerpt: 'Run the checks.' }
    const row = f.engine.inbox.append({ inboxId: 'chain-hold:hold:1', threadId: 'a', runId: null, kind: 'reconcile_notice', payload })
    expect(isQuietNoteRow(row)).toBe(true)
    const text = planWakeNotice([row]).text
    expect(text).toContain('<mousse_notice kind="chain_hold"')
    expect(text).toContain('The person stopped your message to "Reviewer" (thread b)')
    expect(text).toContain('<quoted from="held message">\nRun the checks.\n</quoted>')
    const failed = f.engine.inbox.append({ inboxId: 'chain-hold:hold:2', threadId: 'a', runId: null, kind: 'reconcile_notice', payload: { ...payload, holdId: 'hold:2', outcome: 'failed', targetTitle: null, reason: 'Thread not found' } })
    expect(planWakeNotice([failed]).text).toContain('could not be sent when the person chose Continue: Thread not found')
  })

  it('the agent label says where a message stands only past half the budget', () => {
    expect(agentMessage('t1', 'Lead', 'hi', undefined, { seq: CHAIN_BUDGET / 2, budget: CHAIN_BUDGET }).text).not.toContain('agents may exchange')
    expect(agentMessage('t1', 'Lead', 'hi', undefined, { seq: CHAIN_BUDGET / 2 + 1, budget: CHAIN_BUDGET }).text)
      .toContain(`It is message ${CHAIN_BUDGET / 2 + 1} of ${CHAIN_BUDGET} agents may exchange in this chain before a person decides whether it goes on.`)
  })
})

describe('AgentChains without a run for its id', () => {
  it('a chain id that names no run starts at its sender', () => {
    const f = delegationFixture()
    try {
      const chains = new AgentChains(f.store)
      expect(chains.admit({ chainId: 'chain:run:gone', senderThreadId: 's', senderRunId: 'run:s', targetThreadId: 't', kind: 'note', requestKey: 'k', payload: null })).toMatchObject({ status: 'go', seq: 1 })
      expect(chains.get('chain:run:gone')).toMatchObject({ rootThreadId: 's', rootRunId: 'run:gone' })
    } finally {
      f.dispose()
    }
  })
})
