/**
 * What the Run Engine records when another thread's agent sends, steers or stops (docs/run-engine/SPEC.md
 * §15.1): the `agent.action` event is written in the same transaction as the change, a replay writes no
 * second one, an agent's Stop settles as a user's does, and a paused thread is never un-paused by an
 * agent's message.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { deleteRunResults, readRunResultText } from '../../src/mms/run/delegation/hold'
import { outcomeOfRun } from '../../src/mms/run/delegation/subagentView'
import type { PermissionMode } from '../../src/shared/permissionMode'
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

  /** Binds the run's attempt to `mode`, as the turn does when it starts. */
  const bindTo = (runId: string, mode: PermissionMode) => {
    const attempt = fx!.engine.getRun(runId)!.activeAttemptId!
    fx!.store.setAttemptBinding(attempt, { policy: { permissionMode: mode } } as never)
  }

  describe('steer', () => {
    it('is refused for a run that has not bound its turn yet, and for a run bound to a looser mode than the sender\'s, inside the transaction', async () => {
      fx = delegationFixture()
      const sent = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'start', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      fx.engine.markStarting(sent.runId)
      // Starting: no binding, so no mode to compare with. Unknown is never "strictest".
      for (const ceiling of ['ask', 'full'] as const) {
        const result = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: `steer-${ceiling}`, runId: sent.runId, actor: actor(), ceiling })
        expect(result, ceiling).toMatchObject({ status: 'rejected', reason: 'steer_target_not_ready' })
      }
      fx.engine.markRunning(sent.runId)
      bindTo(sent.runId, 'full')
      const tooStrict = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-ask', runId: sent.runId, actor: actor(), ceiling: 'ask' })
      expect(tooStrict).toMatchObject({ status: 'rejected', reason: 'ceiling_exceeded' })
      // Without a ceiling the sender reads as the strictest mode.
      const none = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-none', runId: sent.runId, actor: actor() })
      expect(none).toMatchObject({ status: 'rejected', reason: 'ceiling_exceeded' })
      expect(agentEvents('target')).toEqual([])
      // Nothing was stored for a refused command: the same id may be used once the run is bound.
      expect(fx.store.getReceipt('steer-ask')).toBeNull()
      const ok = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-ask', runId: sent.runId, actor: actor(), ceiling: 'full' })
      expect(ok).toMatchObject({ status: 'accepted' })
      // A run bound to a stricter mode than the sender's, or to the same one, takes the steer.
      const strict = await fx.runningRun('strict')
      bindTo(strict.runId, 'ask')
      for (const ceiling of ['ask', 'accept_edits', 'full'] as const)
        expect(await fx.engine.dispatch({ kind: 'steer', threadId: 'strict', clientRequestId: `steer-strict-${ceiling}`, runId: strict.runId, actor: actor(), ceiling }), ceiling).toMatchObject({ status: 'accepted' })
    })

    it('writes the agent.action event with the steer, with its length and never its text; a replay writes no second', async () => {
      fx = delegationFixture()
      const run = await fx.runningRun('target')
      bindTo(run.runId, 'full')
      const steered = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-1', runId: run.runId, actor: actor(), textLength: 11, ceiling: 'full' })
      expect(steered).toMatchObject({ status: 'accepted', replayed: false })
      const again = await fx.engine.dispatch({ kind: 'steer', threadId: 'target', clientRequestId: 'steer-1', runId: run.runId, actor: actor(), textLength: 11, ceiling: 'full' })
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

    it('an integration run an agent stopped still leaves its thread the "interrupted" notice (the person may not know), where a user\'s Stop leaves none', async () => {
      fx = delegationFixture()
      const integration = async (threadId: string) => {
        const sent = await fx!.engine.dispatch({ kind: 'send', threadId, clientRequestId: `integrate:${threadId}`, source: 'integration' })
        if (sent.status !== 'accepted') throw new Error('send rejected')
        fx!.engine.markStarting(sent.runId)
        return fx!.engine.markRunning(sent.runId)
      }
      const inboxRows = (threadId: string) => Number(fx!.store.db.statement('SELECT COUNT(*) AS n FROM inbox WHERE thread_id = ?').get(threadId)?.n)
      const byUser = await integration('by-user')
      fx.engine.stopSubtree({ threadId: 'by-user', reason: 'user', runId: byUser.runId })
      fx.engine.markTerminal(byUser.runId, 'interrupted', { interruptedBy: 'user' })
      expect(inboxRows('by-user')).toBe(0)
      const byAgent = await integration('by-agent')
      fx.engine.stopSubtree({ threadId: 'by-agent', reason: 'agent', runId: byAgent.runId, actor: actor() })
      fx.engine.markTerminal(byAgent.runId, 'interrupted', { interruptedBy: 'user' })
      expect(fx.engine.getRun(byAgent.runId)?.outcome?.interruptedBy).toBe('agent')
      expect(inboxRows('by-agent')).toBe(1)
    })
  })

  describe('a message an agent sent', () => {
    it('is remembered on its run with the hop count, and never ends a usage-limit pause by starting, however it came to be queued', async () => {
      fx = delegationFixture()
      const running = await fx.runningRun('target')
      // Admitted while the thread was busy, so nothing paused it then.
      const queued = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'send-1', source: 'mcp', prompt: 'x', actor: actor({ hops: 2 }) })
      if (queued.status !== 'accepted') throw new Error('send rejected')
      expect(fx.engine.getRun(queued.runId)?.outcome).toMatchObject({ sentByAgent: true, agentHops: 2 })
      fx.engine.pauseRun({ runId: running.runId, pause: PAUSE })
      expect(() => fx!.engine.markStarting(queued.runId)).toThrow(/paused/)
      expect(fx.engine.getRun(running.runId)).toMatchObject({ status: 'paused' })
      expect(fx.engine.getRun(queued.runId)?.status).toBe('queued')
      // A person's message queued the same way does end it, as it always did.
      const typed = await fx.engine.dispatch({ kind: 'send', threadId: 'target', clientRequestId: 'typed', source: 'gui', prompt: 'x' })
      if (typed.status !== 'accepted') throw new Error('send rejected')
      fx.engine.markStarting(typed.runId)
      expect(fx.engine.getRun(running.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
    })
  })

  describe('the final text of a run', () => {
    const mcpRun = async (threadId: string, id: string, extra: { continuationOfRunId?: string; source?: string } = {}) => {
      const sent = await fx!.engine.dispatch({ kind: 'send', threadId, clientRequestId: id, source: extra.source ?? 'mcp', prompt: 'x', ...(extra.continuationOfRunId ? { continuationOfRunId: extra.continuationOfRunId } : {}) })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      return sent
    }

    it('is kept for a run an agent sent, bound to the run it came from', async () => {
      fx = delegationFixture()
      const first = await mcpRun('target', 'one')
      fx.finish(first.runId, 'first answer')
      const second = await mcpRun('target', 'two')
      fx.finish(second.runId, 'second answer')
      expect(readRunResultText(fx.store, 'target', first.runId)).toBe('first answer')
      expect(readRunResultText(fx.store, 'target', second.runId)).toBe('second answer')
    })

    it('is not kept for a person\'s own turns (a thread\'s answers to its user, a remote send\'s), only for what an agent can wait on', async () => {
      fx = delegationFixture()
      for (const source of ['gui', 'remote', 'cli', 'protocol', 'schedule']) {
        const run = await mcpRun(`thread-${source}`, `run-${source}`, { source })
        fx.finish(run.runId, `the answer to ${source}`)
        expect(readRunResultText(fx.store, `thread-${source}`, run.runId), source).toBeUndefined()
      }
    })

    it('is kept for a subagent\'s run, as it always was, and for the run that continues a run an agent sent', async () => {
      fx = delegationFixture()
      const parent = await fx.runningRun('parent')
      const child = await fx.delegate(parent.runId, 'call-1')
      fx.finish(child.childRunId, 'the task result')
      expect(readRunResultText(fx.store, child.childThreadId, child.childRunId)).toBe('the task result')

      const first = await mcpRun('target', 'one')
      fx.engine.markStarting(first.runId)
      fx.engine.markRunning(first.runId)
      fx.engine.pauseRun({ runId: first.runId, pause: PAUSE })
      const resumed = await mcpRun('target', 'resume', { source: 'resume_now', continuationOfRunId: first.runId })
      fx.finish(resumed.runId, 'after the pause')
      expect(readRunResultText(fx.store, 'target', resumed.runId)).toBe('after the pause')
    })

    it('is cut to the delegation result limit, and removed with the thread\'s other answers by deleteRunResults', async () => {
      fx = delegationFixture()
      const sent = await mcpRun('target', 'send-1')
      fx.finish(sent.runId, 'y'.repeat(100_000))
      const text = readRunResultText(fx.store, 'target', sent.runId)
      expect(text?.startsWith('yyyy')).toBe(true)
      expect(text!.length).toBeLessThan(100_000)
      const other = await mcpRun('target', 'send-2')
      fx.finish(other.runId, 'another')
      expect(deleteRunResults(fx.store, 'target', [sent.runId])).toBe(1)
      expect(readRunResultText(fx.store, 'target', sent.runId)).toBeUndefined()
      expect(readRunResultText(fx.store, 'target', other.runId)).toBe('another')
      expect(deleteRunResults(fx.store, 'target')).toBe(1)
      expect(readRunResultText(fx.store, 'target', other.runId)).toBeUndefined()
      // The audit trail of the runs stays.
      expect(fx.engine.listEvents('target').some((event) => event.type === 'run.status')).toBe(true)
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
