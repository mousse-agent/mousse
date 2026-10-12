import { afterEach, describe, expect, it } from 'vitest'
import type { WakeTurnPayload } from '../../src/mms/run/types'
import { delegationFixture, QUEUE_ONLY_CAPABILITIES, type DelegationFixture } from './delegationFixture'

describe('Reconciler rule 4: a child result wakes its parent (SPEC §14.3)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** A parent run that delegated once and then ended; the child finished. */
  const childFinished = async (options: { parentStaysActive?: boolean; wake?: 'always' | 'settled_only' } = {}) => {
    f = delegationFixture()
    const parent = await f.runningRun('parent')
    const accepted = await f.delegate(parent.runId, 'call-1', { wake: options.wake ?? 'always' })
    if (!options.parentStaysActive) f.engine.markTerminal(parent.runId, 'completed')
    f.finish(accepted.childRunId, 'All tests pass')
    return { f, parent, accepted }
  }

  it('idle parent: one wake run with a turn.start for every pending row; rows delivered', async () => {
    const { f, accepted } = await childFinished()
    const pending = f.engine.inbox.listPending('parent')
    expect(pending).toHaveLength(1)
    const report = f.reconciler.runOnce().wakes
    expect(report.wakes).toHaveLength(1)
    const wakeRun = f.engine.getRun(report.wakes[0])!
    expect(wakeRun).toMatchObject({ threadId: 'parent', status: 'queued', source: 'wake' })
    const effect = f.outbox.listForRun(wakeRun.runId)[0]
    expect(effect).toMatchObject({ kind: 'turn.start', status: 'pending' })
    expect(effect.payload as WakeTurnPayload).toEqual({ kind: 'wake', threadId: 'parent', runId: wakeRun.runId, inboxIds: [pending[0].inboxId] })
    expect(f.engine.inbox.get(pending[0].inboxId)!.status).toBe('delivered')
    expect(f.store.listEvents('parent').map((event) => event.type)).toContain('reconcile.wake')
    // Nothing pending any more: the next pass does nothing.
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [] })
    expect(accepted.replayed).toBe(false)
  })

  it('active native-steer parent: the notice is steered into the live run', async () => {
    const { f, parent, accepted } = await childFinished({ parentStaysActive: true })
    const report = f.reconciler.runOnce().wakes
    expect(report.wakes).toEqual([])
    expect(report.steers).toHaveLength(1)
    const steer = f.outbox.get(report.steers[0])!
    expect(steer).toMatchObject({ kind: 'turn.steer', runId: parent.runId, status: 'pending' })
    expect((steer.payload as { text: string }).text).toBe(
      `Delegated task ${accepted.delegationId} finished: All tests pass. Use task_status for the full result.`
    )
    expect(f.engine.inbox.listPending('parent')).toEqual([])
  })

  it('active parent without native steer: rows stay pending until the run ends', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true })
    f.capabilities.set('parent', QUEUE_ONLY_CAPABILITIES)
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [] })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    f.engine.markTerminal(parent.runId, 'completed')
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
  })

  it('settled_only delegations never steer a live run', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true, wake: 'settled_only' })
    expect(f.reconciler.runOnce().wakes.steers).toEqual([])
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    f.engine.markTerminal(parent.runId, 'completed')
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
  })

  it('all rows acknowledged before the wake starts: the wake effect is cancelled and its run cancelled', async () => {
    const { f, accepted } = await childFinished()
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    f.engine.acknowledgeDelegation(accepted.delegationId)
    // The acknowledgement cancels the wake at once; the reconciler finds nothing left to do.
    expect(f.engine.getRun(wakeRunId)!.status).toBe('cancelled')
    expect(f.outbox.listForRun(wakeRunId)[0].status).toBe('cancelled')
    expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('acknowledged')
    expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['acknowledged'])
    expect(f.store.listEvents('parent').map((event) => event.type)).toContain('reconcile.wake_cancelled')
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [] })
  })

  it('the reconciler cancels a wake whose rows were acknowledged by another writer', async () => {
    const { f } = await childFinished()
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    f.engine.inbox.markAcknowledged(f.engine.inbox.listByStatus('parent', 'delivered').map((row) => row.inboxId))
    expect(f.reconciler.runOnce().wakes.cancelled).toEqual([wakeRunId])
    expect(f.engine.getRun(wakeRunId)!.status).toBe('cancelled')
  })

  it('a second result while a wake is waiting stays pending for the next wake', async () => {
    const { f, accepted } = await childFinished()
    f.reconciler.runOnce()
    f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'later' } })
    expect(f.reconciler.runOnce().wakes.wakes).toEqual([])
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    expect(accepted.delegationId).toBeTruthy()
  })
})
