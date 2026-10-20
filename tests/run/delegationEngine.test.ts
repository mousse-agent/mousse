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
    const accepted = await f.delegate(parent.runId, 'call-1', { prompt: 'Write the tests', instanceId: 'pi:openai', model: 'gpt-x' })
    expect(accepted).toMatchObject({ childThreadId: 'child-1', replayed: false })
    expect(f.engine.delegations.getLineage('child-1')).toMatchObject({ parentThreadId: 'parent', parentRunId: parent.runId, relationship: 'subagent' })
    expect(f.engine.getRun(accepted.childRunId)).toMatchObject({ threadId: 'child-1', status: 'queued', source: 'delegation', clientRequestId: `delegation:${parent.runId}:call-1:child` })
    expect(f.engine.delegations.get(accepted.delegationId)).toMatchObject({ status: 'running', provider: 'pi:openai', model: 'gpt-x', parentRunId: parent.runId })
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
    // Cancelling again repeats only the stops still needed: the runs ended, so nothing new is enqueued.
    const effects = f.store.db.statement('SELECT COUNT(*) AS n FROM effects').get()!.n
    expect(await f.engine.cancelDelegation(child.delegationId)).toEqual(cancelled)
    expect(f.store.db.statement('SELECT COUNT(*) AS n FROM effects').get()!.n).toBe(effects)
  })

  it('task_cancel is retryable: a cancelled delegation whose child is still live is stopped again (H6, M4)', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    f.engine.markStarting(child.childRunId)
    f.engine.markRunning(child.childRunId)
    const grandchild = await f.delegate(child.childRunId, 'call-g')
    f.engine.markStarting(grandchild.childRunId)
    f.engine.markRunning(grandchild.childRunId)
    // A cancel that got as far as the delegation row (a crash or error after it).
    f.engine.delegations.setStatus({ delegationId: child.delegationId, from: 'running', to: 'cancelled' })
    expect(await f.engine.cancelDelegation(child.delegationId)).toEqual([grandchild.delegationId, child.delegationId])
    const interrupts = (runId: string) => f.outbox.listForRun(runId).filter((effect) => effect.kind === 'turn.interrupt')
    for (const runId of [child.childRunId, grandchild.childRunId]) {
      expect(f.engine.getRun(runId)!.outcome?.stopRequested).toBe(true)
      expect(interrupts(runId)).toHaveLength(1)
    }
    // The first interrupt ran but the child is still live: a repeated cancel replays its stop
    // receipt and enqueues a fresh interrupt; while one is pending it adds none.
    f.outbox.cancel(interrupts(child.childRunId)[0].effectId, f.now(), 'test')
    await f.engine.cancelDelegation(child.delegationId)
    expect(interrupts(child.childRunId).map((effect) => effect.status)).toEqual(['cancelled', 'pending'])
    await f.engine.cancelDelegation(child.delegationId)
    expect(interrupts(child.childRunId)).toHaveLength(2)
  })

  it('a child run that ends failed, interrupted, uncertain or cancelled publishes delegation status failed (S4)', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const outcomes = ['failed', 'interrupted', 'uncertain', 'cancelled'] as const
    for (const [index, status] of outcomes.entries()) {
      const child = await f.delegate(parent.runId, `call-${index}`)
      f.engine.markStarting(child.childRunId)
      f.engine.markRunning(child.childRunId)
      f.engine.markTerminal(child.childRunId, status, { error: status })
      expect(f.engine.delegations.get(child.delegationId)).toMatchObject({ status: 'failed', result: { runStatus: status } })
    }
    const done = await f.delegate(parent.runId, 'call-ok')
    f.finish(done.childRunId, 'ok')
    expect(f.engine.delegations.get(done.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'ok' } })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(5)
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

  it('recordDelegation of a run that is already recorded returns that delegation without a second row or notice', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const first = await f.delegate(parent.runId, 'call-1')
    f.finish(first.childRunId, 'first')
    const followUp = f.store.createRun({ threadId: 'child-1', source: 'delegation' })
    const input = { parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: followUp.runId, prompt: 'again', wake: 'always' as const }
    const recorded = f.engine.recordDelegation(input)
    const delegations = f.engine.delegations.listForParentRun(parent.runId).length
    const notices = f.engine.inbox.listPending('parent').length
    expect(f.engine.recordDelegation(input)).toEqual(recorded)
    expect(f.engine.delegations.listForParentRun(parent.runId)).toHaveLength(delegations)
    expect(f.engine.inbox.listPending('parent')).toHaveLength(notices)
  })

  it('recordDelegation refuses a run that belongs to another thread', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    await f.delegate(parent.runId, 'call-1')
    const stranger = f.store.createRun({ threadId: 'unrelated', source: 'delegation' })
    expect(() => f!.engine.recordDelegation({ parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: stranger.runId, prompt: 'x', wake: 'always' })).toThrow('is not a run of thread child-1')
    expect(f.engine.delegations.getByChildRun(stranger.runId)).toBeNull()
  })

  it('recordDelegation of a child run that already ended publishes its final transcript text', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const first = await f.delegate(parent.runId, 'call-1')
    f.finish(first.childRunId, 'first')
    const followUp = f.store.createRun({ threadId: 'child-1', source: 'delegation' })
    f.finish(followUp.runId)
    f.resultTexts.set(followUp.runId, 'the follow-up answer')
    const recorded = f.engine.recordDelegation({ parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: followUp.runId, prompt: 'again', wake: 'always' })
    expect(recorded).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'the follow-up answer' } })
    const notice = f.engine.inbox.listForDelegation(recorded.delegationId)
    expect(notice.map((row) => (row.payload as { result: { text?: string } }).result.text)).toEqual(['the follow-up answer'])
  })

  it('records the requested workspace and role on the delegation row', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const shared = await f.delegate(parent.runId, 'call-1', { workspace: 'shared', role: 'research' })
    expect(f.engine.delegations.get(shared.delegationId)).toMatchObject({ workspace: 'shared', role: 'research' })
    const isolated = await f.delegate(parent.runId, 'call-2')
    expect(f.engine.delegations.get(isolated.delegationId)).toMatchObject({ workspace: 'isolated', role: null })
  })

  it('a delegation whose transaction fails deletes the thread it created; the retry creates one thread', async () => {
    let failNext = false
    f = delegationFixture({
      fault: (point) => {
        if (failNext && point === 'delegation.beforeCommit') {
          failNext = false
          throw new Error('injected')
        }
      }
    })
    const parent = await f.runningRun('parent')
    failNext = true
    await expect(f.delegate(parent.runId, 'call-1')).rejects.toThrow('injected')
    expect(f.deleted).toEqual(['child-1'])
    expect([...f.threads]).toEqual([])
    expect(f.store.getReceipt(`delegation:${parent.runId}:call-1`)).toBeNull()
    expect(f.engine.delegations.getLineage('child-1')).toBeNull()

    const retried = await f.delegate(parent.runId, 'call-1')
    expect(retried).toMatchObject({ childThreadId: 'child-2', replayed: false })
    const replayed = await f.delegate(parent.runId, 'call-1')
    expect(replayed).toEqual({ ...retried, replayed: true })
    // The replay creates nothing: one live child thread, one delegation.
    expect([...f.threads]).toEqual(['child-2'])
    expect(f.requests).toHaveLength(2)
    expect(f.engine.delegations.listForParentRun(parent.runId)).toHaveLength(1)
  })

  it('a fork whose transaction fails deletes the thread it created; the retry creates one fork', async () => {
    let failNext = false
    f = delegationFixture({
      fault: (point) => {
        if (failNext && point === 'fork.beforeCommit') {
          failNext = false
          throw new Error('injected')
        }
      }
    })
    const source = await f.runningRun('source')
    f.finish(source.runId, 'source answer')
    const request = { sourceThreadId: 'source', atRunOrdinal: 1, clientRequestId: 'fork-1' }
    failNext = true
    await expect(f.engine.forkThread(request)).rejects.toThrow('injected')
    expect(f.deleted).toEqual(['fork-1'])
    expect([...f.threads]).toEqual([])
    expect(f.store.getReceipt('fork-1')).toBeNull()
    expect(f.engine.delegations.getLineage('fork-1')).toBeNull()

    const retried = await f.engine.forkThread(request)
    expect(retried).toMatchObject({ threadId: 'fork-2', replayed: false })
    expect(await f.engine.forkThread(request)).toEqual({ ...retried, replayed: true })
    expect([...f.threads]).toEqual(['fork-2'])
    expect(f.engine.delegations.getLineage('fork-2')).toMatchObject({ parentThreadId: 'source', relationship: 'fork' })
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
      expect(f.engine.delegations.get(id)).toMatchObject({ status: 'failed', result: { runStatus: 'interrupted' } })
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
