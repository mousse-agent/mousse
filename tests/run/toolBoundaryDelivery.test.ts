import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { deliverAtToolBoundary, releaseToolBoundary } from '../../src/mms/run/delegation/wake'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

/** Boundary delivery (docs/plans/tool-api.md §2.2): a busy parent on an `interrupt_restart` runtime gets its notices with its next Mousse tool result. */
describe('deliverAtToolBoundary', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** A running parent with one finished child, whose result row is pending on the parent. */
  const withResult = async () => {
    f = delegationFixture()
    f.capabilities.set('parent', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const parent = await f.runningRun('parent')
    const child = await f.delegate(parent.runId, 'call-1')
    f.finish(child.childRunId, 'the module is fine')
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    return { fx: f, parent, child }
  }

  const deliver = (fx: DelegationFixture, runId: string, caps = CLAUDE_SUBSCRIPTION_CAPABILITIES) =>
    deliverAtToolBoundary(fx.store, fx.outbox, { threadId: 'parent', runId, caps, plan: (rows) => planWakeNotice(rows) })

  it('hands the pending result to the running parent once, under a turn.steer that is already done', async () => {
    const { fx, parent, child } = await withResult()
    const delivery = deliver(fx, parent.runId)
    expect(delivery).not.toBeNull()
    expect(delivery!.text).toContain('the module is fine')
    const [row] = fx.engine.inbox.listForDelegation(child.delegationId)
    expect(row).toMatchObject({ status: 'delivered', deliveredBy: delivery!.effectId })
    expect(fx.outbox.get(delivery!.effectId)).toMatchObject({ kind: 'turn.steer', status: 'succeeded', runId: parent.runId })
    expect(fx.engine.inbox.listDeliveredByRun(parent.runId).map((r) => r.inboxId)).toEqual([row.inboxId])
    // Nothing is left to hand over, and the reconciler neither wakes nor steers the busy parent.
    expect(deliver(fx, parent.runId)).toBeNull()
    expect(fx.reconciler.runOnce().wakes).toMatchObject({ wakes: [], steers: [] })
  })

  it('is acknowledged when the parent run completes, so no wake follows', async () => {
    const { fx, parent, child } = await withResult()
    deliver(fx, parent.runId)
    fx.finish(parent.runId, 'done')
    expect(fx.engine.inbox.listForDelegation(child.delegationId).map((row) => row.status)).toEqual(['acknowledged'])
    expect(fx.reconciler.runOnce().wakes.wakes).toEqual([])
  })

  it('goes back to pending when the parent run fails, and then wakes the parent', async () => {
    const { fx, parent, child } = await withResult()
    deliver(fx, parent.runId)
    fx.engine.markTerminal(parent.runId, 'failed', { error: 'provider crashed' })
    const report = fx.reconciler.runOnce().wakes
    expect(report.restored).toHaveLength(1)
    expect(report.wakes).toHaveLength(1)
    expect(fx.engine.inbox.listForDelegation(child.delegationId)[0].status).toBe('delivered')
  })

  it('a released delivery is pending again, read by nothing and not counted as a failed attempt', async () => {
    const { fx, parent, child } = await withResult()
    const [before] = fx.engine.inbox.listForDelegation(child.delegationId)
    const attempts = fx.engine.inbox.pendingCount(before.inboxId, 'parent')
    const delivery = deliver(fx, parent.runId)!
    expect(releaseToolBoundary(fx.store, delivery)).toHaveLength(1)
    const [row] = fx.engine.inbox.listForDelegation(child.delegationId)
    expect(row.status).toBe('pending')
    expect((row.payload as { steerTakenBy?: unknown }).steerTakenBy ?? null).toBeNull()
    expect(fx.engine.inbox.pendingCount(row.inboxId, 'parent')).toBe(attempts)
    expect(fx.engine.inbox.listDeliveredByRun(parent.runId)).toEqual([])
    // The next tool call carries it again.
    expect(deliver(fx, parent.runId)?.inboxIds).toEqual([row.inboxId])
  })

  it('leaves the rows pending for a runtime that steers natively, a run that is not the active one, and a run being stopped', async () => {
    const { fx, parent } = await withResult()
    expect(deliver(fx, parent.runId, PI_TEST_CAPABILITIES)).toBeNull()
    expect(deliver(fx, 'some-other-run')).toBeNull()
    await fx.engine.dispatch({ kind: 'stop', threadId: 'parent', runId: parent.runId, clientRequestId: 'stop-1' })
    expect(deliver(fx, parent.runId)).toBeNull()
    expect(fx.engine.inbox.listPending('parent')).toHaveLength(1)
  })

  it('takes nothing, as a native steer, while a pending result belongs to a task that waits for its parent to settle', async () => {
    f = delegationFixture()
    f.capabilities.set('parent', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const parent = await f.runningRun('parent')
    const settled = await f.delegate(parent.runId, 'call-s', { wake: 'settled_only' })
    f.finish(settled.childRunId, 'settled result')
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
    expect(deliver(f, parent.runId)).toBeNull()
    expect(f.engine.inbox.listPending('parent')).toHaveLength(1)
  })
})
