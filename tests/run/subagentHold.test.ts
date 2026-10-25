/**
 * Issue #142, nested results: a delegation P -> C stays `running` after C's run ended for as long as
 * C is busy, and publishes once, from C's latest conversational run, when it is not. The predicate
 * (`childBusy`), the one publishing function (`settleWaitingDelegations`) and every trigger that
 * re-evaluates it, driven on the real engine, outbox and reconciler over a fake clock. The same rule
 * through a real orchestrator and scripted providers is `subagentHoldIntegration.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { childBusy, NO_FINAL_MESSAGE, settleWaitingDelegations } from '../../src/mms/run/delegation/hold'
import { MAX_INBOX_REDELIVERIES } from '../../src/mms/run/delegation/wake'
import { EFFECT_LEASE_GRACE_MS } from '../../src/mms/run/EffectOutbox'
import { EFFECT_KIND_SPEC, type ChildResultPayload } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const OWNER = '1:1'

describe('a subagent\'s result waits for its own subagents (issue #142)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** P (idle) -> C (its run just ended, text 'C started G') -> G (running); the tasks are P->C and C->G. */
  const nested = async () => {
    f = delegationFixture()
    const parentRun = await f.runningRun('parent')
    const pc = await f.delegate(parentRun.runId, 'pc')
    f.engine.markStarting(pc.childRunId)
    f.engine.markRunning(pc.childRunId)
    const cg = await f.delegate(pc.childRunId, 'cg')
    f.engine.markTerminal(parentRun.runId, 'completed')
    f.finish(pc.childRunId, 'C started G')
    // C's first `turn.start` never runs in this fixture; it would block C's wake effect in the thread's lane.
    for (const effect of f.outbox.listForThread(pc.childThreadId)) f.outbox.cancel(effect.effectId, f.now(), 'test')
    return { f, parentRun, pc, cg }
  }

  const task = (id: string) => f!.engine.delegations.get(id)!
  const parentRows = () => f!.engine.inbox.listForThread('parent').filter((row) => row.kind === 'child_result')
  /** The wake run rule 4 made for `threadId`, started the way the executor starts it. */
  const wakeRunning = (threadId: string) => {
    const wakeRunId = f!.reconciler.runOnce().wakes.wakes.find((id) => f!.engine.getRun(id)!.threadId === threadId)!
    expect(wakeRunId).toBeTruthy()
    f!.engine.markStarting(wakeRunId)
    f!.engine.markRunning(wakeRunId)
    return wakeRunId
  }
  const wakeEffect = (runId: string) => f!.outbox.listForRun(runId).find((effect) => effect.kind === 'turn.start')!
  /** Claims `effectId` for the executor: the child runs' own start effects never run here and would be claimed first. */
  const claim = (threadId: string) => {
    for (const effect of f!.outbox.listPending()) {
      if (effect.threadId !== threadId && effect.kind === 'turn.start' && (effect.payload as { kind?: string })?.kind !== 'wake') f!.outbox.cancel(effect.effectId, f!.now(), 'test')
    }
    return f!.outbox.claimNext(OWNER, f!.now(), { lanes: ['turn'] })
  }
  /** Puts P -> C back to `running` as if C's end had been held, to read what settling does with the state `arrange` leaves. */
  const holdBy = async (arrange: (x: DelegationFixture, threadId: string) => void) => {
    f = delegationFixture()
    let background = true
    f.store.setProviderBackgroundWork(() => background)
    const parentRun = await f.runningRun('parent')
    const pc = await f.delegate(parentRun.runId, 'pc')
    f.finish(pc.childRunId, 'result')
    expect(task(pc.delegationId).status).toBe('running')
    background = false
    arrange(f, pc.childThreadId)
    return pc
  }

  describe('two-level nesting P -> C -> G', () => {
    it('C\'s result publishes only after G\'s result was consumed by a run of C that committed', async () => {
      const { pc, cg } = await nested()
      // C ended its turn while G runs: nothing is published, the parent hears nothing.
      expect(task(pc.delegationId).status).toBe('running')
      expect(parentRows()).toEqual([])
      expect(f!.reconciler.runOnce().wakes.wakes).toEqual([])

      // G finishes: its result is C's to read, so C is still busy and P still waits.
      f!.finish(cg.childRunId, 'G result')
      expect(task(cg.delegationId).status).toBe('result_available')
      expect(task(pc.delegationId).status).toBe('running')
      expect(parentRows()).toEqual([])

      // C is woken for it; the wake run ends with C's final text, but its wake effect is still in flight.
      const wakeRunId = wakeRunning(pc.childThreadId)
      f!.engine.markTerminal(wakeRunId, 'completed', undefined, { resultText: 'C final' })
      expect(f!.engine.inbox.listForThread(pc.childThreadId).map((row) => row.status)).toEqual(['acknowledged'])
      expect(task(pc.delegationId).status).toBe('running')

      // The wake effect settles: now nothing keeps C busy, and P's task publishes once, with C's last words.
      f!.outbox.cancel(wakeEffect(wakeRunId).effectId, f!.now(), 'settled')
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'C final', runId: wakeRunId } })
      expect(parentRows()).toHaveLength(1)
      expect((parentRows()[0].payload as ChildResultPayload).result.text).toBe('C final')
      // And once: further passes change nothing, and the parent is woken for it once.
      f!.reconciler.runOnce()
      f!.engine.settleAllWaitingDelegations()
      expect(parentRows()).toHaveLength(1)
      expect(f!.engine.listRuns('parent').filter((run) => run.source === 'wake')).toHaveLength(1)
    })

    it('G cancelled while C is idle: C has nothing left to read, so P hears C\'s last words', async () => {
      const { pc, cg } = await nested()
      await f!.engine.cancelDelegation(cg.delegationId)
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'C started G' } })
    })

    it('G failing is a notice C must read first', async () => {
      const { pc, cg } = await nested()
      f!.engine.markStarting(cg.childRunId)
      f!.engine.markTerminal(cg.childRunId, 'failed', { error: 'boom' })
      expect(task(pc.delegationId).status).toBe('running')
      expect(f!.engine.inbox.listByStatus(pc.childThreadId, 'pending')).toHaveLength(1)
    })

    it('a task that was never held publishes in the terminal write, exactly as before', async () => {
      f = delegationFixture()
      const parentRun = await f.runningRun('parent')
      const pc = await f.delegate(parentRun.runId, 'pc')
      f.finish(pc.childRunId, 'plain result')
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'plain result', runId: pc.childRunId } })
      expect(parentRows()).toHaveLength(1)
    })

    it('two tasks into C (a continuation while held) publish together with the same latest result', async () => {
      const { parentRun, pc, cg } = await nested()
      // A person's message in C's thread while it waits is a task of its own.
      const sent = await f!.engine.dispatch({ kind: 'send', threadId: pc.childThreadId, clientRequestId: 'follow-up', source: 'gui', prompt: 'and also this' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const second = f!.engine.delegations.getByChildRun(sent.runId)!
      expect(second.parentRunId).toBe(parentRun.runId)
      f!.engine.markStarting(sent.runId)
      f!.engine.markRunning(sent.runId)
      f!.engine.markTerminal(sent.runId, 'completed', undefined, { resultText: 'follow-up answer' })
      expect([task(pc.delegationId).status, task(second.delegationId).status]).toEqual(['running', 'running'])
      f!.finish(cg.childRunId, 'G result')
      const wakeRunId = wakeRunning(pc.childThreadId)
      f!.engine.markTerminal(wakeRunId, 'completed', undefined, { resultText: 'both done' })
      f!.outbox.cancel(wakeEffect(wakeRunId).effectId, f!.now(), 'settled')
      for (const id of [pc.delegationId, second.delegationId])
        expect(task(id)).toMatchObject({ status: 'result_available', result: { text: 'both done', runId: wakeRunId } })
      expect(parentRows()).toHaveLength(2)
    })
  })

  describe('what keeps a child busy', () => {
    it.each([
      ['a queued run of C', (x: DelegationFixture, threadId: string) => { x.store.createRun({ threadId, source: 'gui' }) }, true],
      ['a running run of C', (x: DelegationFixture, threadId: string) => { const run = x.store.createRun({ threadId, source: 'gui' }); x.engine.markStarting(run.runId); x.engine.markRunning(run.runId) }, true],
      ['a pending inbox row', (x: DelegationFixture, threadId: string) => { x.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text: 'n' } }) }, true],
      ['a delivered inbox row', (x: DelegationFixture, threadId: string) => { const row = x.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text: 'n' } }); x.engine.inbox.markDelivered([row.inboxId], 'effect:nowhere') }, true],
      ['a delivered row a queue item owns', (x: DelegationFixture, threadId: string) => { const row = x.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text: 'n' } }); x.engine.inbox.markDelivered([row.inboxId], 'queue:item-1') }, true],
      ['an acknowledged inbox row', (x: DelegationFixture, threadId: string) => { const row = x.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text: 'n' } }); x.engine.inbox.markAcknowledged([row.inboxId]) }, false],
      ['an exhausted delivered row', (x: DelegationFixture, threadId: string) => { const row = x.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text: 'n' } }); x.engine.inbox.markDelivered([row.inboxId], 'effect:nowhere'); x.engine.inbox.patchPayload(row.inboxId, { deliveryFailed: true, attempts: 4, lastError: 'x' }) }, false],
      ['a pending wake effect', (x: DelegationFixture, threadId: string) => { x.outbox.enqueue({ threadId, kind: 'turn.start', payload: { kind: 'wake', threadId, runId: 'r', inboxIds: [] } }) }, true],
      ['a pending steer effect', (x: DelegationFixture, threadId: string) => { x.outbox.enqueue({ threadId, kind: 'turn.steer', payload: { runId: 'r', threadId, text: 't' } }) }, true],
      ['a pending effect that is not a delivery', (x: DelegationFixture, threadId: string) => { x.outbox.enqueue({ threadId, kind: 'turn.interrupt', payload: { runId: 'r', threadId } }) }, false],
      ['a cancelled wake effect', (x: DelegationFixture, threadId: string) => { const e = x.outbox.enqueue({ threadId, kind: 'turn.start', payload: { kind: 'wake', threadId, runId: 'r', inboxIds: [] } }); x.outbox.cancel(e.effectId, x.now(), 'done') }, false],
      ['nothing', () => undefined, false]
    ])('%s: the task is held: %s', async (_name, arrange, held) => {
      const pc = await holdBy(arrange)
      expect(childBusy(f!.store, pc.childThreadId)).toBe(held)
      f!.engine.settleAllWaitingDelegations()
      expect(task(pc.delegationId).status === 'running').toBe(held)
    })

    it('an outbound delegation of C that is still running holds it, and leaving running releases it', async () => {
      const { pc, cg } = await nested()
      expect(childBusy(f!.store, pc.childThreadId)).toBe(true)
      await f!.engine.cancelDelegation(cg.delegationId)
      expect(childBusy(f!.store, pc.childThreadId)).toBe(false)
    })

    it('provider background work (input 4) holds the task until the host says it ended', async () => {
      f = delegationFixture()
      let background = true
      f.store.setProviderBackgroundWork(() => background)
      const parentRun = await f.runningRun('parent')
      const pc = await f.delegate(parentRun.runId, 'pc')
      f.finish(pc.childRunId, 'turn text')
      expect(task(pc.delegationId).status).toBe('running')
      expect(childBusy(f.store, pc.childThreadId)).toBe(true)
      background = false
      f.store.settleHold(pc.childThreadId)
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'turn text' } })
    })

    it('a provider callback that throws is no background work', async () => {
      f = delegationFixture()
      f.store.setProviderBackgroundWork(() => { throw new Error('adapter exploded') })
      const parentRun = await f.runningRun('parent')
      const pc = await f.delegate(parentRun.runId, 'pc')
      f.finish(pc.childRunId, 'turn text')
      expect(task(pc.delegationId).status).toBe('result_available')
    })
  })

  describe('which run\'s result a task publishes', () => {
    const run = (x: DelegationFixture, threadId: string, source: string, end: (id: string) => void, started = true) => {
      const created = x.store.createRun({ threadId, source, clientRequestId: `${source}:${Math.random()}` })
      if (started) {
        x.engine.markStarting(created.runId)
        x.engine.markRunning(created.runId)
      }
      end(created.runId)
      return created.runId
    }
    /** C's first run completed with 'result' (see `holdBy`); then `later` happens, and the task publishes. */
    const publishedAfter = async (later: (x: DelegationFixture, threadId: string) => void) => {
      const pc = await holdBy((x, threadId) => {
        x.store.setProviderBackgroundWork(() => true)
        later(x, threadId)
        x.store.setProviderBackgroundWork(() => false)
      })
      f!.store.settleHold(pc.childThreadId)
      return task(pc.delegationId)
    }

    it('a wake that failed without text, after an earlier success: failed, with its error', async () => {
      const published = await publishedAfter((x, threadId) => run(x, threadId, 'wake', (id) => x.engine.markTerminal(id, 'failed', { error: 'provider unavailable' })))
      expect(published).toMatchObject({ status: 'failed', result: { runStatus: 'failed', error: 'provider unavailable' } })
      expect(published.result!.text).toBeUndefined()
    })

    it('a continuation that failed: failed', async () => {
      const published = await publishedAfter((x, threadId) => run(x, threadId, 'provider-continuation', (id) => x.engine.markTerminal(id, 'failed', { error: 'continuation died' })))
      expect(published).toMatchObject({ status: 'failed', result: { error: 'continuation died' } })
    })

    it('a wake that completed without text: the fallback message, not the earlier text', async () => {
      const published = await publishedAfter((x, threadId) => run(x, threadId, 'wake', (id) => x.engine.markTerminal(id, 'completed')))
      expect(published).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: NO_FINAL_MESSAGE } })
    })

    it('a person\'s later turn is the result', async () => {
      const published = await publishedAfter((x, threadId) => run(x, threadId, 'gui', (id) => x.engine.markTerminal(id, 'completed', undefined, { resultText: 'asked later' })))
      expect(published.result).toMatchObject({ text: 'asked later' })
    })

    it('an integration run or a local action is never the result', async () => {
      const published = await publishedAfter((x, threadId) => {
        run(x, threadId, 'integration', (id) => x.engine.markTerminal(id, 'failed', { error: 'merge conflict' }))
        run(x, threadId, 'undo', (id) => x.engine.markTerminal(id, 'completed', undefined, { resultText: 'undone' }))
      })
      expect(published).toMatchObject({ status: 'result_available', result: { text: 'result' } })
    })

    it('a wake that never started (cancelled first) said nothing and is not the result', async () => {
      const published = await publishedAfter((x, threadId) => run(x, threadId, 'wake', (id) => x.engine.markTerminal(id, 'cancelled'), false))
      expect(published.result).toMatchObject({ runStatus: 'completed', text: 'result' })
    })

    it('a queued message the user removed is the outcome of its own task, and not of an earlier one', async () => {
      f = delegationFixture()
      f.store.setProviderBackgroundWork(() => true)
      const parentRun = await f.runningRun('parent')
      const a = await f.delegate(parentRun.runId, 'a')
      f.finish(a.childRunId, 'first answer')
      const sent = await f.engine.dispatch({ kind: 'send', threadId: a.childThreadId, clientRequestId: 'b', source: 'gui', prompt: 'b' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const b = f.engine.delegations.getByChildRun(sent.runId)!
      f.engine.markTerminal(sent.runId, 'cancelled', { interruptedBy: 'user' })
      expect([task(a.delegationId).status, task(b.delegationId).status]).toEqual(['running', 'running'])
      f.store.setProviderBackgroundWork(() => false)
      f.store.settleHold(a.childThreadId)
      expect(task(a.delegationId).result).toMatchObject({ runStatus: 'completed', text: 'first answer' })
      expect(task(b.delegationId)).toMatchObject({ status: 'failed', result: { runStatus: 'cancelled', runId: sent.runId } })
    })
  })

  describe('re-evaluation at the shared boundaries', () => {
    it('effect lease reclaim: C held only by a wake effect whose lease expired is re-evaluated and settled', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      const wakeRunId = wakeRunning(pc.childThreadId)
      const claimed = claim(pc.childThreadId)
      expect(claimed?.effectId).toBe(wakeEffect(wakeRunId).effectId)
      f!.engine.markTerminal(wakeRunId, 'completed', undefined, { resultText: 'C final' })
      expect(task(pc.delegationId).status).toBe('running')
      // The executor died with the effect still running: its lease runs out, rule 1 reclaims it.
      f!.advance(EFFECT_KIND_SPEC['turn.start'].timeoutMs + EFFECT_LEASE_GRACE_MS + 1_000)
      const report = f!.reconciler.runOnce()
      expect(report.expiredLeases).toEqual([claimed!.effectId])
      expect(f!.outbox.get(claimed!.effectId)!.status).toBe('failed')
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'C final' } })
    })

    it('a wake effect that goes back to pending after its lease expires keeps holding, until rule 4 cancels the wake whose rows were read', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      const wakeRunId = wakeRunning(pc.childThreadId)
      f!.store.db.statement(`UPDATE effects SET max_attempts = 3 WHERE effect_id = ?`).run(wakeEffect(wakeRunId).effectId)
      expect(claim(pc.childThreadId)?.effectId).toBe(wakeEffect(wakeRunId).effectId)
      f!.engine.markTerminal(wakeRunId, 'completed', undefined, { resultText: 'C final' })
      f!.advance(EFFECT_KIND_SPEC['turn.start'].timeoutMs + EFFECT_LEASE_GRACE_MS + 1_000)
      f!.outbox.reclaimExpired(f!.now())
      expect(f!.outbox.get(wakeEffect(wakeRunId).effectId)!.status).toBe('pending')
      expect(task(pc.delegationId).status).toBe('running')
      // The wake would deliver rows the run already read: rule 4 cancels it, which ends the hold.
      f!.reconciler.runOnce()
      expect(f!.outbox.get(wakeEffect(wakeRunId).effectId)!.status).toBe('cancelled')
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'C final' } })
    })

    it('failed wake: the rows come back, the task waits through the retries, and a delivery that gives up fails it with that error', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      for (let attempt = 0; attempt <= MAX_INBOX_REDELIVERIES + 1; attempt += 1) {
        const wakes = f!.reconciler.runOnce().wakes.wakes.filter((id) => f!.engine.getRun(id)!.threadId === pc.childThreadId)
        if (wakes.length) {
          f!.engine.markStarting(wakes[0])
          f!.engine.markRunning(wakes[0])
          f!.engine.markTerminal(wakes[0], 'failed', { error: 'provider unavailable' })
          f!.outbox.cancel(wakeEffect(wakes[0]).effectId, f!.now(), 'provider unavailable')
          expect(task(pc.delegationId).status).toBe('running')
        }
        f!.advance(60_000)
      }
      f!.reconciler.runOnce()
      const [row] = f!.engine.inbox.listForThread(pc.childThreadId)
      expect(row.payload).toMatchObject({ deliveryFailed: true })
      const given = task(pc.delegationId)
      expect(given.status).toBe('failed')
      expect(given.result!.error).toMatch(/could not be delivered after \d+ attempts: provider unavailable/)
      expect(parentRows()).toHaveLength(1)
    })
  })

  describe('never held forever', () => {
    it('a wake the user stopped leaves its rows delivered and does not hold the task', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      const wakeRunId = wakeRunning(pc.childThreadId)
      f!.engine.markTerminal(wakeRunId, 'interrupted', { interruptedBy: 'user' })
      // Master's rule (kept): a stopped delivery is not redelivered...
      expect(f!.engine.inbox.listForThread(pc.childThreadId).map((row) => row.status)).toEqual(['delivered'])
      expect(f!.reconciler.runOnce().wakes.restored).toEqual([])
      // ...so once its effect has settled nothing is left to wait for, and the parent hears the stop.
      f!.outbox.cancel(wakeEffect(wakeRunId).effectId, f!.now(), 'stopped')
      expect(task(pc.delegationId)).toMatchObject({ status: 'failed', result: { runStatus: 'interrupted', error: 'interrupted by user', runId: wakeRunId } })
      expect(parentRows()).toHaveLength(1)
    })

    it('a steer whose run the user stopped does not hold the task either', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      // C is running a turn when G's result arrives and a native steer carries it.
      const live = f!.store.createRun({ threadId: pc.childThreadId, source: 'gui' })
      f!.engine.markStarting(live.runId)
      f!.engine.markRunning(live.runId)
      const steer = f!.reconciler.runOnce().wakes.steers[0]
      expect(steer).toBeTruthy()
      f!.engine.markTerminal(live.runId, 'interrupted', { interruptedBy: 'user' })
      f!.outbox.cancel(steer, f!.now(), 'stopped')
      expect(f!.engine.inbox.listForThread(pc.childThreadId).map((row) => row.status)).toEqual(['delivered'])
      expect(task(pc.delegationId).status).not.toBe('running')
    })

    it('a row flagged deliveryFailed does not hold the task; the task fails with the delivery error', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      const [row] = f!.engine.inbox.listByStatus(pc.childThreadId, 'pending')
      f!.engine.inbox.markDelivered([row.inboxId], 'effect:nowhere')
      f!.engine.inbox.patchPayload(row.inboxId, { deliveryFailed: true, attempts: 4, lastError: 'provider unavailable' })
      expect(task(pc.delegationId)).toMatchObject({ status: 'failed', result: { runStatus: 'failed', error: 'A subagent result could not be delivered after 4 attempts: provider unavailable' } })
    })

    it('retrying a delivery that gave up makes the row count again', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      const [row] = f!.engine.inbox.listByStatus(pc.childThreadId, 'pending')
      f!.engine.inbox.markDelivered([row.inboxId], 'effect:nowhere')
      f!.engine.inbox.patchPayload(row.inboxId, { deliveryFailed: true, attempts: 4, lastError: 'x' })
      expect(childBusy(f!.store, pc.childThreadId)).toBe(false)
      f!.engine.inbox.patchPayload(row.inboxId, { deliveryFailed: null })
      expect(childBusy(f!.store, pc.childThreadId)).toBe(true)
    })

    it('task_cancel reaches a held task: it is still running, and settling never publishes the cancelled task', async () => {
      const { pc, cg } = await nested()
      expect(task(pc.delegationId).status).toBe('running')
      const cancelled = await f!.engine.cancelDelegation(pc.delegationId)
      expect(cancelled).toEqual([cg.delegationId, pc.delegationId])
      expect(task(pc.delegationId)).toMatchObject({ status: 'cancelled', result: null })
      expect(parentRows()).toEqual([])
      f!.engine.settleAllWaitingDelegations()
      expect(task(pc.delegationId).status).toBe('cancelled')
    })

    it('a deleted thread acknowledges its rows, which releases the tasks waiting on it', async () => {
      const { pc, cg } = await nested()
      f!.finish(cg.childRunId, 'G result')
      expect(task(pc.delegationId).status).toBe('running')
      await f!.engine.cancelThreadWork(pc.childThreadId)
      expect(task(pc.delegationId).status).not.toBe('running')
    })
  })

  describe('restart with held delegations', () => {
    it('settles after recovery: the grandchild the restart cut off reaches C as a failure, C is woken, then P hears once', async () => {
      const { f: before, pc, cg } = await nested()
      expect(task(pc.delegationId).status).toBe('running')
      const home = before.profileHome
      before.dispose(true)
      f = delegationFixture({ profileHome: home, pid: 2 })
      const boot = f.engine.reconcileOnBoot()
      expect(boot.orphanedChildren).toEqual([cg.childRunId])
      // The grandchild's failure is C's to read, so P's task is still held through boot.
      expect(task(cg.delegationId).status).toBe('failed')
      expect(task(pc.delegationId).status).toBe('running')
      const wakeRunId = wakeRunning(pc.childThreadId)
      f.engine.markTerminal(wakeRunId, 'completed', undefined, { resultText: 'C after restart' })
      f.outbox.cancel(wakeEffect(wakeRunId).effectId, f.now(), 'settled')
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'C after restart' } })
      expect(parentRows()).toHaveLength(1)
    })

    it('boot puts every running delegation through the predicate: what only memory held is gone, so the task publishes', async () => {
      f = delegationFixture()
      f.store.setProviderBackgroundWork(() => true)
      const parentRun = await f.runningRun('parent')
      const pc = await f.delegate(parentRun.runId, 'pc')
      f.finish(pc.childRunId, 'turn text')
      expect(task(pc.delegationId).status).toBe('running')
      const home = f.profileHome
      f.dispose(true)
      f = delegationFixture({ profileHome: home, pid: 2 })
      f.engine.reconcileOnBoot()
      expect(task(pc.delegationId)).toMatchObject({ status: 'result_available', result: { text: 'turn text' } })
    })
  })

  it('settleWaitingDelegations returns what it published, and nothing for a thread that has no waiting task', async () => {
    const { pc } = await nested()
    expect(settleWaitingDelegations(f!.store, 'parent')).toEqual([])
    expect(settleWaitingDelegations(f!.store, 'no-such-thread')).toEqual([])
    expect(settleWaitingDelegations(f!.store, pc.childThreadId)).toEqual([])
  })
})
