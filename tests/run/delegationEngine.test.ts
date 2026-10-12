import { afterEach, describe, expect, it } from 'vitest'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('RunEngine delegation (SPEC §14.1-§14.2)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  it('requestDelegation creates the child thread, lineage, child run, row and turn.start in one commit', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const accepted = await f.delegate(parent.runId, 'call-1', { prompt: 'Write the tests', provider: 'openai', model: 'gpt-x' })
    expect(accepted).toMatchObject({ childThreadId: 'child-1', replayed: false })
    expect(f.engine.delegations.getLineage('child-1')).toMatchObject({ parentThreadId: 'parent', parentRunId: parent.runId, relationship: 'subagent' })
    expect(f.engine.getRun(accepted.childRunId)).toMatchObject({ threadId: 'child-1', status: 'queued', source: 'delegation', clientRequestId: `delegation:${parent.runId}:call-1:child` })
    expect(f.engine.delegations.get(accepted.delegationId)).toMatchObject({ status: 'running', provider: 'openai', model: 'gpt-x', parentRunId: parent.runId })
    const [effect] = f.outbox.listForRun(accepted.childRunId)
    expect(effect).toMatchObject({ kind: 'turn.start', status: 'pending', threadId: 'child-1' })
    expect(effect.payload).toEqual({ threadId: 'child-1', runId: accepted.childRunId, prompt: 'Write the tests' })
  })

  it('a retried delegate_task with the same clientRequestId returns the same delegation and does nothing', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const first = await f.delegate(parent.runId, 'call-1')
    const again = await f.delegate(parent.runId, 'call-1')
    expect(again).toEqual({ ...first, replayed: true })
    expect(f.requests).toHaveLength(1)
    expect(f.engine.delegations.listForParentRun(parent.runId)).toHaveLength(1)
    expect(f.engine.listRuns('child-1')).toHaveLength(1)
    const other = await f.delegate(parent.runId, 'call-2')
    expect(other.childThreadId).toBe('child-2')
  })

  it('rejects a parent run of another thread and rolls back without a receipt', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    await expect(f.engine.requestDelegation({
      parentThreadId: 'elsewhere', parentRunId: parent.runId, clientRequestId: 'bad', prompt: 'x', workspace: 'isolated', wake: 'always'
    })).rejects.toThrow('is not a run of thread')
    expect(f.store.getReceipt('bad')).toBeNull()
  })

  it('task_cancel stops the child and its own delegations depth-first; late results cannot publish', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    f.engine.markStarting(child.childRunId)
    f.engine.markRunning(child.childRunId)
    const grandchild = await f.delegate(child.childRunId, 'call-g')
    const queuedSibling = await f.delegate(child.childRunId, 'call-q')
    f.engine.markStarting(grandchild.childRunId)
    f.engine.markRunning(grandchild.childRunId)

    const cancelled = await f.engine.cancelDelegation(child.delegationId)
    expect(cancelled).toEqual([grandchild.delegationId, queuedSibling.delegationId, child.delegationId])
    for (const id of cancelled) expect(f.engine.delegations.get(id)!.status).toBe('cancelled')
    // Active runs get a stop command and a turn.interrupt effect; a queued run ends at once.
    for (const runId of [child.childRunId, grandchild.childRunId]) {
      expect(f.engine.getRun(runId)!.outcome?.stopRequested).toBe(true)
      expect(f.outbox.listForRun(runId).map((effect) => effect.kind)).toContain('turn.interrupt')
    }
    expect(f.engine.getRun(queuedSibling.childRunId)!.status).toBe('cancelled')
    expect(f.outbox.listForRun(queuedSibling.childRunId).find((effect) => effect.kind === 'turn.start')!.status).toBe('cancelled')
    // The interrupted children finish late: nothing reaches any inbox.
    f.engine.markTerminal(grandchild.childRunId, 'interrupted', { interruptedBy: 'user' })
    f.engine.markTerminal(child.childRunId, 'completed', undefined, { resultText: 'late' })
    expect(f.engine.inbox.listForThread('parent')).toEqual([])
    expect(f.engine.inbox.listForThread('child-1')).toEqual([])
    // Cancelling again is a no-op.
    expect(await f.engine.cancelDelegation(child.delegationId)).toEqual([])
  })

  it('acknowledgeDelegation marks the delegation and its inbox rows acknowledged', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    expect(f.engine.acknowledgeDelegation(child.delegationId).status).toBe('running')
    f.finish(child.childRunId)
    expect(f.engine.acknowledgeDelegation(child.delegationId).status).toBe('acknowledged')
    expect(f.engine.inbox.listForDelegation(child.delegationId).map((row) => row.status)).toEqual(['acknowledged'])
  })

  it('recordDelegation ties a follow-up run on an existing child thread to the parent run', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const first = await f.delegate(parent.runId, 'call-1')
    f.finish(first.childRunId, 'first')
    const followUp = f.store.createRun({ threadId: 'child-1', source: 'delegation' })
    const recorded = f.engine.recordDelegation({ parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: followUp.runId, prompt: 'again', wake: 'always' })
    expect(recorded.status).toBe('running')
    f.finish(followUp.runId, 'second')
    expect(f.engine.delegations.get(recorded.delegationId)!.result!.text).toBe('second')
    expect(f.engine.inbox.listPending('parent')).toHaveLength(2)
    expect(() => f!.engine.recordDelegation({ parentThreadId: 'other', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: followUp.runId, prompt: 'x', wake: 'always' })).toThrow('not a subagent')
  })

  it('boot: a child cut off at restart publishes its failure, and a wake that never ran is redone', async () => {
    f = delegationFixture()
    const home = f.profileHome
    f.engine.reconcileOnBoot()
    const parent = await f.runningRun('parent')
    const running = await f.delegate(parent.runId, 'call-running')
    const queued = await f.delegate(parent.runId, 'call-queued')
    f.engine.markStarting(running.childRunId)
    f.engine.markRunning(running.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    // The daemon crashes here (no clean shutdown).
    f.dispose(true)

    f = delegationFixture({ profileHome: home, pid: 2 })
    const boot = f.engine.reconcileOnBoot()
    expect(boot.interrupted).toContain(running.childRunId)
    expect(boot.orphanedChildren).toEqual([queued.childRunId])
    for (const id of [running.delegationId, queued.delegationId])
      expect(f.engine.delegations.get(id)).toMatchObject({ status: 'result_available', result: { runStatus: 'interrupted' } })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(2)

    // A wake created before the next restart dies with its process-bound effect…
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.inbox.listPending('parent')).toEqual([])
    f.engine.shutdown()
    f.dispose(true)
    f = delegationFixture({ profileHome: home, pid: 3 })
    const again = f.engine.reconcileOnBoot()
    // …so boot cancels the wake run and the rows are pending again for rule 4.
    expect(again.recoveredWakes).toEqual([wakeRunId])
    expect(f.engine.getRun(wakeRunId)!.status).toBe('cancelled')
    expect(f.engine.inbox.listPending('parent')).toHaveLength(2)
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
  })
})
