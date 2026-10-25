/**
 * Issue #142: a queued result notice that runs without a `turn.start` effect (recording the effect
 * failed) settles its rows by what its run ended as, never by the shape of the response: a turn
 * that lost the execution lease to a peer put the item back, an interrupted turn consumed nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkerStoppedError } from '../../src/mms/run/EffectWorker'
import { waitFor } from './phase6Fixture'
import { useSubagentWorld } from './subagentWorld'

// A peer that wins the execution lease race: the next `tryAcquireExecutionLease` finds it taken.
const lease = vi.hoisted(() => ({ lose: 0, lost: 0 }))
vi.mock('../../src/mms/queue/ThreadExecutionLease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mms/queue/ThreadExecutionLease')>()
  return {
    ...actual,
    tryAcquireExecutionLease: (...args: Parameters<typeof actual.tryAcquireExecutionLease>) => {
      if (lease.lose > 0) {
        lease.lose -= 1
        lease.lost += 1
        return null
      }
      return actual.tryAcquireExecutionLease(...args)
    }
  }
})

describe('a queued result that runs directly (issue #142)', () => {
  const world = useSubagentWorld()

  /** A finished subagent whose result sits in a queue item (owner `queue:<id>`), ready to drain directly. */
  const queued = async (parentReply?: Parameters<typeof world>[1]) => {
    lease.lose = 0
    lease.lost = 0
    const w = world(() => 'All modules look fine.', parentReply)
    w.steps['go'] = async (tools) => { w.out.first = await w.start(tools, 'API reviewer') }
    await w.say('go')
    await w.settled(w.out.first.childRunId)
    const [row] = w.d.engine.inbox.listPending(w.parent.id)
    const run = w.d.engine.listRuns(w.parent.id)[0]
    const effect = w.d.engine.outbox.enqueue({ threadId: w.parent.id, runId: run.runId, kind: 'turn.steer', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: run.runId, threadId: w.parent.id, text: 'x', inboxIds: [row.inboxId] } })
    w.d.engine.inbox.markDelivered([row.inboxId], effect.effectId)
    const session = w.d.orch.getOrCreateSession(w.parent.id)
    session.turnAdmitted = true
    ;(w.d.orch as any).enqueueLateSteer(w.parent.id, 'x', { inboxIds: [row.inboxId], effectId: effect.effectId })
    // The steer is spent (its rows belong to the item); a pending one would hold up the control lane.
    w.d.engine.outbox.cancel(effect.effectId, new Date().toISOString(), 'test')
    // Recording the turn's effect fails, so the item runs directly.
    vi.spyOn(w.d.orch as any, 'enqueueTurnStart').mockImplementation(() => { throw new Error('outbox unavailable') })
    session.turnAdmitted = false
    const drain = () => (w.d.orch as any).scheduleQueueDrain(session)
    const noticeTurns = () => w.adapter.turns.filter((turn) => turn.threadId === w.parent.id && turn.prompt.startsWith('Subagent'))
    return { ...w, row, session, drain, noticeTurns }
  }

  it('a turn that loses the lease race leaves the rows with its item, which delivers them once when it drains again', async () => {
    const w = await queued()
    const recorded = vi.spyOn(w.d.engine.inbox, 'recordNoticeVisibility')
    lease.lose = 1
    w.drain()
    await waitFor(() => lease.lost === 1, 'the lease to be lost')
    // Nothing was consumed: the rows are not read, and they are still the item's.
    await waitFor(() => w.noticeTurns().length === 1, 'the item to drain again and deliver')
    await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'acknowledged', 'the rows to be read')
    expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('acknowledged')
    // What the notice showed was recorded again when the item drained again.
    expect(recorded.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(w.d.engine.inbox.get(w.row.inboxId)!.payload).toMatchObject({ noticeShown: true })
    w.reconciler.runOnce()
    expect(w.noticeTurns()).toHaveLength(1)
    expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toEqual([])
  })

  /** The direct turn is held open until `release`; `stop` aborts it. */
  const heldDirect = async (stop: 'user' | 'shutdown') => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const w = await queued(async (input) => {
      if (input.prompt.startsWith('Subagent')) await gate
      return 'Parent done.'
    })
    w.drain()
    await waitFor(() => w.noticeTurns().length === 1, 'the direct turn to start')
    const run = w.d.engine.getActiveRun(w.parent.id)!
    if (stop === 'user') await w.d.orch.abortRun(run.runId, 'stop-1', w.parent.id)
    else w.session.activeTurn!.abort.abort(new WorkerStoppedError())
    await waitFor(() => w.session.activeTurn?.abort.signal.aborted === true, 'the turn to be aborted')
    release()
    await waitFor(() => w.d.engine.getRun(run.runId)?.status === 'interrupted', 'the run to end')
    return { ...w, run }
  }

  it('a turn the user stopped has its rows acknowledged by the Stop: no redelivery behind a Stop, not even at boot, and the result stays readable', async () => {
    const w = await heldDirect('user')
    expect(w.d.engine.getRun(w.run.runId)!.outcome?.interruptedBy).toBe('user')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A Stop acknowledges the inbox rows of the thread it stops (`RunEngine.stopSubtree`); the task keeps its result.
    expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'acknowledged' })
    expect(w.d.engine.delegations.get(w.out.first.delegationId)!.status).toBe('result_available')
    ;(w.d.orch as any).recoverQueuedRows()
    w.reconciler.runOnce()
    expect(w.d.engine.inbox.get(w.row.inboxId)).toMatchObject({ status: 'acknowledged' })
    expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toEqual([])
    expect(w.noticeTurns()).toHaveLength(1)
  })

  it('a turn cut off by a shutdown gives the rows back, and rule 4 delivers them once', async () => {
    const w = await heldDirect('shutdown')
    expect(w.d.engine.getRun(w.run.runId)!.outcome?.interruptedBy).toBe('daemon_restart')
    await waitFor(() => w.d.engine.inbox.get(w.row.inboxId)!.status === 'pending', 'the rows to be given back')
    const wakeRunId = w.reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => w.d.engine.getRun(wakeRunId)?.status === 'completed', 'the wake')
    expect(w.d.engine.inbox.get(w.row.inboxId)!.status).toBe('acknowledged')
    expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toHaveLength(1)
    w.reconciler.runOnce()
    expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'wake')).toHaveLength(1)
  })
})
