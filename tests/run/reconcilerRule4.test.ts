import { afterEach, describe, expect, it } from 'vitest'
import { ANTIGRAVITY_CAPABILITIES } from '../../src/mms/run/adapters/antigravity/AntigravityAdapter'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { NOTICE_TASK_CHARS } from '../../src/mms/run/delegation/notice'
import { redeliveryDelayMs, retryUndeliverable } from '../../src/mms/run/delegation/wake'
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
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [], restored: [] })
    expect(accepted.replayed).toBe(false)
  })

  it('active native-steer parent: the notice is steered into the live run', async () => {
    const { f, parent, accepted } = await childFinished({ parentStaysActive: true })
    const report = f.reconciler.runOnce().wakes
    expect(report.wakes).toEqual([])
    expect(report.steers).toHaveLength(1)
    const steer = f.outbox.get(report.steers[0])!
    expect(steer).toMatchObject({ kind: 'turn.steer', runId: parent.runId, status: 'pending' })
    expect((steer.payload as { text: string; inboxIds: string[] }).text).toBe(
      `Subagent thread ${accepted.childThreadId} finished task ${accepted.delegationId}.\nAll tests pass\nFull result above.`
    )
    // The steer carries the identity of the rows it delivers, so the executor can rebuild or skip it.
    expect((steer.payload as { inboxIds: string[] }).inboxIds).toHaveLength(1)
    expect(f.engine.inbox.listPending('parent')).toEqual([])
  })

  it('active parent without native steer: rows stay pending until the run ends', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true })
    f.capabilities.set('parent', QUEUE_ONLY_CAPABILITIES)
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [], restored: [] })
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    f.engine.markTerminal(parent.runId, 'completed')
    expect(f.reconciler.runOnce().wakes.wakes).toHaveLength(1)
  })

  it('active pi-loop parent: a notice row is steered into the live run', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true })
    f.capabilities.set('parent', PI_LOOP_CAPABILITIES)
    f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'heads up' } })
    const report = f.reconciler.runOnce().wakes
    expect(report.wakes).toEqual([])
    expect(report.steers).toHaveLength(1)
    expect(f.outbox.get(report.steers[0])).toMatchObject({ kind: 'turn.steer', runId: parent.runId })
    expect(f.engine.inbox.listPending('parent')).toEqual([])
  })

  for (const [name, caps] of [
    ['Claude Subscription', CLAUDE_SUBSCRIPTION_CAPABILITIES],
    ['Antigravity', ANTIGRAVITY_CAPABILITIES]
  ] as const) {
    it(`active ${name} parent (interrupt_restart): no steer cuts the turn; rows wait for a wake run`, async () => {
      // wake: 'always' result plus a notice row: neither may interrupt the live turn.
      const { f, parent } = await childFinished({ parentStaysActive: true, wake: 'always' })
      f.capabilities.set('parent', caps)
      f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'heads up' } })
      for (let pass = 0; pass < 2; pass++)
        expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [], restored: [] })
      expect(f.outbox.listForThread('parent').filter((effect) => effect.kind === 'turn.steer')).toEqual([])
      expect(f.engine.inbox.listPending('parent')).toHaveLength(2)
      f.engine.markTerminal(parent.runId, 'completed')
      const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
      expect(f.engine.getRun(wakeRunId)).toMatchObject({ threadId: 'parent', status: 'queued', source: 'wake' })
      const payload = f.outbox.listForRun(wakeRunId)[0].payload as WakeTurnPayload
      expect(payload.inboxIds).toHaveLength(2)
      expect(f.engine.inbox.listPending('parent')).toEqual([])
    })
  }

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
    expect(f.reconciler.runOnce().wakes).toEqual({ wakes: [], steers: [], cancelled: [], restored: [] })
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

  it('a queued wake whose effect is claimed or deferred keeps rule 4 from creating another (C4)', async () => {
    const { f } = await childFinished()
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    let claimed = f.outbox.claimNext('1:1', f.now())!
    // The child's own turn.start (its run already ended in this fixture) comes first in the queue.
    while (claimed.runId !== wakeRunId) {
      f.outbox.succeed(claimed.effectId, '1:1', f.now())
      claimed = f.outbox.claimNext('1:1', f.now())!
    }
    // The executor found the thread busy and deferred it: the wake stays queued, its rows delivered.
    f.outbox.defer(claimed.effectId, '1:1', f.now(), new Date(Date.parse(f.now()) + 5000).toISOString(), 'thread_busy')
    f.engine.inbox.append({ threadId: 'parent', kind: 'reconcile_notice', payload: { text: 'more' } })
    for (let pass = 0; pass < 3; pass++) expect(f.reconciler.runOnce().wakes.wakes).toEqual([])
    expect(f.engine.listRuns('parent').filter((run) => run.source === 'wake')).toHaveLength(1)
  })

  it('a steer that failed returns its rows to pending, and they are delivered again (H3)', async () => {
    const { f } = await childFinished({ parentStaysActive: true })
    const steerId = f.reconciler.runOnce().wakes.steers[0]
    const [row] = f.engine.inbox.listByStatus('parent', 'delivered')
    expect(row.deliveredBy).toBe(steerId)
    f.outbox.claimNext('1:1', f.now(), { lanes: ['control'] })
    f.outbox.fail(steerId, '1:1', f.now(), 'turn ended')
    expect(f.outbox.get(steerId)!.status).toBe('failed')
    const report = f.reconciler.runOnce().wakes
    expect(report.restored).toEqual([row.inboxId])
    // Still active and steerable: the restored row is steered again in the same pass.
    expect(report.steers).toHaveLength(1)
    expect(f.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: report.steers[0] })
  })

  it('boot returns rows a cut-off steer or wake delivered; a wake the user stopped keeps them (H3)', async () => {
    const home = (await childFinished({ parentStaysActive: true })).f.profileHome
    const steerId = f!.reconciler.runOnce().wakes.steers[0]
    const [row] = f!.engine.inbox.listByStatus('parent', 'delivered')
    expect(row.deliveredBy).toBe(steerId)
    // The daemon dies before the steer runs: boot cancels the process-bound steer…
    f!.dispose(true)
    f = delegationFixture({ profileHome: home, pid: 2 })
    f.engine.reconcileOnBoot()
    expect(f.outbox.get(steerId)!.status).toBe('cancelled')
    // …and its row is pending again for rule 4.
    expect(f.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })

    // A wake the user stopped mid-turn does not come back; one cut off by a restart does.
    const parentRun = f.engine.listRuns('parent').find((run) => run.status === 'interrupted')
    expect(parentRun).toBeTruthy()
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    f.engine.markStarting(wakeRunId)
    f.engine.markRunning(wakeRunId)
    f.engine.markTerminal(wakeRunId, 'interrupted', { interruptedBy: 'user' })
    expect(f.reconciler.runOnce().wakes.restored).toEqual([])
    expect(f.engine.inbox.get(row.inboxId)!.status).toBe('delivered')
  })

  /** Time passes while the parent run stays alive, so rule 2 leaves it be. */
  const tick = (f: DelegationFixture, runId: string, ms: number) => {
    f.advance(ms)
    f.engine.heartbeat(runId)
  }

  /** Cancels the row's delivering steer, as a delivery that did not happen, and waits out any backoff. */
  const failSteers = (f: DelegationFixture, runId: string, passes: number) => {
    for (let attempt = 0; attempt < passes; attempt++) {
      const steerId = f.reconciler.runOnce().wakes.steers[0]
      if (!steerId) break
      f.outbox.cancel(steerId, f.now(), 'test')
      tick(f, runId, 60_000)
    }
    f.reconciler.runOnce()
  }

  it('a row returns at most MAX_INBOX_REDELIVERIES times, then its delivery is flagged as failed', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true })
    const [row] = f.engine.inbox.listPending('parent')
    failSteers(f, parent.runId, 6)
    const given = f.engine.inbox.get(row.inboxId)!
    expect(given.status).toBe('delivered')
    expect(given.payload).toMatchObject({ deliveryFailed: true, attempts: 4 })
    expect(f.outbox.listForThread('parent').filter((effect) => effect.kind === 'turn.steer')).toHaveLength(4)
    // The owner hears of it once, however many passes follow.
    f.reconciler.runOnce()
    const events = f.store.listEvents('parent').filter((event) => event.type === 'reconcile.delivery_failed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ inboxId: row.inboxId, attempts: 4 })
  })

  it('later redeliveries back off, and retrying a failed delivery gives the row a fresh set of attempts', async () => {
    const { f, parent } = await childFinished({ parentStaysActive: true })
    const [row] = f.engine.inbox.listPending('parent')
    // The first redelivery is immediate; the second waits.
    f.outbox.cancel(f.reconciler.runOnce().wakes.steers[0], f.now(), 'test')
    f.outbox.cancel(f.reconciler.runOnce().wakes.steers[0], f.now(), 'test')
    expect(f.reconciler.runOnce().wakes).toMatchObject({ restored: [], steers: [] })
    tick(f, parent.runId, redeliveryDelayMs(2) - 1)
    expect(f.reconciler.runOnce().wakes.restored).toEqual([])
    tick(f, parent.runId, 1)
    const third = f.reconciler.runOnce().wakes
    expect(third).toMatchObject({ restored: [row.inboxId], steers: [expect.any(String)] })

    f.outbox.cancel(third.steers[0], f.now(), 'test')
    tick(f, parent.runId, 60_000)
    failSteers(f, parent.runId, 6)
    expect(f.engine.inbox.get(row.inboxId)!.payload).toMatchObject({ deliveryFailed: true })
    expect(retryUndeliverable(f.store, 'parent')).toEqual([row.inboxId])
    expect(f.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'pending', deliveredBy: null })
    expect(f.engine.inbox.get(row.inboxId)!.payload).not.toHaveProperty('deliveryFailed')
    // A fresh set: the row is delivered again, and again after one more failure.
    const again = f.reconciler.runOnce().wakes.steers[0]
    expect(again).toBeTruthy()
    f.outbox.cancel(again, f.now(), 'test')
    expect(f.reconciler.runOnce().wakes.restored).toEqual([row.inboxId])
  })

  describe('acknowledge on delivery', () => {
    /** A parent whose child finished; its wake run is started and returned. */
    const wakeStarted = async (text = 'All tests pass') => {
      f = delegationFixture()
      const parent = await f.runningRun('parent')
      const accepted = await f.delegate(parent.runId, 'call-1')
      f.engine.markTerminal(parent.runId, 'completed')
      f.finish(accepted.childRunId, text)
      const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
      f.engine.markStarting(wakeRunId)
      f.engine.markRunning(wakeRunId)
      return { f, accepted, wakeRunId }
    }

    it('a completed wake run acknowledges its rows and the task whose result it showed whole', async () => {
      const { f, accepted, wakeRunId } = await wakeStarted()
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['delivered'])
      f.engine.markTerminal(wakeRunId, 'completed')
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['acknowledged'])
      expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('acknowledged')
    })

    it('a result the notice cut stays unread: the rows are acknowledged, the task is not', async () => {
      const { f, accepted, wakeRunId } = await wakeStarted('r'.repeat(NOTICE_TASK_CHARS + 1))
      f.engine.markTerminal(wakeRunId, 'completed')
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['acknowledged'])
      expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('result_available')
      // Reading the rest still works and settles it.
      expect(f.engine.acknowledgeDelegation(accepted.delegationId).status).toBe('acknowledged')
    })

    it('a wake run that failed acknowledges nothing: its rows come back to pending', async () => {
      const { f, accepted, wakeRunId } = await wakeStarted()
      f.engine.markTerminal(wakeRunId, 'failed', { error: 'provider error' })
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['delivered'])
      expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('result_available')
      expect(f.reconciler.runOnce().wakes.restored).toHaveLength(1)
    })

    it('a steered run that completes acknowledges the rows its steer delivered', async () => {
      const { f, parent, accepted } = await childFinished({ parentStaysActive: true })
      f.reconciler.runOnce()
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['delivered'])
      f.engine.markTerminal(parent.runId, 'completed')
      expect(f.engine.inbox.listForThread('parent').map((row) => row.status)).toEqual(['acknowledged'])
      expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('acknowledged')
    })

    it('a steered run that failed returns the rows it delivered', async () => {
      const { f, parent } = await childFinished({ parentStaysActive: true })
      f.reconciler.runOnce()
      f.engine.markTerminal(parent.runId, 'failed', { error: 'boom' })
      expect(f.reconciler.runOnce().wakes.restored).toHaveLength(1)
    })

    it('rows a queued steer delivers follow the run that carries them', async () => {
      const { f, parent } = await childFinished({ parentStaysActive: true })
      expect(f.reconciler.runOnce().wakes.steers).toHaveLength(1)
      const [row] = f.engine.inbox.listByStatus('parent', 'delivered')
      // The steer missed its turn and became its own run, whose turn.start now carries the row.
      const late = await f.engine.dispatch({ kind: 'send', threadId: 'parent', clientRequestId: 'late', source: 'steer-late' })
      if (late.status !== 'accepted') throw new Error('send rejected')
      const effect = f.outbox.enqueue({ threadId: 'parent', runId: late.runId, kind: 'turn.start', payload: { runId: late.runId, threadId: 'parent', input: 'notice' } })
      f.engine.inbox.redirectDelivery([row.inboxId], effect.effectId)
      expect(f.engine.inbox.get(row.inboxId)).toMatchObject({ status: 'delivered', deliveredBy: effect.effectId })
      // The steered run's end does not acknowledge a notice it no longer carries.
      f.engine.markTerminal(parent.runId, 'completed')
      expect(f.engine.inbox.get(row.inboxId)!.status).toBe('delivered')
      f.engine.markStarting(late.runId)
      f.engine.markRunning(late.runId)
      f.engine.markTerminal(late.runId, 'completed')
      expect(f.engine.inbox.get(row.inboxId)!.status).toBe('acknowledged')
    })
  })

  it('task_status inside its own transaction cancels a fully acknowledged wake and commits (M3)', async () => {
    const { f, accepted } = await childFinished()
    const wakeRunId = f.reconciler.runOnce().wakes.wakes[0]
    // The wake's run already ended elsewhere while its effect is still pending.
    const other = f.engine.getRun(wakeRunId)!
    f.store.casRunStatus({ runId: other.runId, expectedEpoch: other.epoch, status: 'cancelled', patch: { completedAt: f.now() } })
    expect(() => f.engine.acknowledgeDelegation(accepted.delegationId)).not.toThrow()
    expect(f.engine.delegations.get(accepted.delegationId)!.status).toBe('acknowledged')
    expect(f.outbox.listForRun(wakeRunId)[0].status).toBe('cancelled')
    expect(f.store.listEvents('parent').map((event) => event.type)).toContain('reconcile.wake_cancelled')
  })
})
