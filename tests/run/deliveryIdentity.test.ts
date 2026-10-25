/**
 * Issue #142, delivery: every route that carries a subagent's result to its parent (a wake run, a
 * native steer, a steer that missed its turn and was queued) keeps the identity of the inbox rows
 * it carries. The text is rebuilt when the delivery runs, the rows follow the delivering run's
 * outcome, and a delivery that gives up is announced in the thread.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EffectRecord } from '../../src/mms/run/types'
import { MAX_INBOX_REDELIVERIES, recoverWakesOnBoot, restoreUndeliveredRows } from '../../src/mms/run/delegation/wake'
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
      expect(steered).toHaveBeenCalledWith(w.parent.id, `Subagent "API reviewer" (thread ${w.out.first.childThreadId}) finished task ${w.out.first.delegationId}.\nAll modules look fine.\nFull result above.`, [expect.objectContaining({ title: 'API reviewer', fullyShown: true })], { inboxIds: [w.row.inboxId], effectId: effect.effectId })
      // What the notice showed is recorded when it is built.
      expect(w.d.engine.inbox.get(w.row.inboxId)!.payload).toMatchObject({ noticeShown: true })
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
      w.d.engine.inbox.markDelivered([w.row.inboxId], `queue:${item.id}`)
      w.d.engine.acknowledgeDelegation(w.out.first.delegationId)
      ;(w.d.orch as any).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.parent.id))
      await waitFor(() => w.d.orch.listQueue(w.parent.id).length === 0, 'the queue to be drained')
      expect(w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.includes('queued text'))).toEqual([])
      expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'steer-late')).toEqual([])
    })
  })

  describe('a row is delivered by one delivery at a time', () => {
    it('a queued steer drops the rows another delivery took over, and delivers only its own', async () => {
      const w = await finished()
      const item = (w.d.orch as any).enqueueForThread(w.parent.id, { content: 'queued text' }, { source: 'steer-late', inboxIds: [w.row.inboxId] })
      // The row went back to pending and a wake took it: the queue item no longer owns it.
      const wake = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: w.d.engine.listRuns(w.parent.id)[0].runId, kind: 'turn.steer', payload: { text: 'x' } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], wake.effectId)
      ;(w.d.orch as any).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.parent.id))
      await waitFor(() => w.d.orch.listQueue(w.parent.id).length === 0, 'the queue to be drained')
      expect(w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.startsWith('Subagent'))).toEqual([])
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: wake.effectId })
      expect(item.id).toBeTruthy()
    })

    it('rows a removed queue item carried go back to pending, without spending a delivery attempt', async () => {
      const w = await finished()
      const attempts = w.d.engine.inbox.pendingCount(w.row.inboxId, w.parent.id)
      const run = w.d.engine.listRuns(w.parent.id)[0]
      const effect = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: run.runId, kind: 'turn.steer', payload: { runId: run.runId, threadId: w.parent.id, text: 'x', inboxIds: [w.row.inboxId] } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], effect.effectId)
      // Keep the queue from draining so the item is still there to remove.
      const session = w.d.orch.getOrCreateSession(w.parent.id)
      session.turnAdmitted = true
      ;(w.d.orch as any).enqueueLateSteer(w.parent.id, 'x', { inboxIds: [w.row.inboxId], effectId: effect.effectId })
      const [item] = w.d.orch.listQueue(w.parent.id)
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: `queue:${item.id}` })
      w.d.orch.removeQueuedItem(w.parent.id, item.id)
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
      // A withdrawn delivery is not a failed one: the attempt count and the backoff are as before.
      expect(w.d.engine.inbox.pendingCount(w.row.inboxId, w.parent.id)).toBe(attempts)
      session.turnAdmitted = false
    })

    /** A queue item (`steer-late`) that carries the row, held in the queue by an admitted turn. */
    const queuedWithRow = async () => {
      const w = await finished()
      const run = w.d.engine.listRuns(w.parent.id)[0]
      const effect = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: run.runId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: run.runId, threadId: w.parent.id, text: 'x', inboxIds: [w.row.inboxId] } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], effect.effectId)
      const session = w.d.orch.getOrCreateSession(w.parent.id)
      session.turnAdmitted = true
      ;(w.d.orch as any).enqueueLateSteer(w.parent.id, 'x', { inboxIds: [w.row.inboxId], effectId: effect.effectId })
      const [item] = w.d.orch.listQueue(w.parent.id)
      return { ...w, item, session, effect }
    }

    it('a crash between releasing the rows and saving the removal is harmless: the item finds no rows it owns and is skipped', async () => {
      const w = await queuedWithRow()
      const save = vi.spyOn(w.d.store, 'saveMessageQueue').mockImplementation(() => { throw new Error('crash before the removal is saved') })
      expect(() => w.d.orch.removeQueuedItem(w.parent.id, w.item.id)).toThrow('crash before the removal is saved')
      save.mockRestore()
      // The rows were released first; the item is still queued.
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
      expect(w.d.orch.listQueue(w.parent.id).map((item) => item.id)).toEqual([w.item.id])
      w.session.turnAdmitted = false
      ;(w.d.orch as any).scheduleQueueDrain(w.session)
      await waitFor(() => w.d.orch.listQueue(w.parent.id).length === 0, 'the queue to be drained')
      expect(w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt === 'x')).toEqual([])
      // Rule 4 delivers the row, once.
      const wakeRunId = w.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake')
      expect(w.d.engine.inbox.get(w.row.inboxId)!.status).toBe('acknowledged')
    })

    it('a row whose queue item is gone (a crash after the removal was saved) goes back to pending at boot; one whose item exists stays', async () => {
      const w = await queuedWithRow()
      const orphan = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: w.d.engine.listRuns(w.parent.id)[0].runId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { text: 'y' } })
      const second = w.d.engine.inbox.append({ threadId: w.parent.id, kind: 'reconcile_notice', payload: { text: 'Integration finished.' } })
      w.d.engine.inbox.markDelivered([second.inboxId], orphan.effectId)
      w.d.engine.inbox.redirectDelivery([second.inboxId], 'queue:ghost-item')
      ;(w.d.orch as any).recoverQueuedRows()
      expect(w.d.engine.inbox.get(second.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: `queue:${w.item.id}` })
      w.session.turnAdmitted = false
    })

    it('a queued result cannot be promoted to a steer: its stale text would be sent without its rows', async () => {
      const w = await queuedWithRow()
      expect(() => w.d.orch.promoteQueueItemToSteer(w.parent.id, w.item.id)).toThrow(/cannot be sent as a steer/)
      expect(w.d.orch.listQueue(w.parent.id).map((item) => [item.id, item.intent])).toEqual([[w.item.id, 'normal']])
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: `queue:${w.item.id}` })
      w.session.turnAdmitted = false
    })

    it('a steer that carries notices is never given to a channel turn, which would take the text without the rows', async () => {
      const w = await finished()
      const channel = vi.spyOn(w.d.orch, 'steerChannelTurn').mockReturnValue(true)
      expect(w.d.orch.steerThread(w.parent.id, 'text', undefined, { inboxIds: [w.row.inboxId], effectId: 'effect:x' })).toBe(false)
      expect(channel).not.toHaveBeenCalled()
      expect(w.d.orch.steerThread(w.parent.id, 'plain steer')).toBe(true)
    })
  })

  describe('a steer that has not run when its run ends (the race)', () => {
    /** A parent turn held open; `release` lets it end (`fail`: with an error). */
    const heldTurn = async (outcome: 'completed' | 'failed', options: { executeNow?: boolean } = {}) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const w = await finished('All modules look fine.', undefined)
      w.steps['wait'] = async () => {
        await gate
        if (outcome === 'failed') throw new Error('provider error')
      }
      const turn = w.say('wait')
      turn.catch(() => undefined)
      await waitFor(() => w.d.engine.getActiveRun(w.parent.id) !== null, 'the parent turn to start')
      const run = w.d.engine.getActiveRun(w.parent.id)!
      // Not due for an hour unless asked: the test runs the executor itself, when it wants the steer to run.
      const steer = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: run.runId, kind: 'turn.steer', ...(options.executeNow ? {} : { availableAt: new Date(Date.now() + 3_600_000).toISOString() }), payload: { runId: run.runId, threadId: w.parent.id, text: 'x', inboxIds: [w.row.inboxId] } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], steer.effectId)
      return { ...w, run, steer, release: async () => { release(); await turn.catch(() => undefined) } }
    }
    const noticeTurns = (w: { adapter: { turns: Array<{ threadId: string; prompt: string }> }; parent: { id: string } }) =>
      w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.startsWith('Subagent'))

    it('the run ends first: the result is not lost, and is delivered once when the steer runs', async () => {
      const w = await heldTurn('completed')
      await w.release()
      await w.settled(w.run.runId)
      // The steer has not run: nothing was delivered, so the row and the task are as they were.
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: w.steer.effectId })
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('result_available')
      ;(w.d.orch as any).executeTurnSteerEffect(w.steer)
      await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the result to be delivered')
      expect(noticeTurns(w)).toHaveLength(1)
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
      w.reconciler.runOnce()
      expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toEqual([])
      expect(noticeTurns(w)).toHaveLength(1)
    })

    it('the model reads the steer: the rows are delivered to that run, and no follow-up turn is left', async () => {
      const w = await heldTurn('completed')
      ;(w.d.orch as any).executeTurnSteerEffect(w.steer)
      const session = w.d.orch.getOrCreateSession(w.parent.id)
      // The model's next request reads the steer.
      expect((w.d.orch as any).drainSteerForSession(session, session.activeTurn)).toContain('Subagent "API reviewer"')
      expect(w.d.engine.inbox.get(w.row.inboxId)!.payload).toMatchObject({ steerTakenBy: w.steer.effectId, noticeShown: true })
      await w.release()
      await w.settled(w.run.runId)
      await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the run to deliver')
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(noticeTurns(w)).toEqual([])
    })

    it.each(['completed', 'failed'] as const)('the live turn took the steer and ends %s without reading it: the follow-up turn it leaves carries the rows, and the notice arrives once', async (outcome) => {
      const w = await heldTurn(outcome)
      // The turn is live, so it takes the steer; the scripted adapter never reads steers.
      ;(w.d.orch as any).executeTurnSteerEffect(w.steer)
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: w.steer.effectId })
      await w.release()
      await w.settled(w.run.runId)
      // The row travels with the queued follow-up now: the reconciler must not hand it to a wake as well.
      await waitFor(() => noticeTurns(w).length === 1, 'the follow-up turn')
      await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the result to be read')
      w.reconciler.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(noticeTurns(w)).toHaveLength(1)
      expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toEqual([])
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
    })
  })

  describe('an unread steer when its run ends (recovery)', () => {
    const held = async (outcome: 'completed' | 'failed' = 'completed') => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const w = await finished('All modules look fine.', undefined)
      w.steps['wait'] = async () => {
        await gate
        if (outcome === 'failed') throw new Error('provider error')
      }
      const turn = w.say('wait')
      turn.catch(() => undefined)
      await waitFor(() => w.d.engine.getActiveRun(w.parent.id) !== null, 'the parent turn to start')
      const run = w.d.engine.getActiveRun(w.parent.id)!
      // Due now: the effect worker runs the steer, and the live turn takes it without reading it.
      const steer = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: run.runId, kind: 'turn.steer', payload: { runId: run.runId, threadId: w.parent.id, text: 'x', inboxIds: [w.row.inboxId] } })
      w.d.engine.inbox.markDelivered([w.row.inboxId], steer.effectId)
      await waitFor(() => w.d.engine.outbox.get(steer.effectId)?.status === 'succeeded', 'the steer to run')
      return { ...w, run, steer, finish: async () => { release(); await turn.catch(() => undefined); await w.settled(run.runId) } }
    }
    const noticeTurns = (w: { adapter: { turns: Array<{ threadId: string; prompt: string }> }; parent: { id: string } }) =>
      w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.startsWith('Subagent'))

    it('a crash after the run ended but before its follow-up was queued: the rows are delivered again after restart, once', async () => {
      const w = await held()
      // The run's terminal write comes first and the turn's settlement after it; the process dies in between.
      let statusAtSettlement = ''
      vi.spyOn(w.d.orch as any, 'settleActiveTurn').mockImplementation((session: any, turn: any) => {
        statusAtSettlement = w.d.engine.getRun(w.run.runId)!.status
        if (session.activeTurn === turn) session.activeTurn = null
      })
      await w.finish()
      expect(statusAtSettlement).toBe('completed')
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: w.steer.effectId })
      expect(noticeTurns(w)).toEqual([])
      // Boot: the steer was never read and its run is over, so nothing carries the rows; they are pending again.
      w.d.engine.store.db.transaction(() => recoverWakesOnBoot(w.d.engine.store, w.d.engine.outbox, new Date().toISOString()))
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
      const wakeRunId = w.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake')
      expect(noticeTurns(w)).toHaveLength(1)
      expect(w.d.engine.inbox.get(w.row.inboxId)!.status).toBe('acknowledged')
      expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
    })

    it('the follow-up turn cannot be queued: the rows go back to pending and rule 4 delivers them once', async () => {
      const w = await held()
      const original = (w.d.orch as any).enqueueForThread.bind(w.d.orch)
      vi.spyOn(w.d.orch as any, 'enqueueForThread').mockImplementation((threadId: string, input: unknown, opts: { source?: string }) => {
        if (opts?.source === 'steer-followup') throw new Error('queue unavailable')
        return original(threadId, input, opts)
      })
      await w.finish()
      expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
      const wakeRunId = w.reconciler.runOnce().wakes.wakes[0]
      await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake')
      expect(noticeTurns(w)).toHaveLength(1)
    })

    it('a user steer and a result steer, both unread when the turn ends, each arrive once', async () => {
      const w = await held()
      // The user steers the live turn too; the scripted adapter reads neither.
      expect(w.d.orch.steerThread(w.parent.id, 'also do X')).toBe(true)
      await w.finish()
      await waitFor(() => noticeTurns(w).length === 1 && w.adapter.turns.some((turn) => turn.threadId === w.parent.id && turn.prompt === 'also do X'), 'both follow-ups')
      await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the result to be read')
      w.reconciler.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(noticeTurns(w)).toHaveLength(1)
      expect(w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt === 'also do X')).toHaveLength(1)
      expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toEqual([])
    })
  })

  describe('a delivery that gives up', () => {
    it('is announced in the thread once, and the result stays readable', async () => {
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
      // The notice offers only what exists: reading the result.
      expect(notices[0].content).not.toMatch(/retry/i)
      expect((d.orch as any).taskStatus(parent.id, { delegationId: out.first.delegationId })).toMatchObject({ status: 'acknowledged', result: { runStatus: 'completed' } })
    })
  })

})
