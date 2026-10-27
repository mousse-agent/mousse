/**
 * Issue #142, PR E: Stop reaches every subagent, and their questions reach the parent.
 *
 * `RunEngine.stopSubtree` (the one transaction that decides what a Stop cancels, the stop generation
 * and its admission fence) is driven on the engine over a fake clock. `OrchestratorService.stopThread`
 * (the one entry point every public Stop goes through, local aborts, queue entries, provider work, the
 * question router, steers that were never read) is driven through a real orchestrator, run engine and
 * effect worker with scripted providers. The routing of the channel and remote entries is tested where
 * those entries live (`channels.test.ts`, `net/bridge/remote/composer.test.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { childBusy } from '../../src/mms/run/delegation/hold'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { bumpStopGenerations, currentStopGeneration, isRunAdmissionStale, runStopGeneration } from '../../src/mms/run/stopGeneration'
import { isChildQuestionRow, type ChildQuestionPayload, type InboxRecord, type ProviderRef } from '../../src/mms/run/types'
import { normalizeQueuedMessages } from '../../src/mms/queue/ThreadMessageQueue'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { PI, createOrchestrator, phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

describe('RunEngine.stopSubtree (issue #142)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** parent (a running run) -> child-1 (running) -> child-2 (running); the tasks are parent->child-1 and child-1->child-2. */
  const tree = async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const c = await f.delegate(parent.runId, 'c')
    f.engine.markStarting(c.childRunId)
    f.engine.markRunning(c.childRunId)
    const g = await f.delegate(c.childRunId, 'g')
    f.engine.markStarting(g.childRunId)
    f.engine.markRunning(g.childRunId)
    return { f, parent, c, g }
  }
  const task = (id: string) => f!.engine.delegations.get(id)!
  const interrupts = (runId: string) => f!.outbox.listForRun(runId).filter((effect) => effect.kind === 'turn.interrupt')

  it('resolves the subtree, raises the generation of each thread and stops everything in it, deepest task first', async () => {
    const { parent, c, g } = await tree()
    const result = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
    expect(result).toMatchObject({ status: 'stopped', replayed: false, threads: ['parent', 'child-1', 'child-2'], generations: { parent: 1, 'child-1': 1, 'child-2': 1 } })
    expect(result.delegations).toEqual([g.delegationId, c.delegationId])
    expect(result.activeRuns.map((run) => run.runId).sort()).toEqual([parent.runId, c.childRunId, g.childRunId].sort())
    for (const id of [c.delegationId, g.delegationId]) expect(task(id).status).toBe('cancelled')
    for (const runId of [parent.runId, c.childRunId, g.childRunId]) {
      expect(f!.engine.getRun(runId)!.outcome?.stopRequested).toBe(true)
      expect(interrupts(runId)).toHaveLength(1)
    }
    expect(['parent', 'child-1', 'child-2'].map((id) => currentStopGeneration(f!.store, id))).toEqual([1, 1, 1])
    // A Stop of a subagent alone raises its subtree only.
    f!.engine.stopSubtree({ threadId: 'child-2', reason: 'user' })
    expect(['parent', 'child-1', 'child-2'].map((id) => currentStopGeneration(f!.store, id))).toEqual([1, 1, 2])
  })

  it('stops an active parent that has no delegations at all', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const result = f.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
    expect(result).toMatchObject({ status: 'stopped', threads: ['parent'], activeRuns: [{ threadId: 'parent', runId: parent.runId }], delegations: [] })
    expect(f.engine.getRun(parent.runId)!.outcome?.stopRequested).toBe(true)
    expect(interrupts(parent.runId)).toHaveLength(1)
  })

  describe('a Stop aimed at a run', () => {
    it('that is not the active run is ignored with the run\'s outcome, and does not cascade', async () => {
      const { parent, c } = await tree()
      f!.engine.markTerminal(parent.runId, 'completed')
      const result = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: parent.runId })
      expect(result).toMatchObject({ status: 'ignored', reason: 'run_not_active', runId: parent.runId, outcome: { status: 'completed' } })
      expect(task(c.delegationId).status).toBe('running')
      expect(f!.engine.getRun(c.childRunId)!.outcome?.stopRequested).toBeUndefined()
      expect(['parent', 'child-1', 'child-2'].map((id) => currentStopGeneration(f!.store, id))).toEqual([0, 0, 0])
      // Another thread's run, or none, is not found.
      expect(f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: c.childRunId })).toMatchObject({ status: 'ignored', reason: 'run_not_found' })
      expect(f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: 'run:none' })).toMatchObject({ status: 'ignored', reason: 'run_not_found' })
    })

    it('that is the active run stops the whole subtree', async () => {
      const { parent, c } = await tree()
      const result = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: parent.runId })
      expect(result.status).toBe('stopped')
      expect(task(c.delegationId).status).toBe('cancelled')
    })
  })

  describe('a repeated clientRequestId', () => {
    it('returns the first result and raises no generation (a Stop of a thread)', async () => {
      const { c } = await tree()
      const first = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', clientRequestId: 'stop-1' })
      expect(f!.store.getReceipt('stop-thread:parent:stop-1')).toMatchObject({ commandKind: 'stop.thread', status: 'accepted' })
      const again = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', clientRequestId: 'stop-1' })
      expect(again).toEqual({ ...first, replayed: true })
      expect(currentStopGeneration(f!.store, 'parent')).toBe(1)
      expect(task(c.delegationId).status).toBe('cancelled')
      // The same id aimed at another thread is another Stop.
      expect(f!.engine.stopSubtree({ threadId: 'child-1', reason: 'user', clientRequestId: 'stop-1' }).replayed).toBe(false)
      expect(currentStopGeneration(f!.store, 'child-1')).toBe(2)
    })

    it('keeps its id as the receipt of a Stop aimed at a run, so another command cannot reuse it', async () => {
      const { parent } = await tree()
      const first = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: parent.runId, clientRequestId: 'shared-id' })
      expect(f!.store.getReceipt('shared-id')).toMatchObject({ commandKind: 'stop', threadId: 'parent' })
      expect(f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', runId: parent.runId, clientRequestId: 'shared-id' })).toEqual({ ...first, replayed: true })
      expect(f!.engine.stopSubtree({ threadId: 'child-1', reason: 'user', runId: 'run:x', clientRequestId: 'shared-id' })).toMatchObject({ status: 'rejected', reason: 'client_request_id_conflict' })
      const sent = await f!.engine.dispatch({ kind: 'send', threadId: 'parent', clientRequestId: 'shared-id', source: 'gui' })
      expect(sent).toMatchObject({ status: 'rejected', reason: 'client_request_id_conflict' })
    })

    it('enqueues the interrupt again when the first one ended without stopping the run (M4)', async () => {
      const { parent } = await tree()
      const first = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', clientRequestId: 'stop-1' })
      f!.outbox.cancel(interrupts(parent.runId)[0].effectId, f!.now(), 'test')
      const again = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', clientRequestId: 'stop-1' })
      expect(f!.engine.reinterruptStopped(again).map((run) => run.runId)).toContain(parent.runId)
      expect(interrupts(parent.runId).map((effect) => effect.status)).toEqual(['cancelled', 'pending'])
      expect(first.activeRuns.length).toBe(3)
    })
  })

  describe('results and notices', () => {
    it('a result a subagent finished and the parent has not read survives the Stop; its row is acknowledged so nothing wakes the parent', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const c = await f.delegate(parent.runId, 'c')
      f.finish(c.childRunId, 'The unread result')
      expect(task(c.delegationId).status).toBe('result_available')
      expect(f.engine.inbox.listPending('parent')).toHaveLength(1)

      f.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      expect(task(c.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'The unread result' } })
      expect(f.engine.inbox.listForDelegation(c.delegationId).map((row) => row.status)).toEqual(['acknowledged'])
      // Even once the stopped run is over, nothing wakes the parent for it.
      f.engine.markTerminal(parent.runId, 'interrupted', { interruptedBy: 'user' })
      expect(f.reconciler.runOnce().wakes.wakes).toEqual([])
    })

    it('acknowledges every inbox row of the subtree, so no thread is woken after the Stop', async () => {
      const { parent, c } = await tree()
      f!.engine.inbox.append({ threadId: 'child-1', kind: 'reconcile_notice', payload: { text: 'a note for the subagent' } })
      f!.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'a note for the parent' } })
      f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      for (const id of ['parent', 'child-1']) expect(f!.engine.inbox.listForThread(id).every((row) => row.status === 'acknowledged')).toBe(true)
      f!.engine.markTerminal(c.childRunId, 'interrupted', { interruptedBy: 'user' })
      f!.engine.markTerminal(parent.runId, 'interrupted', { interruptedBy: 'user' })
      expect(f!.reconciler.runOnce().wakes.wakes).toEqual([])
    })

    it('a cancelled task of an owner outside the subtree leaves the owner a notice row, except for the owner who asked', async () => {
      const { c } = await tree()
      f!.engine.stopSubtree({ threadId: 'child-1', reason: 'user' })
      const [notice] = f!.engine.inbox.listPending('parent')
      expect(notice).toMatchObject({ kind: 'reconcile_notice', payload: { kind: 'delegation_stopped', delegationId: c.delegationId, childThreadId: 'child-1' } })
      expect(planWakeNotice([notice], { titleOf: () => 'Reviewer' }).text).toBe(`Subagent "Reviewer" (thread child-1) was stopped before it finished task ${c.delegationId}.`)
      // The subagent's own task into child-2 is inside the subtree: no notice for it.
      expect(f!.engine.inbox.listForThread('child-1')).toEqual([])

      const again = await tree()
      f!.engine.stopSubtree({ threadId: 'child-1', reason: 'task_cancel', requesterThreadId: 'parent' })
      expect(again.f.engine.inbox.listPending('parent')).toEqual([])
    })
  })

  it('a user-stopped integration run, active or queued, owes no outcome row: a user\'s Stop publishes at once (D2)', async () => {
    f = delegationFixture()
    const integration = async (clientRequestId: string) => {
      const sent = await f!.engine.dispatch({ kind: 'send', threadId: 'int', clientRequestId, source: 'integration' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      f!.outbox.enqueue({ threadId: 'int', runId: sent.runId, kind: 'turn.start', payload: { kind: 'integration', delegationId: 'delegation:x' } })
      return sent.runId
    }
    const active = await integration('int-1')
    f.engine.markStarting(active)
    f.engine.markRunning(active)
    const queued = await integration('int-2')
    const result = f.engine.stopSubtree({ threadId: 'int', reason: 'user' })
    expect(result.cancelledRuns.map((run) => run.runId)).toEqual([queued])
    f.engine.markTerminal(active, 'interrupted', { interruptedBy: 'user' })
    expect(f.engine.getRun(queued)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
    expect(f.engine.inbox.listForThread('int')).toEqual([])
  })

  it('the owner\'s notice is written before its task leaves running, so a held task cannot publish an answer that predates the Stop', async () => {
    // P -> C -> G. C's turn ended while G still works: P's task is held on C's own task.
    const { c, g } = await tree()
    f!.finish(c.childRunId, 'C: waiting for G')
    expect(task(c.delegationId).status).toBe('running')
    f!.engine.stopSubtree({ threadId: 'child-2', reason: 'user' })
    expect(task(g.delegationId).status).toBe('cancelled')
    // C is woken for the notice; until it has read it, P's task is still held and nothing was published.
    expect(f!.engine.inbox.listPending('child-1').map((row) => (row.payload as { kind?: string }).kind)).toEqual(['delegation_stopped'])
    expect(task(c.delegationId).status).toBe('running')
    expect(f!.engine.inbox.listForThread('parent').filter((row) => row.kind === 'child_result')).toEqual([])
  })

  it('rule 4 does not steer a run that is being stopped: the rows wait for the wake after it ends', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    await f.engine.dispatch({ kind: 'stop', threadId: 'parent', clientRequestId: 'stop-1', runId: parent.runId })
    f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'news' } })
    expect(f.reconciler.runOnce().wakes.steers).toEqual([])
    expect(f.outbox.listForRun(parent.runId).filter((effect) => effect.kind === 'turn.steer')).toEqual([])
    f.engine.markTerminal(parent.runId, 'interrupted', { interruptedBy: 'user' })
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
  })

  describe('queued work', () => {
    const send = (threadId: string, source: string, clientRequestId: string, delegation?: { parentRunId: string }) =>
      f!.engine.dispatch({
        kind: 'send',
        threadId,
        clientRequestId,
        source,
        ...(delegation ? { delegation: { parentThreadId: 'parent', parentRunId: delegation.parentRunId, prompt: 'more', wake: 'always' as const } } : {})
      }).then((result) => {
        if (result.status !== 'accepted') throw new Error(`send ${result.status}`)
        return result.runId
      })

    it('ends the queued tasks of a subagent; what a person queued stays at every level, unless asked', async () => {
      const { parent } = await tree()
      const followUp = await send('child-1', 'delegation', 'follow-up', { parentRunId: parent.runId })
      const mine = await send('parent', 'gui', 'mine')
      // A message a person typed to a subagent: it is tracked as a follow-up, and a Stop must not lose it.
      const typed = await send('child-2', 'gui', 'typed')
      f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      expect(f!.engine.getRun(followUp)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
      expect(f!.engine.getRun(mine)!.status).toBe('queued')
      expect(f!.engine.getRun(typed)!.status).toBe('queued')
      const cleared = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user', clearQueue: true })
      expect(cleared.cancelledRuns.map((run) => run.runId).sort()).toEqual([mine, typed].sort())
      expect(f!.engine.getRun(mine)!.status).toBe('cancelled')
    })

    it('a steer still waiting for a run of the stop set is cancelled with it', async () => {
      const { parent } = await tree()
      const steer = f!.outbox.enqueue({ threadId: 'parent', runId: parent.runId, kind: 'turn.steer', availableAt: new Date(Date.parse(f!.now()) + 3_600_000).toISOString(), payload: { runId: parent.runId, threadId: 'parent', text: 'late' } })
      f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      expect(f!.outbox.get(steer.effectId)!.status).toBe('cancelled')
      expect(f!.engine.isStale(parent.runId)).toBe(true)
    })

    it('a person\'s message to a subagent after the Stop is not in the set: it survives and starts at the new generation', async () => {
      await tree()
      const stopped = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      const fresh = await send('child-2', 'gui', 'fresh')
      expect(f!.engine.getRun(fresh)!.status).toBe('queued')
      expect(stopped.cancelledRuns.map((run) => run.runId)).not.toContain(fresh)
      expect(runStopGeneration(f!.store, fresh)).toBe(1)
      expect(f!.engine.isFenced(fresh)).toBe(false)
    })

    it('a person\'s message that waits out a Stop starts at the generation it starts in, so it can start subagents', async () => {
      f = delegationFixture()
      const first = await f.runningRun('parent')
      const waiting = await send('parent', 'gui', 'waiting')
      f.engine.stopSubtree({ threadId: 'parent', reason: 'user' })
      f.engine.markTerminal(first.runId, 'interrupted', { interruptedBy: 'user' })
      // It was admitted before the Stop...
      expect(isRunAdmissionStale(f.store, waiting)).toBe(true)
      f.engine.markStarting(waiting)
      f.engine.markRunning(waiting)
      // ...and starts now, as new intent.
      expect(isRunAdmissionStale(f.store, waiting)).toBe(false)
      await expect(f.delegate(waiting, 'after')).resolves.toMatchObject({ replayed: false })
    })
  })

  describe('the admission fence', () => {
    it('refuses work that starts on behalf of a parent once a Stop came after it was admitted, and never a person\'s send', async () => {
      f = delegationFixture()
      const mkRun = async (threadId: string, source: string) => {
        const sent = await f!.engine.dispatch({ kind: 'send', threadId, clientRequestId: `${source}:${threadId}`, source })
        if (sent.status !== 'accepted') throw new Error('send rejected')
        return sent.runId
      }
      const runs = {
        delegation: await mkRun('thread', 'delegation'),
        wake: await mkRun('thread', 'wake'),
        steerLate: await mkRun('thread', 'steer-late'),
        continuation: await mkRun('thread', 'provider-continuation'),
        integration: await mkRun('thread', 'integration'),
        gui: await mkRun('thread', 'gui'),
        cli: await mkRun('thread', 'cli'),
        channel: await mkRun('thread', 'channel'),
        internal: await mkRun('thread', 'internal'),
        steerFollowup: await mkRun('thread', 'steer-followup')
      }
      for (const runId of Object.values(runs)) expect(f.engine.isFenced(runId)).toBe(false)
      bumpStopGenerations(f.store, ['thread'], f.now())
      const fenced = Object.fromEntries(Object.entries(runs).map(([name, runId]) => [name, f!.engine.isFenced(runId)]))
      expect(fenced).toEqual({ delegation: true, wake: true, steerLate: true, continuation: true, integration: true, gui: false, cli: false, channel: false, internal: false, steerFollowup: false })
    })

    it('refuses delegate_task and continue_subagent from a run that started before the Stop; a run that starts after may', async () => {
      f = delegationFixture()
      const before = await f.runningRun('parent')
      const child = await f.delegate(before.runId, 'c')
      f.finish(child.childRunId)
      // The raise alone, with no `stopRequested` on the run: the fence is what refuses.
      bumpStopGenerations(f.store, ['parent'], f.now())
      expect(f.engine.getRun(before.runId)!.outcome?.stopRequested).toBeUndefined()
      await expect(f.delegate(before.runId, 'spawn')).rejects.toMatchObject({ reason: 'parent_stopping' })
      await expect(f.delegate(before.runId, 'spawn')).rejects.toBeInstanceOf(CommandRejection)
      await expect(
        f.engine.dispatch({
          kind: 'send',
          threadId: child.childThreadId,
          clientRequestId: 'continue-1',
          source: 'delegation',
          delegation: { parentThreadId: 'parent', parentRunId: before.runId, prompt: 'more', wake: 'always' }
        })
      ).rejects.toMatchObject({ reason: 'parent_stopping' })
      expect(f.engine.listRuns(child.childThreadId)).toHaveLength(1)
      expect(f.threads.size).toBe(1)

      f.engine.markTerminal(before.runId, 'interrupted', { interruptedBy: 'user' })
      const after = await f.runningRun('parent')
      await expect(f.delegate(after.runId, 'spawn')).resolves.toMatchObject({ replayed: false })
      const continued = await f.engine.dispatch({
        kind: 'send',
        threadId: child.childThreadId,
        clientRequestId: 'continue-2',
        source: 'delegation',
        delegation: { parentThreadId: 'parent', parentRunId: after.runId, prompt: 'more', wake: 'always' }
      })
      expect(continued.status).toBe('accepted')
    })
  })

  describe('questions', () => {
    const question = (threadId: string, childThreadId: string, requestId: string) =>
      f!.engine.inbox.append({
        threadId,
        kind: 'reconcile_notice',
        payload: { kind: 'child_question', childThreadId, childRunId: null, requestId } satisfies ChildQuestionPayload
      })

    it('Inbox.listForChildThread lists the results and the questions of one subagent, narrowed by kind', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const c = await f.delegate(parent.runId, 'c')
      const other = await f.delegate(parent.runId, 'other')
      f.finish(c.childRunId, 'result')
      const asked = question('parent', c.childThreadId, 'req-1')
      question('parent', other.childThreadId, 'req-2')
      const ids = (rows: InboxRecord[]) => rows.map((row) => row.inboxId)
      expect(f.engine.inbox.listForChildThread(c.childThreadId).map((row) => row.kind)).toEqual(['child_result', 'reconcile_notice'])
      expect(ids(f.engine.inbox.listForChildThread(c.childThreadId, 'child_question'))).toEqual([asked.inboxId])
      expect(f.engine.inbox.listForChildThread(c.childThreadId, 'child_result').map((row) => row.kind)).toEqual(['child_result'])
      expect(isChildQuestionRow(asked)).toBe(true)
      expect(f.engine.inbox.listForChildThread('nobody')).toEqual([])
    })

    it('boot acknowledges every question row left from a previous process, and nothing else', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const c = await f.delegate(parent.runId, 'c')
      const pending = question('parent', c.childThreadId, 'req-pending')
      const delivered = question('parent', c.childThreadId, 'req-delivered')
      f.engine.inbox.markDelivered([delivered.inboxId], 'effect:gone')
      const note = f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'an ordinary notice' } })
      const home = f.profileHome
      f.dispose(true)
      f = delegationFixture({ profileHome: home, pid: 2 })
      f.engine.reconcileOnBoot()
      expect(f.engine.inbox.get(pending.inboxId)!.status).toBe('acknowledged')
      expect(f.engine.inbox.get(delivered.inboxId)!.status).toBe('acknowledged')
      expect(f.engine.inbox.get(note.inboxId)!.status).toBe('pending')
    })
  })

  it('stopGeneration of a queue entry survives normalization, and only a number is kept', () => {
    const entry = { id: 'a', threadId: 't', content: 'x', enqueuedAt: '2026-10-25T00:00:00.000Z', order: 0, intent: 'normal', state: 'pending' }
    expect(normalizeQueuedMessages([{ ...entry, stopGeneration: 3 }])[0].stopGeneration).toBe(3)
    expect(normalizeQueuedMessages([{ ...entry, stopGeneration: '3' }])[0].stopGeneration).toBeUndefined()
    expect(normalizeQueuedMessages([{ ...entry, id: 'b', stopGeneration: -1 }])[0].stopGeneration).toBeUndefined()
  })
})

