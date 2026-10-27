import { afterEach, describe, expect, it } from 'vitest'
import { recordRunResultText } from '../../src/mms/run/delegation/hold'
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

  it('cancelling a task whose result is already published acknowledges its inbox row, so it never wakes the parent', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    f.finish(child.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    expect(f.engine.delegations.get(child.delegationId)!.status).toBe('result_available')
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)

    expect(await f.engine.cancelDelegation(child.delegationId)).toEqual([child.delegationId])
    expect(f.engine.delegations.get(child.delegationId)!.status).toBe('cancelled')
    expect(f.engine.inbox.listForDelegation(child.delegationId).map((row) => row.status)).toEqual(['acknowledged'])
    expect(f.reconciler.runOnce().wakes.wakes).toEqual([])
  })

  it('cancelling a task whose wake has not started cancels the wake run; another task still wakes the parent', async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const cancelledTask = await f.delegate(parent.runId, 'call-1')
    f.finish(cancelledTask.childRunId)
    f.engine.markTerminal(parent.runId, 'completed')
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    expect(f.engine.getRun(wakeRunId)!.status).toBe('queued')

    await f.engine.cancelDelegation(cancelledTask.delegationId)
    expect(f.engine.getRun(wakeRunId)!.status).toBe('cancelled')
    expect(f.outbox.listForRun(wakeRunId).find((effect) => effect.kind === 'turn.start')!.status).toBe('cancelled')

    // A second task that finished is unaffected by the first one's cancel.
    const parent2 = await f.runningRun('parent')
    const kept = await f.delegate(parent2.runId, 'call-2')
    f.finish(kept.childRunId)
    f.engine.markTerminal(parent2.runId, 'completed')
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
    expect(f.engine.delegations.get(kept.delegationId)!.status).toBe('result_available')
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

  describe('a subagent whose run is paused by a usage limit (SPEC §5)', () => {
    const UNTIL = '2026-10-12T01:00:00.000Z'
    const pause = { reason: 'usage_limit', until: UNTIL, estimated: false, count: 1, autoResume: true } as const

    /** A parent run, its task into `child-1`, and the child's run paused with a timer at the reset. */
    const pausedChild = async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const task = await f.delegate(parent.runId, 'call-1')
      f.engine.markStarting(task.childRunId)
      f.engine.markRunning(task.childRunId)
      f.engine.pauseRun({ runId: task.childRunId, pause, resumeAt: UNTIL })
      return { parent, task }
    }

    it('keeps the task running while the pause lasts, whatever the parent does', async () => {
      const { parent, task } = await pausedChild()
      f!.engine.markTerminal(parent.runId, 'completed')
      f!.engine.settleAllWaitingDelegations()
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('running')
      expect(f!.engine.inbox.listForThread('parent')).toEqual([])
    })

    it('Cancel publishes the failure to the parent', async () => {
      const { task } = await pausedChild()

      f!.engine.endPause(task.childRunId, 'cancel')

      expect(f!.engine.delegations.get(task.delegationId)).toMatchObject({
        status: 'failed',
        result: { runStatus: 'cancelled', error: 'Paused by a usage limit; cancelled.', runId: task.childRunId }
      })
      expect(f!.engine.inbox.listPending('parent')).toHaveLength(1)
    })

    it.each([
      ['automatic', 'resume', 'auto'],
      ['manual', 'resume_now', 'user']
    ] as const)('a %s resume publishes the resumed run\'s final text and run id, not the paused run\'s partial text', async (_name, source, from) => {
      const { task } = await pausedChild()
      // What the paused turn said before the limit: kept as the run's text, but not the task's result.
      recordRunResultText(f!.store, f!.engine.getRun(task.childRunId)!, 'Partial: reading the files')

      const sent = await f!.engine.dispatch({ kind: 'send', threadId: 'child-1', clientRequestId: `queue:resume:${task.childRunId}`, source, continuationOfRunId: task.childRunId })
      if (sent.status !== 'accepted') throw new Error(`rejected: ${sent.reason}`)
      expect(f!.engine.getRun(sent.runId)!.outcome).toMatchObject({ continuationOf: task.childRunId, resumedFromPause: from })
      // The paused run is over, but the task keeps running: the continuation is live.
      expect(f!.engine.getRun(task.childRunId)!.status).toBe('interrupted')
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('running')

      f!.finish(sent.runId, 'Final: all modules reviewed')

      expect(f!.engine.delegations.get(task.delegationId)).toMatchObject({
        status: 'result_available',
        result: { runStatus: 'completed', text: 'Final: all modules reviewed', runId: sent.runId }
      })
      expect(f!.engine.inbox.listPending('parent')).toHaveLength(1)
    })

    it('Stop of the parent ends the child\'s pause and cancels its timer; the task is cancelled, not published', async () => {
      const { task } = await pausedChild()

      f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })

      expect(f!.engine.getRun(task.childRunId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'stop' } } })
      expect(f!.outbox.listForRun(task.childRunId).find((effect) => effect.kind === 'run.resume')!.status).toBe('cancelled')
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('cancelled')
      expect(f!.engine.inbox.listPending('parent')).toEqual([])
    })
  })

  describe('a follow-up on an existing subagent (issue #142)', () => {
    const followUp = (f: DelegationFixture, parentRunId: string, overrides: Record<string, unknown> = {}) => f.engine.dispatch({
      kind: 'send',
      threadId: 'child-1',
      clientRequestId: 'follow-up',
      source: 'delegation',
      prompt: 'again',
      delegation: { parentThreadId: 'parent', parentRunId, prompt: 'again', wake: 'always', ...overrides }
    })

    it('writes the run and its delegation row in one commit, copying the subagent\'s policy', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const first = await f.delegate(parent.runId, 'call-1', { workspace: 'shared', role: 'review', instanceId: 'pi:openai', model: 'gpt-x' })
      f.finish(first.childRunId, 'first')
      const sent = await followUp(f, parent.runId, { workspace: 'shared', role: 'review', provider: 'pi:openai', model: 'gpt-x', modeCeiling: 'plan', accessLevel: 'read' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const task = f.engine.delegations.getByChildRun(sent.runId)!
      expect(task).toMatchObject({ parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', status: 'running', workspace: 'shared', role: 'review', provider: 'pi:openai', model: 'gpt-x', modeCeiling: 'plan', accessLevel: 'read' })
      expect(task.delegationId).not.toBe(first.delegationId)
      f.finish(sent.runId, 'second')
      expect(f.engine.delegations.get(task.delegationId)!.result!.text).toBe('second')
      expect(f.engine.inbox.listPending('parent')).toHaveLength(2)
      // The first task's result is untouched.
      expect(f.engine.delegations.get(first.delegationId)!.result!.text).toBe('first')
    })

    it('a retry with the same clientRequestId replays the first run and writes no second row', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      await f.delegate(parent.runId, 'call-1')
      const one = await followUp(f, parent.runId)
      const two = await followUp(f, parent.runId)
      expect(two).toMatchObject({ status: 'accepted', replayed: true, runId: one.status === 'accepted' ? one.runId : '' })
      expect(f.engine.delegations.listForChildThread('child-1')).toHaveLength(2)
      expect(f.engine.listRuns('child-1')).toHaveLength(2)
    })

    it('refuses a thread that is not the parent\'s subagent, or a parent run of another thread, and writes nothing', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const other = await f.runningRun('other')
      await f.delegate(parent.runId, 'call-1')
      const runs = f.engine.listRuns('child-1').length
      await expect(followUp(f, parent.runId, { parentThreadId: 'other' })).rejects.toThrow('not a subagent')
      await expect(followUp(f, other.runId)).rejects.toThrow('is not a run of thread parent')
      expect(f.engine.listRuns('child-1')).toHaveLength(runs)
      expect(f.engine.delegations.listForChildThread('child-1')).toHaveLength(1)
      expect(f.store.getReceipt('follow-up')).toBeNull()
    })

    it('is refused, as parent_stopping, while the parent run is being stopped', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      await f.delegate(parent.runId, 'call-1')
      await f.engine.dispatch({ kind: 'stop', threadId: 'parent', runId: parent.runId, clientRequestId: 'stop-1' })
      await expect(followUp(f, parent.runId)).rejects.toMatchObject({ reason: 'parent_stopping' })
      expect(f.engine.delegations.listForChildThread('child-1')).toHaveLength(1)
      expect(f.engine.listRuns('child-1')).toHaveLength(1)
    })
  })

  describe('a person\'s message in a subagent\'s thread is tracked (issue #142, D2)', () => {
    const send = (f: DelegationFixture, source: string, id = `send:${source}`) =>
      f.engine.dispatch({ kind: 'send', threadId: 'child-1', clientRequestId: id, source, prompt: 'hello' })

    it.each(['gui', 'cli', 'channel', 'internal'])('a %s message gets a delegation row tied to the parent\'s latest run, with the subagent\'s policy', async (source) => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const first = await f.delegate(parent.runId, 'call-1', { workspace: 'shared', role: 'review', modeCeiling: 'plan', accessLevel: 'read' })
      f.finish(first.childRunId, 'first')
      f.engine.markTerminal(parent.runId, 'completed')
      const latest = await f.runningRun('parent')
      const sent = await send(f, source)
      if (sent.status !== 'accepted') throw new Error('send rejected')
      expect(f.engine.delegations.getByChildRun(sent.runId)).toMatchObject({
        parentThreadId: 'parent', parentRunId: latest.runId, status: 'running', wake: 'always', workspace: 'shared', role: 'review', modeCeiling: 'plan', accessLevel: 'read'
      })
      f.finish(sent.runId, 'answer')
      expect(f.engine.inbox.listPending('parent').map((row) => (row.payload as { result: { text: string } }).result.text)).toEqual(['first', 'answer'])
    })

    it.each(['delegation', 'wake', 'steer-late', 'steer-followup', 'integration', 'schedule', 'protocol', 'queue', 'lease-race'])(
      'a %s run is not tracked',
      async (source) => {
        f = delegationFixture()
        const parent = await f.runningRun('parent')
        const first = await f.delegate(parent.runId, 'call-1')
        f.finish(first.childRunId)
        const sent = await send(f, source)
        if (sent.status !== 'accepted') throw new Error('send rejected')
        expect(f.engine.delegations.getByChildRun(sent.runId)).toBeNull()
        expect(f.engine.delegations.listForChildThread('child-1')).toHaveLength(1)
      }
    )

    it('is not tracked when the parent is gone, has no run, or the thread is not a subagent', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const first = await f.delegate(parent.runId, 'call-1')
      f.finish(first.childRunId)
      f.gone.add('parent')
      const orphaned = await send(f, 'gui', 'orphaned')
      if (orphaned.status !== 'accepted') throw new Error('send rejected')
      expect(f.engine.delegations.getByChildRun(orphaned.runId)).toBeNull()
      f.gone.clear()
      const plain = await f.engine.dispatch({ kind: 'send', threadId: 'plain', clientRequestId: 'plain-1', source: 'gui' })
      if (plain.status !== 'accepted') throw new Error('send rejected')
      expect(f.engine.delegations.getByChildRun(plain.runId)).toBeNull()
    })

    it('a replayed send writes no second row', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const first = await f.delegate(parent.runId, 'call-1')
      f.finish(first.childRunId)
      await send(f, 'gui', 'same')
      await send(f, 'gui', 'same')
      expect(f.engine.delegations.listForChildThread('child-1')).toHaveLength(2)
    })
  })

  describe('titles (issue #142, D4)', () => {
    it('a taken title creates no thread; a retry replays its receipt before the title is checked', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const first = await f.delegate(parent.runId, 'call-1', { title: 'API reviewer' })
      const created = f.requests.length
      await expect(f.delegate(parent.runId, 'call-2', { title: '  api   REVIEWER ' })).rejects.toMatchObject({ reason: 'title_taken', childThreadIds: [first.childThreadId] })
      // The conflict is found before a thread exists: nothing was created, so nothing needs deleting.
      expect(f.requests).toHaveLength(created)
      expect([...f.threads]).toEqual([first.childThreadId])
      expect(f.deleted).toEqual([])
      expect(f.engine.delegations.listForParentThread('parent')).toHaveLength(1)
      // The same call again is the first call: its own receipt wins, even though the title is held now.
      expect(await f.delegate(parent.runId, 'call-1', { title: 'API reviewer' })).toEqual({ ...first, replayed: true })
    })

    it('another parent may use the same title, and a deleted subagent frees its title', async () => {
      f = delegationFixture()
      const a = await f.runningRun('parent-a')
      const b = await f.runningRun('parent-b')
      const mine = await f.delegate(a.runId, 'call-1', { title: 'API reviewer' })
      await f.delegate(b.runId, 'call-1', { title: 'API reviewer' })
      f.gone.add(mine.childThreadId)
      await f.delegate(a.runId, 'call-2', { title: 'API reviewer' })
      expect(f.engine.delegations.listForParentThread('parent-a')).toHaveLength(2)
    })

    it('a parent run that is being stopped cannot start subagents', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      await f.engine.dispatch({ kind: 'stop', threadId: 'parent', runId: parent.runId, clientRequestId: 'stop-1' })
      await expect(f.delegate(parent.runId, 'call-1', { title: 'API reviewer' })).rejects.toMatchObject({ reason: 'parent_stopping' })
      expect(f.requests).toEqual([])
      expect(f.engine.delegations.listForParentThread('parent')).toEqual([])
    })
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
