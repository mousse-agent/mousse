/**
 * The count of agent messages in a row (SPEC §15.1) is carried by the runs that carry on agent work: a wake that
 * delivers a subagent's result, a provider's own continuation and the resume after a usage-limit pause. A person's
 * message starts a new count, so does a person's "Continue".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { inheritedAgentHops } from '../../src/mms/run/agentHops'
import type { AgentActor } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const actor = (hops: number): AgentActor => ({ kind: 'agent', threadId: 'sender', runId: 'run:thread:sender:ordinal:1', toolCallId: 'mcp:t', hops })

describe('agent hops carried by runs that continue agent work', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** A run an agent's message started on `threadId`, now running, with `hops` agent messages behind it. */
  const agentRun = async (fx: DelegationFixture, threadId: string, hops: number, id = 'a') => {
    const sent = await fx.engine.dispatch({ kind: 'send', threadId, clientRequestId: `agent-send:${threadId}:${id}`, source: 'mcp', actor: actor(hops) })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    fx.engine.markStarting(sent.runId)
    return fx.engine.markRunning(sent.runId)
  }

  it('a wake that delivers a subagent\'s result continues the count of the run that delegated', async () => {
    f = delegationFixture()
    const parent = await agentRun(f, 'parent', 3)
    const child = await f.delegate(parent.runId, 'call-1')
    f.finish(child.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    const wake = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.getRun(wake)).toMatchObject({ source: 'wake', outcome: { agentHops: 3 } })
    // It is carrying the chain on, not an agent's message.
    expect(f.engine.getRun(wake)?.outcome?.sentByAgent).toBeUndefined()
  })

  it('a wake after a person\'s run starts no count', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    f.finish(child.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    const wake = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.getRun(wake)?.outcome?.agentHops).toBeUndefined()
  })

  it('a provider\'s own continuation continues the count; a person\'s message and a person\'s run do not', async () => {
    f = delegationFixture()
    const run = await agentRun(f, 't1', 2)
    f.engine.markTerminal(run.runId, 'completed')
    const continued = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'continuation:1', source: 'provider-continuation' })
    if (continued.status !== 'accepted') throw new Error('rejected')
    expect(f.engine.getRun(continued.runId)).toMatchObject({ outcome: { agentHops: 2 } })
    expect(f.engine.getRun(continued.runId)?.outcome?.sentByAgent).toBeUndefined()
    f.engine.markStarting(continued.runId)
    f.engine.markRunning(continued.runId)
    f.engine.markTerminal(continued.runId, 'completed')
    // The count survives a second continuation, and ends with a person's message.
    const again = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'continuation:2', source: 'provider-continuation' })
    if (again.status !== 'accepted') throw new Error('rejected')
    expect(f.engine.getRun(again.runId)?.outcome?.agentHops).toBe(2)
    f.engine.markStarting(again.runId)
    f.engine.markRunning(again.runId)
    f.engine.markTerminal(again.runId, 'completed')
    const person = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'person', source: 'gui' })
    if (person.status !== 'accepted') throw new Error('rejected')
    expect(f.engine.getRun(person.runId)?.outcome?.agentHops).toBeUndefined()
    f.engine.markStarting(person.runId)
    f.engine.markRunning(person.runId)
    f.engine.markTerminal(person.runId, 'completed')
    const after = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'continuation:3', source: 'provider-continuation' })
    if (after.status !== 'accepted') throw new Error('rejected')
    expect(f.engine.getRun(after.runId)?.outcome?.agentHops).toBeUndefined()
  })

  it.each([
    ['resume', 'auto'],
    ['resume_now', 'user']
  ] as const)('the %s run after a usage-limit pause continues the paused run\'s count', async (source) => {
    f = delegationFixture()
    const run = await agentRun(f, 't1', 3)
    const until = '2026-10-12T01:00:00.000Z'
    f.engine.pauseRun({ runId: run.runId, pause: { reason: 'usage_limit', until, estimated: false, provider: 'claude', limitKind: 'five_hour', count: 1, autoResume: true }, resumeAt: until })
    const resumed = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: `queue:resume:${run.runId}`, source, continuationOfRunId: run.runId })
    if (resumed.status !== 'accepted') throw new Error('rejected')
    expect(f.engine.getRun(resumed.runId)).toMatchObject({ outcome: { continuationOf: run.runId, resumedFromPause: source === 'resume' ? 'auto' : 'user', agentHops: 3 } })
    expect(f.engine.getRun(resumed.runId)?.outcome?.sentByAgent).toBeUndefined()
  })

  it('only the sources that carry on work inherit: a person\'s Continue and any other source start at zero', async () => {
    f = delegationFixture()
    const run = await agentRun(f, 't1', 3)
    f.engine.markTerminal(run.runId, 'completed')
    for (const source of ['gui', 'cli', 'continue', 'delegation', 'integration', 'schedule', 'remote'])
      expect(inheritedAgentHops(f.store, 't1', source, run.runId), source).toBeUndefined()
    for (const source of ['wake', 'provider-continuation']) expect(inheritedAgentHops(f.store, 't1', source), source).toBe(3)
    for (const source of ['resume', 'resume_now']) expect(inheritedAgentHops(f.store, 't1', source, run.runId), source).toBe(3)
  })
})
