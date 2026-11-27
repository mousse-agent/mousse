/**
 * The chain record (issue #1442): a run a person or a schedule started begins a chain, and every run that carries its
 * work on stays in it. The end-to-end paths (thread_send, thread_create, notes, notices, Continue and Stop) are in
 * threadActionsDaemon, threadCreateDaemon, threadSettleNoticeDaemon and queueEditDaemon.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CHAIN_BUDGET, chainIdOf } from '../../src/mms/run/AgentChains'
import type { AgentActor } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { spendChain } from './chainFixture'

describe('the chain a run belongs to', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  const started = (fx: DelegationFixture, runId: string) => {
    fx.engine.markStarting(runId)
    return fx.engine.markRunning(runId)
  }
  const dispatch = async (fx: DelegationFixture, threadId: string, key: string, source: string, extra: { actor?: AgentActor; continuationOfRunId?: string } = {}) => {
    const sent = await fx.engine.dispatch({ kind: 'send', threadId, clientRequestId: key, source, ...extra })
    if (sent.status !== 'accepted') throw new Error(`${source} send rejected`)
    return sent.runId
  }

  it('a delegation, the wake that delivers its result and a provider\'s continuation stay in the chain the agent\'s message carried', async () => {
    f = delegationFixture()
    const actor: AgentActor = { kind: 'agent', threadId: 'sender', runId: 'run:sender', toolCallId: 'mcp:t', hops: 1, chain: 'chain:run:origin' }
    const parent = started(f, await dispatch(f, 'p', 'agent-send', 'mcp', { actor }))
    expect(parent.outcome?.agentChain).toBe('chain:run:origin')

    const child = await f.delegate(parent.runId, 'call-1')
    expect(f.engine.getRun(child.childRunId)?.outcome?.agentChain).toBe('chain:run:origin')
    f.finish(child.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    const wake = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.getRun(wake)).toMatchObject({ source: 'wake', outcome: { agentChain: 'chain:run:origin' } })
    started(f, wake)
    f.engine.markTerminal(wake, 'completed')

    const continued = await dispatch(f, 'p', 'continuation', 'provider-continuation')
    expect(f.engine.getRun(continued)?.outcome?.agentChain).toBe('chain:run:origin')
  })

  it('a person\'s message starts a chain of its own and gives the chain the thread was in a new budget', async () => {
    f = delegationFixture()
    const root = started(f, await dispatch(f, 'p', 'first', 'gui'))
    const chainId = chainIdOf(f.store, root.runId)
    expect(chainId).toBe(`chain:${root.runId}`)
    spendChain(f.engine, chainId, 'p', 'q')
    expect(f.engine.chains.get(chainId)).toMatchObject({ used: CHAIN_BUDGET, rootThreadId: 'p' })
    f.engine.markTerminal(root.runId, 'completed')
    // A provider's continuation is not a person: the budget stays spent.
    started(f, await dispatch(f, 'p', 'continuation', 'provider-continuation'))
    expect(f.engine.chains.get(chainId)?.used).toBe(CHAIN_BUDGET)

    const person = await dispatch(f, 'p', 'person', 'gui')
    expect(f.engine.getRun(person)?.outcome?.agentChain).toBeUndefined()
    expect(f.engine.chains.get(chainId)).toMatchObject({ used: 0, total: CHAIN_BUDGET })
    // Agents still in that chain (on other threads) go on in the new budget.
    expect(f.engine.chains.admit({ chainId, senderThreadId: 'q', senderRunId: null, targetThreadId: 'r', kind: 'work', requestKey: 'after', payload: null })).toMatchObject({ status: 'go', seq: 1 })
  })
})
