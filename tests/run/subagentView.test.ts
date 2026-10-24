import { afterEach, describe, expect, it } from 'vitest'
import { buildSubagentView, childActivity, outcomeOfRun, taskOutcome } from '../../src/mms/run/delegation/subagentView'
import { subagentParentOfEvent } from '../../src/mms/run/delegation/subagentEvents'
import type { RunRecord } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('subagent status model (plan §3.3)', () => {
  let f: DelegationFixture | undefined
  const pending = new Set<string>()
  const names = new Map<string, string>()
  afterEach(() => {
    f?.dispose()
    f = undefined
    pending.clear()
    names.clear()
  })

  const view = (parent = 'parent') =>
    buildSubagentView(
      {
        delegations: f!.engine.delegations,
        store: f!.store,
        thread: (id) => (names.has(id) ? { name: names.get(id)! } : { name: id }),
        hasPendingQuestion: (id) => pending.has(id)
      },
      parent
    )
  const only = () => {
    const rows = view()
    expect(rows).toHaveLength(1)
    return rows[0]
  }
  /** A parent run and one delegation whose child run is still queued. */
  const started = async () => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    return { parent, child }
  }
  const running = (runId: string) => {
    f!.engine.markStarting(runId)
    f!.engine.markRunning(runId)
  }

  describe('child activity and state while a task runs', () => {
    it('a queued child run is queued', async () => {
      await started()
      expect(only()).toMatchObject({ activity: 'queued', state: 'queued', unread: false })
      expect(only().tasks[0]).toMatchObject({ outcome: 'running', continued: false })
    })

    it('a starting child run is starting, a running one is working', async () => {
      const { child } = await started()
      f!.engine.markStarting(child.childRunId)
      expect(only()).toMatchObject({ activity: 'starting', state: 'starting' })
      f!.engine.markRunning(child.childRunId)
      expect(only()).toMatchObject({ activity: 'working', state: 'working' })
    })

    it('a pending question outranks a running child run', async () => {
      const { child } = await started()
      running(child.childRunId)
      pending.add('child-1')
      expect(only()).toMatchObject({ activity: 'needs_input', state: 'needs_input' })
      pending.delete('child-1')
      expect(only().state).toBe('working')
    })
  })

  describe('task outcome once the child run ended', () => {
    it('a completed run is done and unread until the result is taken, and stays done after', async () => {
      const { child } = await started()
      f!.finish(child.childRunId)
      expect(only()).toMatchObject({ activity: 'idle', state: 'done', unread: true })
      f!.engine.acknowledgeDelegation(child.delegationId)
      expect(only()).toMatchObject({ state: 'done', unread: false })
      expect(only().tasks[0].outcome).toBe('done')
    })

    it.each([
      ['failed', { status: 'failed' as const, outcome: undefined }, 'failed'],
      ['uncertain', { status: 'uncertain' as const, outcome: undefined }, 'failed'],
      ['interrupted by the user', { status: 'interrupted' as const, outcome: { interruptedBy: 'user' as const } }, 'stopped'],
      ['interrupted by a restart', { status: 'interrupted' as const, outcome: { interruptedBy: 'daemon_restart' as const } }, 'interrupted'],
      ['cancelled', { status: 'cancelled' as const, outcome: undefined }, 'stopped']
    ])('a run that ended %s is %s', async (_name, end, expected) => {
      const { child } = await started()
      running(child.childRunId)
      f!.engine.markTerminal(child.childRunId, end.status, end.outcome)
      expect(only()).toMatchObject({ activity: 'idle', state: expected, unread: true })
    })

    it('reading a failure keeps it a failure', async () => {
      const { child } = await started()
      running(child.childRunId)
      f!.engine.markTerminal(child.childRunId, 'failed')
      f!.engine.acknowledgeDelegation(child.delegationId)
      expect(f!.engine.delegations.get(child.delegationId)!.status).toBe('acknowledged')
      expect(only()).toMatchObject({ state: 'failed', unread: false })
    })

    it('a cancelled task is stopped even though it had published a result', async () => {
      const { child } = await started()
      f!.finish(child.childRunId)
      await f!.engine.cancelDelegation(child.delegationId)
      expect(only()).toMatchObject({ state: 'stopped', unread: false })
    })

    it('a task whose child run ended before it published follows the run', async () => {
      const { child } = await started()
      const delegation = f!.engine.delegations.get(child.delegationId)!
      expect(delegation.status).toBe('running')
      const run = { ...f!.engine.getRun(child.childRunId)!, status: 'failed' } as RunRecord
      expect(taskOutcome(delegation, run)).toBe('failed')
      expect(taskOutcome(delegation, null)).toBe('interrupted')
    })
  })

  describe('a newer run overrides an older finished task', () => {
    it('a follow-up run makes the child active again while the finished task keeps its outcome', async () => {
      const { child } = await started()
      f!.finish(child.childRunId)
      const followUp = await f!.engine.dispatch({ kind: 'send', threadId: 'child-1', clientRequestId: 'follow-up', source: 'gui' })
      if (followUp.status !== 'accepted') throw new Error('send rejected')
      expect(only()).toMatchObject({ activity: 'queued', state: 'queued' })
      expect(only().tasks[0]).toMatchObject({ outcome: 'done', continued: true })
      running(followUp.runId)
      expect(only()).toMatchObject({ activity: 'working', state: 'working' })
      f!.finish(followUp.runId)
      expect(only()).toMatchObject({ activity: 'idle', state: 'done' })
      expect(only().tasks[0].continued).toBe(false)
    })

    it('a second task on the same child: earlier one is continued, the latest decides the row', async () => {
      const { parent, child } = await started()
      f!.finish(child.childRunId)
      const second = await f!.engine.dispatch({ kind: 'send', threadId: 'child-1', clientRequestId: 'second', source: 'gui' })
      if (second.status !== 'accepted') throw new Error('send rejected')
      const recorded = f!.engine.recordDelegation({
        parentThreadId: 'parent', parentRunId: parent.runId, childThreadId: 'child-1', childRunId: second.runId, prompt: 'again', wake: 'always'
      })
      running(second.runId)
      f!.engine.markTerminal(second.runId, 'failed')
      const row = only()
      expect(row.tasks.map((task) => [task.delegationId, task.outcome, task.continued])).toEqual([
        [child.delegationId, 'done', true],
        [recorded.delegationId, 'failed', false]
      ])
      expect(row).toMatchObject({ state: 'failed', latestDelegationId: recorded.delegationId, unread: true })
    })
  })

  describe('which children are listed', () => {
    it('lists one row per child with its request, oldest first, using the thread name as the title', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const a = await f.delegate(parent.runId, 'a', { instanceId: 'pi:openai', model: 'gpt-x', role: 'review', workspace: 'shared' })
      const b = await f.delegate(parent.runId, 'b')
      names.set(a.childThreadId, 'API reviewer')
      const rows = view()
      expect(rows.map((row) => row.title)).toEqual(['API reviewer', b.childThreadId])
      expect(rows[0]).toMatchObject({ provider: 'pi:openai', model: 'gpt-x', role: 'review', workspace: 'shared', childThreadId: a.childThreadId })
      expect(rows[1]).toMatchObject({ provider: null, workspace: 'isolated' })
    })

    it('leaves out a child whose thread is gone and a fork', async () => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      await f.delegate(parent.runId, 'a')
      const rows = buildSubagentView(
        { delegations: f.engine.delegations, store: f.store, thread: () => undefined, hasPendingQuestion: () => false },
        'parent'
      )
      expect(rows).toEqual([])
      f.store.db.transaction(() => {
        f!.engine.delegations.createLineage({ threadId: 'fork-x', parentThreadId: 'parent', parentRunId: parent.runId, relationship: 'fork' })
      })
      expect(view().map((row) => row.childThreadId)).toEqual(['child-1'])
    })

    it('another parent sees none of them', async () => {
      await started()
      expect(view('someone-else')).toEqual([])
    })
  })

  describe('pure helpers', () => {
    it.each([
      ['completed', undefined, 'done'],
      ['failed', undefined, 'failed'],
      ['uncertain', undefined, 'failed'],
      ['cancelled', undefined, 'stopped'],
      ['interrupted', 'user', 'stopped'],
      ['interrupted', 'daemon_restart', 'interrupted'],
      ['interrupted', 'provider', 'interrupted'],
      ['running', undefined, 'running'],
      ['queued', undefined, 'running']
    ] as const)('outcomeOfRun(%s, %s) is %s', (status, by, expected) => {
      expect(outcomeOfRun(status, by)).toBe(expected)
    })

    it('childActivity prefers a question, then working, starting, queued', () => {
      const run = (status: RunRecord['status']) => ({ status }) as RunRecord
      expect(childActivity([], false)).toBe('idle')
      expect(childActivity([run('completed')], false)).toBe('idle')
      expect(childActivity([run('queued')], false)).toBe('queued')
      expect(childActivity([run('queued'), run('starting')], false)).toBe('starting')
      expect(childActivity([run('queued'), run('finalizing')], false)).toBe('working')
      expect(childActivity([run('running')], true)).toBe('needs_input')
    })
  })

  describe('which run-store events change a parent’s list', () => {
    it.each([
      ['delegation.status', 'parent', { parentThreadId: 'parent' }, 'parent'],
      ['run.created', 'child-1', {}, 'parent'],
      ['run.status', 'child-1', {}, 'parent'],
      ['run.status', 'parent', {}, undefined],
      ['tool.status', 'child-1', {}, undefined],
      ['inbox.status', 'parent', {}, undefined]
    ])('%s on %s', async (type, threadId, payload, expected) => {
      await started()
      expect(subagentParentOfEvent(f!.engine.delegations, { type, threadId, payload })).toBe(expected)
    })
  })
})
