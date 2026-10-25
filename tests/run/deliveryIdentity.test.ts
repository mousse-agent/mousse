/**
 * Issue #142, delivery: every route that carries a subagent's result to its parent (a wake run, a
 * native steer, a steer that missed its turn and was queued) keeps the identity of the inbox rows
 * it carries. The text is rebuilt when the delivery runs, the rows follow the delivering run's
 * outcome, and a delivery that gives up is announced in the thread.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EffectRecord } from '../../src/mms/run/types'
import { MAX_INBOX_REDELIVERIES, restoreUndeliveredRows } from '../../src/mms/run/delegation/wake'
import { waitFor } from './phase6Fixture'
import { useSubagentWorld } from './subagentWorld'

describe('delivering a subagent result to its parent (issue #142)', () => {
  const world = useSubagentWorld()

  /** A parent that started one subagent that finished with `text`; its result is a pending inbox row. */
  const finished = async (text = 'All modules look fine.', parentReply?: Parameters<typeof world>[1]) => {
    const w = world(() => text, parentReply)
    w.steps['go'] = async (tools) => { w.out.first = await w.start(tools, 'API reviewer') }
    await w.say('go')
    await w.settled(w.out.first.childRunId)
    const [row] = w.d.engine.inbox.listPending(w.parent.id)
    return { ...w, row }
  }

  it('a wake run that completes acknowledges the row and the task it showed whole, without a task_status read', async () => {
    const { d, parent, out, reconciler, adapter, row } = await finished()
    const wakeRunId = reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake run')
    const wake = adapter.turns.find((turn) => turn.threadId === parent.id && turn.prompt.startsWith('Subagent'))!
    expect(wake.prompt).toBe(`Subagent "API reviewer" (thread ${out.first.childThreadId}) finished task ${out.first.delegationId}.\nAll modules look fine.\nFull result above.`)
    expect(d.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
    expect(d.engine.delegations.get(out.first.delegationId)!.status).toBe('acknowledged')
    // The wake message tells the app what it reports, so the app never parses the text.
    const message = d.orch.getMessages(parent.id).find((entry) => entry.role === 'user' && entry.content.startsWith('Subagent'))!
    expect(message.subagentNotice).toEqual([{ delegationId: out.first.delegationId, childThreadId: out.first.childThreadId, title: 'API reviewer', runStatus: 'completed', fullyShown: true }])
  })

  it('a result the notice cut leaves the task unread until the rest is read with task_status', async () => {
    const { d, parent, out, reconciler } = await finished('x'.repeat(5_000))
    const wakeRunId = reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake run')
    expect(d.engine.delegations.get(out.first.delegationId)!.status).toBe('result_available')
    expect((d.orch as any).taskStatus(parent.id, { delegationId: out.first.delegationId })).toMatchObject({ status: 'acknowledged' })
  })

  it('a wake run that fails acknowledges nothing, and the reconciler delivers the row again', async () => {
    let fail = true
    const { d, parent, out, reconciler, row } = await finished('Fine.', () => {
      if (fail) throw new Error('provider unavailable')
      return 'Parent done.'
    })
    const wakeRunId = reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => d.engine.getRun(wakeRunId)?.status === 'failed', 'the wake run to fail')
    expect(d.engine.inbox.get(row.inboxId)!.status).toBe('delivered')
    expect(d.engine.delegations.get(out.first.delegationId)!.status).toBe('result_available')
    fail = false
    const retried = reconciler.runOnce().wakes
    expect(retried.restored).toEqual([row.inboxId])
    await waitFor(() => d.engine.inbox.get(row.inboxId)!.status === 'acknowledged', 'the second delivery')
    expect(parent.id).toBeTruthy()
  })

  describe('a steer that carries notices', () => {
    /** A steer effect as rule 4 writes it, for the row, aimed at `runId`. */
    const steerFor = (w: Awaited<ReturnType<typeof finished>>, runId: string, text = 'stale text'): EffectRecord => {
      const effect = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId, kind: 'turn.steer', payload: { runId, threadId: w.parent.id, text, inboxIds: [w.row.inboxId] } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], effect.effectId)
      return effect
    }

    it('is rebuilt when it runs, with the title; a live turn takes it as a steer', async () => {
      const w = await finished()
      const run = w.d.engine.listRuns(w.parent.id)[0]
      const effect = steerFor(w, run.runId)
      const steered = vi.spyOn(w.d.orch, 'steerThread').mockReturnValue(true)
      // The run is terminal in this fixture, so make the engine report it live for this call.
      vi.spyOn(w.d.engine, 'getRun').mockReturnValue({ ...run, status: 'running' })
      ;(w.d.orch as any).executeTurnSteerEffect(effect)
      expect(steered).toHaveBeenCalledWith(w.parent.id, `Subagent "API reviewer" (thread ${w.out.first.childThreadId}) finished task ${w.out.first.delegationId}.\nAll modules look fine.\nFull result above.`, [expect.objectContaining({ title: 'API reviewer', fullyShown: true })])
    })

    it('is dropped when its rows were read in the meantime', async () => {
      const w = await finished()
      const run = w.d.engine.listRuns(w.parent.id)[0]
      const effect = steerFor(w, run.runId)
      w.d.engine.acknowledgeDelegation(w.out.first.delegationId)
      const steered = vi.spyOn(w.d.orch, 'steerThread').mockReturnValue(true)
      const enqueued = vi.spyOn(w.d.orch, 'enqueueForThread')
      ;(w.d.orch as any).executeTurnSteerEffect(effect)
      expect(steered).not.toHaveBeenCalled()
      expect(enqueued).not.toHaveBeenCalled()
    })

    it('a steer that missed its turn becomes a queued turn that keeps the rows\' identity: they follow that run and are read when it completes', async () => {
      const w = await finished()
      const run = w.d.engine.listRuns(w.parent.id)[0]
      const effect = steerFor(w, run.runId)
      // The steered run is over, so the steer cannot be taken by a live turn.
      expect(w.d.engine.getRun(run.runId)!.status).toBe('completed')
      ;(w.d.orch as any).executeTurnSteerEffect(effect)
      await waitFor(() => w.adapter.turns.some((turn) => turn.threadId === w.parent.id && turn.prompt.startsWith('Subagent')), 'the queued steer to run')
      const lateRun = w.d.engine.listRuns(w.parent.id).find((entry) => entry.source === 'steer-late')!
      await w.settled(lateRun.runId)
      await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the row to be read')
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
      const message = w.d.orch.getMessages(w.parent.id).find((entry) => entry.role === 'user' && entry.content.startsWith('Subagent'))!
      expect(message.subagentNotice?.[0]).toMatchObject({ delegationId: w.out.first.delegationId, fullyShown: true })
    })

    it('a queued steer whose rows were read before it started delivers nothing', async () => {
      const w = await finished()
      const item = (w.d.orch as any).enqueueForThread(w.parent.id, { content: 'queued text' }, { source: 'steer-late', inboxIds: [w.row.inboxId] })
      expect(item.inboxIds).toEqual([w.row.inboxId])
      w.d.engine.acknowledgeDelegation(w.out.first.delegationId)
      ;(w.d.orch as any).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.parent.id))
      await waitFor(() => w.d.orch.listQueue(w.parent.id).length === 0, 'the queue to be drained')
      expect(w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.includes('queued text'))).toEqual([])
      expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'steer-late')).toEqual([])
    })
  })

  describe('a delivery that gives up', () => {
    it('is announced in the thread once, and retrying delivers the result again', async () => {
      const { d, parent, row, out } = await finished()
      const run = d.engine.listRuns(parent.id)[0]
      const steer = () => d.engine.outbox.enqueue({ threadId: parent.id, runId: run.runId, kind: 'turn.steer', payload: { runId: run.runId, threadId: parent.id, text: 'x', inboxIds: [row.inboxId] } })
      let effect = steer()
      d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
      // The row has been delivered, and come back, as often as a delivery may; the next failure is the last.
      for (let attempt = 0; attempt < MAX_INBOX_REDELIVERIES; attempt += 1) {
        d.engine.inbox.markPendingAgain([row.inboxId])
        effect = steer()
        d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
      }
      d.engine.outbox.cancel(effect.effectId, new Date().toISOString(), 'test')
      d.engine.store.db.transaction(() => restoreUndeliveredRows(d.engine.store, d.engine.outbox))
      expect(d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered', payload: { deliveryFailed: true } })
      await waitFor(() => d.orch.getMessages(parent.id).some((message) => message.role === 'system' && message.content.includes('could not be delivered')), 'the notice')
      d.engine.store.db.transaction(() => restoreUndeliveredRows(d.engine.store, d.engine.outbox))
      const notices = d.orch.getMessages(parent.id).filter((message) => message.role === 'system' && message.content.includes('could not be delivered'))
      expect(notices).toHaveLength(1)
      expect(notices[0].content).toContain('subagent "API reviewer"')
      expect(notices[0].content).toContain(out.first.delegationId)
      expect(d.orch.retrySubagentDelivery(parent.id)).toBe(1)
      expect(d.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'pending' })
      expect(d.orch.retrySubagentDelivery(parent.id)).toBe(0)
    })
  })

})