type HostScript = (input: TurnInput, delegation: DelegationToolHost | undefined) => Promise<string> | string

/** A pi-shaped adapter whose script sees the turn's delegation tools; it records what Stop asked of it. */
class HostAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_LOOP_CAPABILITIES
  readonly turns: TurnInput[] = []
  /** Threads `stopThread` was asked to end the provider process of (the hook PR H fills for Claude). */
  readonly providerStops: string[] = []
  constructor(
    private readonly script: HostScript,
    options: { providerStop?: boolean } = {}
  ) {
    if (options.providerStop === false) (this as { stopThread?: unknown }).stopThread = undefined
  }

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host.tools.delegation)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const reply = {
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: input.llmProvider,
      model: input.model, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } as Message
    return {
      text, aborted: input.signal.aborted, modelName: 'Scripted', totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted',
      nativeMessages: [...input.messages, reply], providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  async stopThread(threadId: string): Promise<'stopped' | 'not_active'> {
    this.providerStops.push(threadId)
    return 'stopped'
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Resolves when `gate` opens or `signal` aborts (a turn that honours Stop). */
const until = (gate: Promise<void>, signal: AbortSignal): Promise<void> =>
  Promise.race([gate, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))])

describe('OrchestratorService.stopThread through a real orchestrator (issue #142)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  const releases: Array<() => void> = []

  afterEach(async () => {
    for (const release of releases.splice(0)) release()
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  type Out = Record<string, any>

  /**
   * A parent that starts the subagent "Worker" on its first turn and, when `queueFollowUp`, continues it
   * behind its task; then it keeps its turn open until it is stopped (`parentBlocks`), and tries to start
   * more work as soon as it is. The Worker answers its task when released (`childFinishes`: at once), and
   * any other prompt with `child said: <prompt>`. Every other parent turn (a wake) answers `parent reply`.
   */
  const scene = async (options: { parentBlocks?: boolean; childFinishes?: boolean; queueFollowUp?: boolean; providerStop?: boolean; secondChild?: boolean; grandchild?: boolean; childScript?: HostScript } = {}) => {
    const gate = { parent: deferred(), child: deferred() }
    releases.push(gate.parent.resolve, gate.child.resolve)
    const out: Out = {}
    let parentId = ''
    const adapter = new HostAdapter(async (input, delegation) => {
      if (input.threadId === parentId) {
        if (input.prompt !== 'Delegate it') return 'parent reply'
        out.delegation = await delegation!.delegateTask({ prompt: 'Long child work', title: 'Worker', workspace: 'isolated' }, { toolCallId: 'call-1' })
        if (options.queueFollowUp) out.queued = await delegation!.continueSubagent({ subagent: 'Worker', prompt: 'Queued work' }, { toolCallId: 'call-q' })
        if (options.secondChild) out.second = await delegation!.delegateTask({ prompt: 'Second long work', title: 'Second', workspace: 'isolated' }, { toolCallId: 'call-2nd' })
        if (options.parentBlocks === false) return 'parent delegated'
        await until(gate.parent.promise, input.signal)
        if (input.signal.aborted) {
          // The run is being stopped: it can no longer start work for its thread.
          out.spawn = await delegation!.delegateTask({ prompt: 'Late work', title: 'Late', workspace: 'isolated' }, { toolCallId: 'call-late' })
          out.continued = await delegation!.continueSubagent({ subagent: 'Worker', prompt: 'Late follow-up' }, { toolCallId: 'call-late-continue' })
        }
        return 'parent done'
      }
      if (input.prompt.includes('Second long work') || input.prompt.includes('Grand work')) {
        await until(gate.child.promise, input.signal)
        return input.signal.aborted ? '' : 'child done'
      }
      if (options.childScript && !input.prompt.includes('Long child work')) return options.childScript(input, delegation)
      if (input.prompt.includes('Long child work')) {
        if (options.grandchild) out.grand = await delegation!.delegateTask({ prompt: 'Grand work', title: 'Grand', workspace: 'isolated' }, { toolCallId: 'call-grand' })
        if (!options.childFinishes) await until(gate.child.promise, input.signal)
        return input.signal.aborted ? '' : 'child done'
      }
      return `child said: ${input.prompt.split('\n').at(-1)}`
    }, { providerStop: options.providerStop })
    home = mkdtempSync(join(tmpdir(), 'mousse-stop-thread-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const created = d.store.createThread('Parent')
    d.orch.setThreadModelOverride(created.id, PI)
    // Choosing the model is not a Stop: the provider stop it makes (the old provider's process ends) is setup.
    adapter.providerStops.length = 0
    parentId = created.id
    const sent = await d.orch.send('Delegate it', false, { threadId: parentId, clientRequestId: 'go', awaitMode: 'ack' })
    await waitFor(() => Boolean(out.delegation?.delegationId) && (!options.queueFollowUp || Boolean(out.queued)) && (!options.secondChild || Boolean(out.second?.delegationId)), 'the parent to start its subagent')
    const delegation = d.engine.delegations.get(out.delegation.delegationId)!
    const childThreadId = delegation.childThreadId
    if (!options.childFinishes) await waitFor(() => d.engine.getRun(delegation.childRunId)?.status === 'running', 'the subagent\'s turn')
    else await waitFor(() => d.engine.getRun(delegation.childRunId)?.status === 'completed', 'the subagent to finish')
    const running = (id: string): boolean => d.engine.getRun(id)?.status === 'running'
    if (options.secondChild) await waitFor(() => running(d.engine.delegations.get(out.second.delegationId)!.childRunId), 'the second subagent\'s turn')
    if (options.grandchild) await waitFor(() => Boolean(out.grand?.delegationId) && running(d.engine.delegations.get(out.grand.delegationId)!.childRunId), 'the grandchild\'s turn')
    const run = (id: string) => d.engine.getRun(id)!
    const terminal = (id: string) => ['completed', 'interrupted', 'failed', 'cancelled'].includes(run(id).status)
    const protocol = (method: string, params: Record<string, unknown>) =>
      dispatchMethod({ mms: { orchestrator: d.orch, threads: d.store, pullRequestWatch: { onEnded: () => undefined } } as never, globalSequence: () => 0 }, method, params)
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })
    return {
      d, adapter, out, gate, parentId, childThreadId, delegation, parentRunId: sent.runId!, run, terminal, protocol, reconciler,
      task: (id: string) => d.engine.delegations.get(id)!,
      generation: (threadId: string) => currentStopGeneration(d.engine.store, threadId),
      childTurns: () => adapter.turns.filter((turn) => turn.threadId === childThreadId).map((turn) => turn.prompt)
    }
  }
  type Scene = Awaited<ReturnType<typeof scene>>

  describe('every public Stop of a thread is the same Stop', () => {
    const entries: Array<[string, (s: Scene) => Promise<unknown>]> = [
      ['stopThread', (s) => s.d.orch.stopThread(s.parentId, 'user')],
      ['orchestrator.abort without a runId (the app, the CLI, Lineage\'s Stop all)', (s) => s.protocol('orchestrator.abort', { threadId: s.parentId })],
      ['orchestrator.abort without a runId, with a clientRequestId', (s) => s.protocol('orchestrator.abort', { threadId: s.parentId, clientRequestId: 'stop-1' })],
      ['orchestrator.abort with the active runId', (s) => s.protocol('orchestrator.abort', { threadId: s.parentId, runId: s.parentRunId })],
      ['abortRun', (s) => s.d.orch.abortRun(s.parentRunId, 'stop-1', s.parentId)],
      ['deleting the thread (markThreadDeleted)', async (s) => s.d.orch.markThreadDeleted(s.parentId)],
      ['settling the thread (threads.settle)', (s) => s.protocol('threads.settle', { threadId: s.parentId, settled: true })]
    ]

    it.each(entries)('%s stops the parent and its running subagent, cancels the task, and raises both generations', async (_name, stop) => {
      const s = await scene({ queueFollowUp: true })
      expect(s.out.queued).toMatchObject({ status: 'queued' })
      await stop(s)
      await waitFor(() => s.terminal(s.parentRunId) && s.terminal(s.delegation.childRunId), 'both runs to end')
      expect(s.run(s.parentRunId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user', stopRequested: true } })
      expect(s.run(s.delegation.childRunId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user', stopRequested: true } })
      expect(s.task(s.delegation.delegationId).status).toBe('cancelled')
      expect(s.task(s.out.queued.delegationId).status).toBe('cancelled')
      expect(s.generation(s.parentId)).toBeGreaterThanOrEqual(1)
      expect(s.generation(s.childThreadId)).toBeGreaterThanOrEqual(1)
      // Stop reaches the provider for every thread of the subtree, and nothing wakes anyone afterwards.
      expect(s.adapter.providerStops.sort()).toEqual([s.parentId, s.childThreadId].sort())
      await s.d.engine.outbox.listForThread(s.parentId)
      expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    })

    it('a subagent\'s own Stop (the row\'s Stop) stops it alone and tells the parent', async () => {
      const s = await scene()
      await s.protocol('orchestrator.abort', { threadId: s.childThreadId })
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
      expect(s.run(s.delegation.childRunId).status).toBe('interrupted')
      expect(s.task(s.delegation.delegationId).status).toBe('cancelled')
      // The parent keeps running and hears of it once.
      expect(s.run(s.parentRunId).status).toBe('running')
      expect(s.run(s.parentRunId).outcome?.stopRequested).toBeUndefined()
      expect(s.generation(s.parentId)).toBe(0)
      expect(s.generation(s.childThreadId)).toBe(1)
      const [notice] = s.d.engine.inbox.listPending(s.parentId)
      expect(notice).toMatchObject({ kind: 'reconcile_notice', payload: { kind: 'delegation_stopped', delegationId: s.delegation.delegationId } })
    })

    it('task_cancel stops the subagent the caller names, without a notice row for the caller, and leaves the caller running', async () => {
      const s = await scene()
      const cancelled = await (s.d.orch as any).taskCancel(s.parentId, { subagent: 'Worker' })
      expect(cancelled).toMatchObject({ subagent: 'Worker', cancelled: [s.delegation.delegationId] })
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
      expect(s.run(s.delegation.childRunId).status).toBe('interrupted')
      expect(s.task(s.delegation.delegationId).status).toBe('cancelled')
      expect(s.run(s.parentRunId).status).toBe('running')
      expect(s.d.engine.inbox.listForThread(s.parentId)).toEqual([])
      // By delegationId it is the same Stop, and a repeat of it is harmless.
      expect(await (s.d.orch as any).taskCancel(s.parentId, { delegationId: s.delegation.delegationId })).toMatchObject({ delegationId: s.delegation.delegationId, status: 'cancelled' })
    })
  })

  it('the Stop fence: a run that is being stopped can start no subagent and continue none', async () => {
    const s = await scene()
    const threadsBefore = s.d.store.listAllThreads().length
    await s.d.orch.stopThread(s.parentId, 'user')
    await waitFor(() => s.terminal(s.parentRunId) && s.terminal(s.delegation.childRunId), 'both runs to end')
    expect(s.out.spawn).toMatchObject({ started: false, code: 'parent_stopping' })
    expect(s.out.continued).toMatchObject({ started: false, code: 'parent_stopping' })
    expect(s.d.store.listAllThreads()).toHaveLength(threadsBefore)
    expect(s.d.engine.delegations.listForParentThread(s.parentId)).toHaveLength(1)
    expect(s.childTurns().filter((prompt) => prompt.includes('Late follow-up'))).toEqual([])
  })

  it('Stop and queued admission: a follow-up queued behind a running subagent never runs, and its queue entry is gone', async () => {
    const s = await scene({ queueFollowUp: true })
    expect(s.d.orch.listQueue(s.childThreadId)).toHaveLength(1)
    const followUpRun = s.d.engine.delegations.get(s.out.queued.delegationId)!.childRunId
    expect(s.run(followUpRun).status).toBe('queued')
    await s.d.orch.stopThread(s.parentId, 'user')
    await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
    expect(s.run(followUpRun)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
    expect(s.d.orch.listQueue(s.childThreadId)).toEqual([])
    s.d.orch.recoverAndDrainPendingQueues()
    expect(s.childTurns().filter((prompt) => prompt.includes('Queued work'))).toEqual([])
  })

  it('a queue entry that starts work on behalf of a parent is refused once a Stop raised its thread\'s generation, even one a crash left behind', async () => {
    const s = await scene({ parentBlocks: false, childFinishes: true })
    const orch = s.d.orch as any
    const item = orch.enqueueForThread(s.childThreadId, { content: 'late notice' }, { source: 'steer-late' })
    const human = orch.enqueueForThread(s.childThreadId, { content: 'a person wrote this' }, { source: 'gui' })
    expect(item.stopGeneration).toBe(0)
    expect(human.stopGeneration).toBeUndefined()
    // A Stop whose queue clean-up never ran: the generation is raised, the entries are still there.
    bumpStopGenerations(s.d.engine.store, [s.childThreadId], new Date().toISOString())
    s.d.orch.recoverAndDrainPendingQueues()
    await waitFor(() => s.childTurns().some((prompt) => prompt.includes('a person wrote this')), 'the person\'s message to run')
    expect(s.childTurns().some((prompt) => prompt.includes('late notice'))).toBe(false)
    await waitFor(() => s.d.orch.listQueue(s.childThreadId).length === 0, 'the queue to empty')
  })

  it('an unread result survives a Stop of its parent, stays readable with task_status and wakes nobody', async () => {
    const s = await scene({ childFinishes: true })
    expect(s.task(s.delegation.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'child done' } })
    await s.d.orch.stopThread(s.parentId, 'user')
    await waitFor(() => s.terminal(s.parentRunId), 'the parent to stop')
    expect(s.task(s.delegation.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'child done' } })
    expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    // Reading it is what acknowledges it, and the Stop did not take it away.
    expect(await (s.d.orch as any).taskStatus(s.parentId, { delegationId: s.delegation.delegationId })).toMatchObject({ status: 'acknowledged', result: { runStatus: 'completed', text: 'child done' } })
  })

  it('Stop reaches the provider of a thread whose turn already ended, and works with an adapter that has no hook', async () => {
    const s = await scene({ childFinishes: true })
    await s.d.orch.stopThread(s.parentId, 'user')
    // The subagent settled long ago; its provider is still asked to end whatever it runs in the background.
    expect(s.adapter.providerStops).toContain(s.childThreadId)

    const bare = await scene({ providerStop: false })
    await expect(bare.d.orch.stopThread(bare.parentId, 'user')).resolves.toMatchObject({ ok: true, status: 'stopped' })
    await waitFor(() => bare.terminal(bare.delegation.childRunId), 'the subagent to stop')
    expect(bare.adapter.providerStops).toEqual([])
  })

  it('a stale runId returns its outcome and does not cascade; a repeated clientRequestId returns the first result', async () => {
    const s = await scene()
    s.gate.parent.resolve()
    await waitFor(() => s.terminal(s.parentRunId), 'the parent run to end')
    const stale = await s.d.orch.stopThread(s.parentId, 'user', { runId: s.parentRunId })
    expect(stale).toMatchObject({ ok: false, status: 'ignored', reason: 'run_not_active', outcome: { status: 'completed' } })
    expect(s.run(s.delegation.childRunId).status).toBe('running')
    expect(s.generation(s.childThreadId)).toBe(0)
    expect(await s.d.orch.abortRun(s.parentRunId, 'late', s.parentId)).toMatchObject({ status: 'ignored', reason: 'run_not_active' })

    const first = await s.d.orch.stopThread(s.parentId, 'user', { clientRequestId: 'once' })
    await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
    const replay = await s.d.orch.stopThread(s.parentId, 'user', { clientRequestId: 'once' })
    expect(first).toMatchObject({ ok: true, status: 'stopped', replayed: false })
    expect(replay).toMatchObject({ status: 'stopped', replayed: true, generations: first.generations, delegations: first.delegations })
    expect(s.generation(s.childThreadId)).toBe(1)
  })

  it('a replayed Stop does not close the provider process under a channel turn that has no run of its own', async () => {
    const s = await scene()
    await s.d.orch.stopThread(s.parentId, 'user', { clientRequestId: 'once' })
    await waitFor(() => s.terminal(s.parentRunId) && s.terminal(s.delegation.childRunId), 'both runs to end')
    // A channel turn starts on the parent after the Stop; it is not an engine run. It is registered directly
    // on purpose: starting a real channel turn here is heavy and the test only needs Stop to see one.
    const channelTurns = (s.d.orch as unknown as { channelTurns: Map<string, unknown> }).channelTurns
    channelTurns.set(s.parentId, { abort: new AbortController(), pendingSteer: [] })
    try {
      s.adapter.providerStops.length = 0
      await s.d.orch.stopThread(s.parentId, 'user', { clientRequestId: 'once' })
      // The subagent has nothing newer, so its process is still ended; the parent's channel turn is newer work.
      expect(s.adapter.providerStops).toEqual([s.childThreadId])
    } finally {
      channelTurns.delete(s.parentId)
    }
  })

  describe('what a Stop aims at, and what it leaves', () => {
    it('aborts only the turn of the run it names: a turn of a later run is not its to abort', async () => {
      const s = await scene()
      const orch = s.d.orch
      expect(orch.abortActiveTurn(s.childThreadId, { runId: 'run:some-other-run' })).toBe(false)
      expect(s.run(s.delegation.childRunId).status).toBe('running')
      expect(orch.abortActiveTurn(s.childThreadId, { runId: s.delegation.childRunId })).toBe(true)
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
    })

    it('a person\'s message to a subagent sent right after the Stop is not cancelled and not aborted: it runs', async () => {
      const s = await scene()
      const stopping = s.d.orch.stopThread(s.parentId, 'user')
      // The Stop's transaction has committed; the subagent's old turn is still ending when the message arrives.
      const sent = await s.d.orch.send('Hello Worker', false, { threadId: s.childThreadId, source: 'gui', clientRequestId: 'human-1', awaitMode: 'ack' })
      await stopping
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent\'s old turn to end')
      // Stop keeps what a person queued; the queue drains once the old turn is over.
      await waitFor(() => {
        s.d.orch.recoverAndDrainPendingQueues()
        return s.run(sent.runId!).status === 'completed'
      }, 'the person\'s message to run', 15_000)
      expect(s.childTurns().at(-1)).toContain('Hello Worker')
      expect(s.run(s.delegation.childRunId).status).toBe('interrupted')
      expect(s.run(sent.runId!).outcome?.stopRequested).toBeUndefined()
    })
  })

  describe('questions of a subagent reach its parent', () => {
    const asking = (s: Scene, prompt = 'Which database should I use?') =>
      (s.d.orch as any).questions.requestAnswers([{ id: 'db', prompt, options: [{ id: 'sqlite', label: 'SQLite' }, { id: 'postgres', label: 'Postgres' }] }], s.childThreadId) as Promise<Record<string, string | string[]>>

    it('writes a child_question row into the parent\'s inbox, wakes the parent with the question, and is acknowledged when it is answered', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      const answer = asking(s)
      const [row] = s.d.engine.inbox.listForChildThread(s.childThreadId, 'child_question')
      expect(row).toMatchObject({
        threadId: s.parentId,
        kind: 'reconcile_notice',
        status: 'pending',
        payload: { kind: 'child_question', childThreadId: s.childThreadId, childRunId: s.delegation.childRunId, delegationId: s.delegation.delegationId }
      })
      const requestId = (row.payload as ChildQuestionPayload).requestId
      const wake = s.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => s.run(wake).status === 'completed', 'the parent\'s wake')
      const prompt = s.adapter.turns.filter((turn) => turn.threadId === s.parentId).at(-1)!.prompt
      expect(prompt).toContain('Subagent "Worker"')
      expect(prompt).toContain('Which database should I use?')
      expect(prompt).toContain(`answer_subagent`)
      expect(prompt).toContain(requestId)
      // The wake read it; the parent answers with answer_subagent.
      expect(s.d.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
      expect(await (s.d.orch as any).answerSubagent(s.parentId, wake, { subagent: 'Worker', requestId, answers: { db: 'sqlite' } })).toMatchObject({ answered: true })
      await expect(answer).resolves.toEqual({ db: 'sqlite' })
    })

    it('acknowledges its row as soon as the question is answered, dismissed or lost, so nothing wakes the parent for it', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      const dismissed = asking(s, 'First?')
      dismissed.catch(() => undefined)
      const [first] = s.d.engine.inbox.listForChildThread(s.childThreadId, 'child_question')
      const answered = asking(s, 'Second?')
      const [, second] = s.d.engine.inbox.listForChildThread(s.childThreadId, 'child_question')
      expect(second.status).toBe('pending')
      ;(s.d.orch as any).questions.dismiss((first.payload as ChildQuestionPayload).requestId)
      ;(s.d.orch as any).questions.submitAnswers((second.payload as ChildQuestionPayload).requestId, { db: 'postgres' })
      await expect(answered).resolves.toEqual({ db: 'postgres' })
      expect(s.d.engine.inbox.listForChildThread(s.childThreadId, 'child_question').map((row) => row.status)).toEqual(['acknowledged', 'acknowledged'])
      expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    })

    it('does not deliver a question that is not pending any more: the row is acknowledged and the parent is not woken', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      const parentTurns = () => s.adapter.turns.filter((turn) => turn.threadId === s.parentId).length
      const turnsBefore = parentTurns()
      // A row whose request is gone: its question was lost without the router seeing it clear.
      const stale = s.d.engine.inbox.append({
        threadId: s.parentId,
        kind: 'reconcile_notice',
        payload: { kind: 'child_question', childThreadId: s.childThreadId, childRunId: s.delegation.childRunId, requestId: 'request-that-is-gone' } satisfies ChildQuestionPayload
      })
      const wake = s.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => s.terminal(wake), 'the wake to be settled')
      expect(s.run(wake).status).toBe('cancelled')
      expect(s.d.engine.inbox.get(stale.inboxId)!.status).toBe('acknowledged')
      expect(parentTurns()).toBe(turnsBefore)
    })

    it('a thread that is not a subagent routes nothing', async () => {
      const s = await scene({ parentBlocks: false })
      const answer = (s.d.orch as any).questions.requestAnswers([{ id: 'q', prompt: 'Plain question?' }], s.parentId) as Promise<unknown>
      answer.catch(() => undefined)
      expect(s.d.engine.inbox.listForThread(s.parentId).filter(isChildQuestionRow)).toEqual([])
      ;(s.d.orch as any).questions.dismissAllForThread(s.parentId)
    })
  })

  describe('Lineage\'s Stop all', () => {
    it('stops every working subagent of the thread and everything below each, in one call, and leaves the thread\'s own turn running', async () => {
      const s = await scene({ secondChild: true, grandchild: true })
      const second = s.d.engine.delegations.get(s.out.second.delegationId)!
      const grand = s.d.engine.delegations.get(s.out.grand.delegationId)!
      const result = await s.protocol('subagents.stopAll', { threadId: s.parentId })
      expect(result).toMatchObject({ threadId: s.parentId, ok: true })
      expect((result as { stopped: string[] }).stopped.sort()).toEqual([s.childThreadId, second.childThreadId].sort())
      await waitFor(() => [s.delegation.childRunId, second.childRunId, grand.childRunId].every((id) => s.terminal(id)), 'the subagents to stop')
      for (const id of [s.delegation.childRunId, second.childRunId, grand.childRunId]) expect(s.run(id)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user' } })
      for (const id of [s.delegation.delegationId, second.delegationId, grand.delegationId]) expect(s.task(id).status).toBe('cancelled')
      // The thread itself was not stopped: its turn runs on, and it is told what happened.
      expect(s.run(s.parentRunId).status).toBe('running')
      expect(s.run(s.parentRunId).outcome?.stopRequested).toBeUndefined()
      expect(s.generation(s.parentId)).toBe(0)
      expect(s.generation(s.childThreadId)).toBe(1)
      expect(s.d.engine.inbox.listPending(s.parentId).filter((row) => (row.payload as { kind?: string }).kind === 'delegation_stopped')).toHaveLength(2)
      // Nothing is left to stop.
      expect(await s.protocol('subagents.stopAll', { threadId: s.parentId })).toMatchObject({ ok: false, stopped: [] })
    })
  })

  describe('Stop all and the parent\'s turn', () => {
    it('wakes nothing for a parent whose turn is over: the person who pressed the button asked', async () => {
      const s = await scene({ parentBlocks: false, secondChild: true })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      await s.protocol('subagents.stopAll', { threadId: s.parentId })
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
      expect(s.d.engine.inbox.listForThread(s.parentId).filter((row) => (row.payload as { kind?: string }).kind === 'delegation_stopped')).toEqual([])
      expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    })

    it('one subagent that cannot be stopped does not stop the others from being stopped', async () => {
      const s = await scene({ secondChild: true })
      const second = s.d.engine.delegations.get(s.out.second.delegationId)!
      const orch = s.d.orch
      const real = orch.stopThread.bind(orch)
      vi.spyOn(orch, 'stopThread').mockImplementation((threadId, ...rest) =>
        threadId === s.childThreadId ? Promise.reject(new Error('boom')) : real(threadId, ...rest))
      const result = await s.protocol('subagents.stopAll', { threadId: s.parentId })
      expect(result).toMatchObject({ ok: true })
      await waitFor(() => s.terminal(second.childRunId), 'the second subagent to stop')
      expect(s.run(second.childRunId).status).toBe('interrupted')
    })
  })

  describe('a steer of a run the Stop ended, with rows that arrived after it', () => {
    it('gives those rows back, so they are delivered again', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      await s.d.orch.stopThread(s.parentId, 'user')
      // Newer work reported to the parent after the Stop; a steer for the old run carried it.
      const row = s.d.engine.inbox.append({ threadId: s.parentId, kind: 'reconcile_notice', payload: { text: 'newer news' } })
      const effect = s.d.engine.outbox.enqueue({
        threadId: s.parentId, runId: s.parentRunId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { runId: s.parentRunId, threadId: s.parentId, text: 'x', inboxIds: [row.inboxId] }
      })
      s.d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
      ;(s.d.orch as any).executeTurnSteerEffect(effect)
      expect(s.d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
    })
  })

  describe('a follow-up whose run cannot be created', () => {
    it('still queues the person\'s steer text, without a run', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      vi.spyOn(s.d.orch as any, 'scheduleQueueDrain').mockImplementation(() => undefined)
      vi.spyOn(s.d.engine.store, 'createRun').mockImplementation(() => { throw new Error('run database unavailable') })
      expect(s.d.orch.steerThread(s.childThreadId, 'please also check the tests')).toBe(true)
      s.gate.child.resolve()
      await waitFor(() => s.d.store.loadMessageQueue(s.childThreadId).length > 0, 'the steer text to be queued')
      expect(s.d.store.loadMessageQueue(s.childThreadId)).toMatchObject([{ content: 'please also check the tests', source: 'steer-followup', internal: true }])
      expect(s.d.store.loadMessageQueue(s.childThreadId)[0].runId).toBeUndefined()
    })
  })

  describe('task_cancel repeated', () => {
    it('does not touch newer work the subagent started after the task it names ended', async () => {
      const newer = deferred()
      releases.push(newer.resolve)
      const s = await scene({ childScript: async (input) => { await until(newer.promise, input.signal); return 'newer done' } })
      const first = await (s.d.orch as any).taskCancel(s.parentId, { delegationId: s.delegation.delegationId })
      expect(first.cancelled).toEqual([s.delegation.delegationId])
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the cancelled task\'s run to end')
      // Newer work on the same subagent: a person's message starts a new run.
      const sent = await s.d.orch.send('newer work', false, { threadId: s.childThreadId, source: 'gui', clientRequestId: 'newer', awaitMode: 'ack' })
      await waitFor(() => s.run(sent.runId!).status === 'running', 'the newer run to start')
      const generation = s.generation(s.childThreadId)
      expect(await (s.d.orch as any).taskCancel(s.parentId, { delegationId: s.delegation.delegationId })).toMatchObject({ status: 'cancelled', cancelled: [] })
      expect(s.run(sent.runId!)).toMatchObject({ status: 'running' })
      expect(s.run(sent.runId!).outcome?.stopRequested).toBeUndefined()
      expect(s.generation(s.childThreadId)).toBe(generation)
    })
  })

  describe('a steer of a run the Stop ended', () => {
    it('delivers nothing and makes no work, and a late steer keeps the generation of the run it was meant for', async () => {
      const s = await scene()
      await s.d.orch.stopThread(s.parentId, 'user')
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to stop')
      const orch = s.d.orch as any
      const effect = { effectId: 'effect:late-steer', payload: { runId: s.parentRunId, threadId: s.parentId, text: 'a steer that outlived its run' } }
      vi.spyOn(orch, 'scheduleQueueDrain').mockImplementation(() => undefined)
      orch.executeTurnSteerEffect(effect)
      expect(s.d.store.loadMessageQueue(s.parentId)).toEqual([])
      // Whatever reaches the queue for that run is stamped older than the Stop, never with the new generation.
      orch.enqueueLateSteer(s.parentId, 'late', undefined, undefined, s.parentRunId)
      const [entry] = s.d.store.loadMessageQueue(s.parentId)
      expect(entry).toMatchObject({ source: 'steer-late', stopGeneration: 0 })
      expect(s.generation(s.parentId)).toBe(1)
    })
  })

  describe('queue entries below the thread a Stop was aimed at', () => {
    it('removes tasks and stale notices, and keeps what a person queued, with a run or without, the internal fallback entry of their steer included', async () => {
      const s = await scene()
      const orch = s.d.orch as any
      // Queued behind the subagent's running task: a person's message (with its run), a steer that missed its turn
      // (admitted before the Stop), the internal entry a steer falls back to when its run cannot be created, and two a person queued that name no run
      // (the composer's queue and a steer sent while another process held the thread).
      const typed = await s.d.orch.send('typed to the worker', false, { threadId: s.childThreadId, source: 'gui', clientRequestId: 'typed', awaitMode: 'ack' })
      const late = orch.enqueueForThread(s.childThreadId, { content: 'late notice' }, { source: 'steer-late' })
      const internal = orch.enqueueForThread(s.childThreadId, { content: 'internal follow-up' }, { source: 'steer-followup', internal: true })
      const nameless = orch.enqueueForThread(s.childThreadId, { content: 'no run' }, { source: 'remote' })
      const external = orch.enqueueExternalSteer(s.childThreadId, 'steer text', { source: 'protocol-steer' })
      const ids = () => s.d.store.loadMessageQueue(s.childThreadId).map((item) => item.id).sort()
      expect(ids()).toEqual([typed.queueItem!.id, late.id, internal.id, nameless.id, external.id].sort())
      await s.d.orch.stopThread(s.parentId, 'user')
      expect(ids()).toEqual([typed.queueItem!.id, internal.id, nameless.id, external.id].sort())
      expect(s.run(typed.runId!).status).toBe('queued')
      // It runs once the stopped task is over.
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent to stop')
      await waitFor(() => {
        s.d.orch.recoverAndDrainPendingQueues()
        return s.run(typed.runId!).status === 'completed'
      }, 'the person\'s message to run', 15_000)
      expect(s.childTurns().some((prompt) => prompt.includes('typed to the worker'))).toBe(true)
    })
  })

  describe('a Stop without a run engine', () => {
    it('ends the thread\'s turn and its channel turn both', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mousse-stop-no-engine-'))
      const previous = process.env.MOUSSE_HOME
      try {
        process.env.MOUSSE_HOME = dir
        const orch = createOrchestrator(dir, new ThreadDataStore(new ProjectManager()))
        const turn = vi.spyOn(orch, 'abortActiveTurn').mockReturnValue(true)
        const channel = vi.spyOn(orch, 'abortChannelTurn').mockReturnValue(true)
        await expect(orch.stopThread('thread-1', 'user')).resolves.toMatchObject({ ok: true, status: 'stopped' })
        expect(turn).toHaveBeenCalledTimes(1)
        expect(channel).toHaveBeenCalledTimes(1)
      } finally {
        if (previous === undefined) delete process.env.MOUSSE_HOME
        else process.env.MOUSSE_HOME = previous
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('steers the subagent never read (follow-up from the hold review)', () => {
    /** The subagent's first turn ends with a person's steer unread; its follow-up run is queued but not drained yet. */
    const heldBySteer = async () => {
      const s = await scene({
        parentBlocks: false,
        childScript: (input) => (input.prompt.includes('please also check the tests') ? 'I checked the tests too.' : `child said: ${input.prompt}`)
      })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      // Nothing drains the queue until the test says so.
      vi.spyOn(s.d.orch as any, 'scheduleQueueDrain').mockImplementation(() => undefined)
      expect(s.d.orch.steerThread(s.childThreadId, 'please also check the tests')).toBe(true)
      s.gate.child.resolve()
      await waitFor(() => s.d.engine.listRuns(s.childThreadId).some((run) => run.source === 'steer-followup'), 'the follow-up run to be queued')
      const followUp = s.d.engine.listRuns(s.childThreadId).find((run) => run.source === 'steer-followup')!
      return { s, followUp }
    }

    it('the follow-up is a queued run from the start: it holds the task by itself, with no session in memory, and survives a restart', async () => {
      const { s, followUp } = await heldBySteer()
      expect(followUp.status).toBe('queued')
      expect(s.d.store.loadMessageQueue(s.childThreadId).map((item) => item.runId)).toEqual([followUp.runId])
      expect(s.task(s.delegation.delegationId).status).toBe('running')
      ;(s.d.orch as any).sessions.delete(s.childThreadId)
      expect(childBusy(s.d.engine.store, s.childThreadId)).toBe(true)

      // The daemon dies before the follow-up ran. Boot judges every running task: this one is still held.
      const homeDir = home!
      await s.d.crash()
      const reborn = phase6Daemon(homeDir, [s.adapter])
      daemon = reborn
      expect(reborn.engine.delegations.get(s.delegation.delegationId)!.status).toBe('running')
      expect(reborn.engine.getRun(followUp.runId)!.status).toBe('queued')
      await waitFor(() => {
        reborn.orch.recoverAndDrainPendingQueues()
        return reborn.engine.delegations.get(s.delegation.delegationId)!.status === 'result_available'
      }, 'the task to publish after the follow-up ran', 15_000)
      expect(reborn.engine.delegations.get(s.delegation.delegationId)!.result).toMatchObject({ runStatus: 'completed', text: 'I checked the tests too.' })
    })

    it('a crash between the follow-up run and its queue entry leaves no run that holds the task for ever: boot cancels it and the task publishes', async () => {
      const { s, followUp } = await heldBySteer()
      expect(s.task(s.delegation.delegationId).status).toBe('running')
      // The process died after the run was written and before the entry was saved.
      s.d.store.saveMessageQueue(s.childThreadId, [])
      const homeDir = home!
      await s.d.crash()
      const reborn = phase6Daemon(homeDir, [s.adapter])
      daemon = reborn
      reborn.orch.recoverRunEngineOnBoot()
      expect(reborn.engine.getRun(followUp.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'daemon_restart' } })
      expect(reborn.engine.delegations.get(s.delegation.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed' } })
    })

    it('boot leaves a follow-up whose queue entry exists', async () => {
      const { s, followUp } = await heldBySteer()
      const homeDir = home!
      await s.d.crash()
      const reborn = phase6Daemon(homeDir, [s.adapter])
      daemon = reborn
      reborn.orch.recoverRunEngineOnBoot()
      expect(reborn.engine.getRun(followUp.runId)!.status).toBe('queued')
      expect(reborn.engine.delegations.get(s.delegation.delegationId)!.status).toBe('running')
    })

    it('the task is released as soon as the queued follow-up leaves without running', async () => {
      const { s, followUp } = await heldBySteer()
      expect(s.task(s.delegation.delegationId).status).toBe('running')
      ;(s.d.orch as any).cancelQueuedRuns([followUp.runId])
      expect(s.task(s.delegation.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed' } })
    })

    it('a person\'s plain-text steer holds the subagent\'s task until the subagent has answered it', async () => {
      let delegationId = ''
      let statusWhenAnswering = ''
      const answerGate = deferred()
      releases.push(answerGate.resolve)
      const s = await scene({
        parentBlocks: false,
        childScript: async (input) => {
          if (!input.prompt.includes('please also check the tests')) return `child said: ${input.prompt}`
          statusWhenAnswering = s.d.engine.delegations.get(delegationId)!.status
          await until(answerGate.promise, input.signal)
          return 'I checked the tests too.'
        }
      })
      delegationId = s.delegation.delegationId
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      // What the run engine says about the task at the instant the subagent's first turn is written
      // terminal: the window in which the steer lives only in the turn's memory.
      const atTerminalWrite: string[] = []
      s.d.engine.on('event', (event: { type: string; runId: string | null; payload: { status?: string } }) => {
        if (event.type === 'run.status' && event.runId === s.delegation.childRunId && event.payload.status === 'completed')
          atTerminalWrite.push(s.d.engine.delegations.get(delegationId)!.status)
      })
      // The steer reaches the subagent's live turn, which ends without ever reading it.
      expect(s.d.orch.steerThread(s.childThreadId, 'please also check the tests')).toBe(true)
      s.gate.child.resolve()
      await waitFor(() => s.terminal(s.delegation.childRunId), 'the subagent\'s first turn to end')
      expect(atTerminalWrite).toEqual(['running'])
      // The steer is the subagent's next turn; the task is still held while it runs, and the parent hears nothing.
      await waitFor(() => statusWhenAnswering !== '', 'the subagent to answer the steer', 15_000)
      expect(statusWhenAnswering).toBe('running')
      expect(s.d.engine.inbox.listForThread(s.parentId).filter((row) => row.kind === 'child_result')).toEqual([])
      answerGate.resolve()
      await waitFor(() => s.task(delegationId).status === 'result_available', 'the task to publish', 15_000)
      expect(s.task(delegationId).result).toMatchObject({ runStatus: 'completed', text: 'I checked the tests too.' })
      expect(s.d.engine.inbox.listForThread(s.parentId).filter((row) => row.kind === 'child_result')).toHaveLength(1)
    })

    it('a thread whose steers were all read publishes at the end of its turn, as before', async () => {
      const s = await scene({ parentBlocks: false })
      await waitFor(() => s.terminal(s.parentRunId), 'the parent to end its turn')
      s.gate.child.resolve()
      await waitFor(() => s.task(s.delegation.delegationId).status === 'result_available', 'the task to publish')
      expect(s.task(s.delegation.delegationId).result).toMatchObject({ text: 'child done' })
    })
  })
})
