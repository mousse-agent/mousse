/**
 * What the Run Engine records when another thread's agent sends, steers or stops (docs/run-engine/SPEC.md
 * §15.1): the `agent.action` event is written in the same transaction as the change, a replay writes no
 * second one, an agent's Stop settles as a user's does, and a paused thread is never un-paused by an
 * agent's message.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readRunResultText } from '../../src/mms/run/delegation/hold'
import { outcomeOfRun } from '../../src/mms/run/delegation/subagentView'
import { stoppedByPerson, type AgentActor, type RunPause } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const actor = (overrides: Partial<AgentActor> = {}): AgentActor => ({ kind: 'agent', threadId: 'caller', runId: 'run:caller', toolCallId: 'mcp:call-1', ...overrides })
const PAUSE: RunPause = { reason: 'usage_limit', until: '2026-10-12T05:00:00.000Z', estimated: true, count: 1, autoResume: false }

describe('agent actions in the Run Engine (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const agentEvents = (threadId: string) => fx!.engine.listEvents(threadId).filter((event) => event.type === 'agent.action')

  describe('send', () => {
    it('writes the agent.action event with the run, in the same transaction, without the message text', async () => {
      fx = delegationFixture()
      const sent = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'a private plan', actor: actor() })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const events = agentEvents('target')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        runId: sent.runId,
        payload: { action: 'sent_message', actorThreadId: 'caller', actorRunId: 'run:caller', toolCallId: 'mcp:call-1', runId: sent.runId, length: 14 }
      })
      expect(JSON.stringify(events[0].payload)).not.toContain('private plan')
      // The run exists, and so does its audit row; the receipt returned the same.
      expect(fx.engine.getRun(sent.runId)).toMatchObject({ threadId: 'target', source: 'mcp', status: 'queued' })
    })

    it('a send whose audit row cannot be written leaves no run behind', async () => {
      fx = delegationFixture()
      const original = fx.store.appendEvent.bind(fx.store)
      fx.store.appendEvent = ((input: Parameters<typeof original>[0]) => {
        if (input.type === 'agent.action') throw new Error('disk full')
        return original(input)
      }) as typeof original
      await expect(fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor() })).rejects.toThrow('disk full')
      expect(fx.engine.listRuns('target')).toEqual([])
      expect(fx.store.getReceipt('send-1')).toBeNull()
    })

    it('a retry with the same clientRequestId returns the first run and writes no second event', async () => {
      fx = delegationFixture()
      const first = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor() })
      const again = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor({ runId: 'run:caller:2', toolCallId: 'mcp:call-2' }) })
      expect(again).toMatchObject({ status: 'accepted', replayed: true, runId: (first as { runId: string }).runId })
      expect(agentEvents('target')).toHaveLength(1)
      expect(fx.engine.listRuns('target')).toHaveLength(1)
    })

    it('a send without an actor writes no agent.action event', async () => {
      fx = delegationFixture()
      await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'gui', prompt: 'x' })
      expect(agentEvents('target')).toEqual([])
    })

    it('is refused while the thread is paused, leaving the pause, the run and the audit log as they were; a person\'s message still ends the pause', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      fx.engine.pauseRun({ runId: run.runId, pause: PAUSE })
      const seq = fx.engine.maxSeq('target')

      const refused = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor() })
      expect(refused).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      expect(fx.engine.getRun(run.runId)?.status).toBe('paused')
      expect(fx.engine.listRuns('target')).toHaveLength(1)
      expect(fx.engine.maxSeq('target')).toBe(seq)
      expect(agentEvents('target')).toEqual([])
      expect(fx.store.getReceipt('send-1')).toBeNull()

      // The same message from a person ends the pause, as it always did.
      const typed = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-2', source: 'gui', prompt: 'x' })
      expect(typed).toMatchObject({ status: 'accepted' })
      expect(fx.engine.getRun(run.runId)?.status).toBe('cancelled')
    })
  })

  describe('stop', () => {
    it('records the Stop as the agent\'s: the run is marked, one agent.action event is written, and the run ends interrupted by `agent`', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      const stopped = fx.engine.stopSubtree({ threadId: 'target', reason: 'agent', runId: run.runId, clientRequestId: 'stop-1', actor: actor() })
      expect(stopped).toMatchObject({ status: 'stopped', activeRuns: [{ threadId: 'target', runId: run.runId }] })
      expect(fx.engine.getRun(run.runId)?.outcome).toMatchObject({ stopRequested: true, stopRequestedBy: 'agent' })
      expect(agentEvents('target')).toEqual([
        expect.objectContaining({ runId: run.runId, payload: expect.objectContaining({ action: 'stopped_run', actorThreadId: 'caller', toolCallId: 'mcp:call-1', activeRuns: 1, cancelledRuns: 0 }) })
      ])
      // The turn that was aborted writes `user`, as every Stop's turn does; the terminal write keeps the agent.
      fx.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'user' })
      expect(fx.engine.getRun(run.runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'agent', stopRequestedBy: 'agent' } })
      expect(stoppedByPerson(fx.engine.getRun(run.runId)!.outcome)).toBe(true)
    })

    it('a Stop of a person is still the person\'s, and writes no agent.action event', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      fx.engine.stopSubtree({ threadId: 'target', reason: 'user', runId: run.runId })
      fx.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'user' })
      expect(fx.engine.getRun(run.runId)?.outcome?.interruptedBy).toBe('user')
      expect(agentEvents('target')).toEqual([])
    })

    it('a replayed Stop returns the first result and writes no second event', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      const first = fx.engine.stopSubtree({ threadId: 'target', reason: 'agent', runId: run.runId, clientRequestId: 'stop-1', actor: actor() })
      const again = fx.engine.stopSubtree({ threadId: 'target', reason: 'agent', runId: run.runId, clientRequestId: 'stop-1', actor: actor({ toolCallId: 'mcp:call-2' }) })
      expect(first.replayed).toBe(false)
      expect(again).toMatchObject({ status: 'stopped', replayed: true })
      expect(agentEvents('target')).toHaveLength(1)
    })

    it('a Stop of a run that is not the active one changes nothing and is not an agent action', async () => {
      fx = delegationFixture()
      const old = await fx.runningRun('target')
      fx.finish(old.runId)
      const next = await fx.runningRun('target')
      const ignored = fx.engine.stopSubtree({ threadId: 'target', reason: 'agent', runId: old.runId, clientRequestId: 'stop-1', actor: actor() })
      expect(ignored).toMatchObject({ status: 'ignored', reason: 'run_not_active' })
      expect(agentEvents('target')).toEqual([])
      expect(fx.engine.getRun(next.runId)?.outcome?.stopRequested).toBeUndefined()
    })

    it('ends a paused run and its pause, as the agent\'s Stop', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      fx.engine.pauseRun({ runId: run.runId, pause: PAUSE })
      const stopped = fx.engine.stopSubtree({ threadId: 'target', reason: 'agent', runId: run.runId, clientRequestId: 'stop-1', actor: actor() })
      expect(stopped).toMatchObject({ status: 'stopped', cancelledRuns: [{ threadId: 'target', runId: run.runId }] })
      expect(fx.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'agent', pause: { endedBy: 'stop' } } })
      expect(agentEvents('target')).toHaveLength(1)
    })

    it('cancels a queued run of the subtree as the agent\'s, and the same through the control command', async () => {
      fx = delegationFixture()
      const parent = await fx.runningRun('parent')
      const child = await fx.delegate(parent.runId, 'call-1')
      fx.engine.stopSubtree({ threadId: 'parent', reason: 'agent', actor: actor() })
      expect(fx.engine.getRun(child.childRunId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'agent' } })

      const run = await fx.runningRun('target')
      const result = await fx.engine.dispatch({ kind: 'stop', threadId: 'target', clientRequestId: 'stop-2', runId: run.runId, actor: actor() })
      expect(result).toMatchObject({ status: 'accepted' })
      expect(fx.engine.getRun(run.runId)?.outcome).toMatchObject({ stopRequested: true, stopRequestedBy: 'agent' })
      expect(agentEvents('target')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ action: 'stopped_run' }) })])
    })
  })

  describe('steer', () => {
    it('writes the agent.action event with the steer, with its length and never its text; a replay writes no second', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      const steered = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-1', runId: run.runId, actor: actor(), textLength: 11 })
      expect(steered).toMatchObject({ status: 'accepted', replayed: false })
      const again = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-1', runId: run.runId, actor: actor(), textLength: 11 })
      expect(again).toMatchObject({ status: 'accepted', replayed: true })
      expect(agentEvents('target')).toEqual([
        expect.objectContaining({ runId: run.runId, payload: { action: 'steered_run', actorThreadId: 'caller', actorRunId: 'run:caller', toolCallId: 'mcp:call-1', runId: run.runId, length: 11 } })
      ])
    })

    it('a steer of a stale run, or of a paused one, is ignored without an agent.action event', async () => {
      fx = delegationFixture()
      const old = await fx.runningRun('target')
      fx.finish(old.runId)
      const paused = await fx.runningRun('target')
      fx.engine.pauseRun({ runId: paused.runId, pause: PAUSE })
      for (const [id, runId] of [['steer-old', old.runId], ['steer-paused', paused.runId]] as const) {
        const result = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: id, runId, actor: actor() })
        expect(result, id).toMatchObject({ status: 'ignored', reason: 'run_not_active', activeRunId: null })
      }
      expect(agentEvents('target')).toEqual([])
      expect(fx.engine.getRun(paused.runId)?.status).toBe('paused')
    })
  })

  describe('an agent\'s Stop settles as a user\'s', () => {
    it('is a stopped task of its parent, never an interrupted or failed one', () => {
      expect(outcomeOfRun('interrupted', 'agent')).toBe('stopped')
      expect(outcomeOfRun('interrupted', 'user')).toBe('stopped')
      expect(outcomeOfRun('interrupted', 'daemon_restart')).toBe('interrupted')
      expect(stoppedByPerson({ interruptedBy: 'agent' })).toBe(true)
      expect(stoppedByPerson({ interruptedBy: 'provider' })).toBe(false)
      expect(stoppedByPerson(undefined)).toBe(false)
    })

    it('an integration run an agent stopped leaves no "interrupted" notice for its thread, as a user\'s Stop leaves none', async () => {
      fx = delegationFixture()
      const integration = async (threadId: string) => {
        const sent = await fx!.engine.dispatch({ kind: 'send', threadId, clientRequestId: `integrate:${threadId}`, source: 'integration' })
        if (sent.status !== 'accepted') throw new Error('send rejected')
        fx!.engine.markStarting(sent.runId)
        return fx!.engine.markRunning(sent.runId)
      }
      const inboxRows = (threadId: string) => Number(fx!.store.db.statement('SELECT COUNT(*) AS n FROM inbox WHERE thread_id = ?').get(threadId)?.n)
      const stopped = await integration('stopped')
      fx.engine.stopSubtree({ threadId: 'stopped', reason: 'agent', runId: stopped.runId, actor: actor() })
      fx.engine.markTerminal(stopped.runId, 'interrupted', { interruptedBy: 'user' })
      expect(fx.engine.getRun(stopped.runId)?.outcome?.interruptedBy).toBe('agent')
      expect(inboxRows('stopped')).toBe(0)
      // The same run cut off by something else still owes its thread the notice.
      const cutOff = await integration('cut-off')
      fx.engine.markTerminal(cutOff.runId, 'interrupted', { interruptedBy: 'provider' })
      expect(inboxRows('cut-off')).toBe(1)
    })
  })

  describe('the final text of a run', () => {
    it('is kept for every conversational run, bound to the run it came from', async () => {
      fx = delegationFixture()
      const first = await fx.runningRun('target')
      fx.finish(first.runId, 'first answer')
      const second = await fx.runningRun('target')
      fx.finish(second.runId, 'second answer')
      expect(readRunResultText(fx.store, 'target', first.runId)).toBe('first answer')
      expect(readRunResultText(fx.store, 'target', second.runId)).toBe('second answer')
    })

    it('is kept for a run an agent sent, and is cut to the delegation result limit', async () => {
      fx = delegationFixture()
      const sent = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor() })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      fx.finish(sent.runId, 'y'.repeat(100_000))
      const text = readRunResultText(fx.store, 'target', sent.runId)
      expect(text?.startsWith('yyyy')).toBe(true)
      expect(text!.length).toBeLessThan(100_000)
    })

    it('does not make an `mcp` run the answer of a subagent\'s task', async () => {
      fx = delegationFixture()
      const parent = await fx.runningRun('parent')
      const child = await fx.delegate(parent.runId, 'call-1')
      fx.finish(child.childRunId, 'the task result')
      const later = await fx.engine.dispatch({ kind: 'send', threadId: child.childThreadId, clientRequestId: 'later', source: 'mcp', prompt: 'x' })
      if (later.status !== 'accepted') throw new Error('send rejected')
      fx.finish(later.runId, 'a later note')
      // The delegation still publishes the task's own run.
      expect(fx.engine.delegations.get(child.delegationId)?.result?.text).toBe('the task result')
    })
  })
})
