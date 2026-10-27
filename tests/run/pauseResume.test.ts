import { afterEach, describe, expect, it } from 'vitest'
import type { EffectRecord, RunPause, RunResumePayload } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const HOUR = 3_600_000
/** The fixture clock starts at 2026-10-12T00:00:00Z; the limit resets an hour later. */
const UNTIL = '2026-10-12T01:00:00.000Z'
const pause = (overrides: Partial<RunPause> = {}): RunPause => ({
  reason: 'usage_limit',
  until: UNTIL,
  estimated: false,
  provider: 'claude',
  limitKind: 'five_hour',
  count: 1,
  autoResume: true,
  ...overrides
})

/**
 * A pause from the outside: a run pauses with its timer, the daemon may restart, and the worker's
 * `run.resume` executor (stood in for here by the smallest executor that keeps its contract: send the
 * continue turn once as `queue:resume:<runId>`, and do nothing for a run that is not paused any more)
 * fires at the reset.
 */
describe('a paused run until the usage limit resets (SPEC §5, §16.4)', () => {
  const open: DelegationFixture[] = []
  afterEach(() => {
    for (const fixture of open.splice(0)) fixture.dispose()
  })
  const track = (fixture: DelegationFixture) => {
    open.push(fixture)
    return fixture
  }

  /** The continue turn the executor sends for `effect`, or nothing when the run is not paused. */
  const execute = async (f: DelegationFixture, effect: EffectRecord) => {
    const payload = effect.payload as RunResumePayload
    const run = f.store.getRun(payload.runId)
    if (!run || run.status !== 'paused') return undefined
    return f.engine.dispatch({
      kind: 'send',
      threadId: payload.threadId,
      clientRequestId: `queue:resume:${payload.runId}`,
      source: payload.manual ? 'resume_now' : 'resume',
      continuationOfRunId: payload.runId
    })
  }

  /** One pass of the worker's replay-safe fibre: claim what is due, execute it, settle it. */
  const fire = async (f: DelegationFixture, owner = 'worker') => {
    const effect = f.outbox.claimNext(owner, f.now(), { lanes: ['replaySafe'] })
    if (!effect) return null
    const result = await execute(f, effect)
    f.outbox.succeed(effect.effectId, owner, f.now())
    return { effect, result }
  }

  const runsOf = (f: DelegationFixture, threadId: string) =>
    f.store.db.statement('SELECT run_id, status, source FROM runs WHERE thread_id = ? ORDER BY ordinal').all(threadId) as Array<{ run_id: string; status: string; source: string }>

  const pausedRun = async (f: DelegationFixture, threadId = 't1', overrides: Partial<RunPause> = {}) => {
    const run = await f.runningRun(threadId)
    return f.engine.pauseRun({ runId: run.runId, pause: pause(overrides), resumeAt: UNTIL })
  }

  describe('at the reset time', () => {
    it('continues once at the reset and not before', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)

      expect(await fire(f)).toBeNull()
      f.advance(HOUR - 1_000)
      expect(await fire(f)).toBeNull()
      expect(f.store.getRun(paused.runId)!.status).toBe('paused')

      f.advance(1_000)
      const fired = await fire(f)
      expect(fired!.result).toMatchObject({ status: 'accepted', replayed: false })
      const continuation = (fired!.result as { runId: string }).runId
      expect(f.store.getRun(continuation)).toMatchObject({
        status: 'queued',
        source: 'resume',
        clientRequestId: `queue:resume:${paused.runId}`,
        outcome: { continuationOf: paused.runId, resumedFromPause: 'auto' }
      })
      // The pause ended in the same transaction that created the continuation: handed over, not cancelled.
      expect(f.store.getRun(paused.runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'provider', pause: { endedBy: 'resume' } } })
      expect(f.store.getPausedRun('t1')).toBeNull()
      expect(f.outbox.get(fired!.effect.effectId)!.status).toBe('succeeded')

      // Nothing more to fire, and a second send of the same request replays the one continuation.
      f.advance(HOUR)
      expect(await fire(f)).toBeNull()
      expect(await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: `queue:resume:${paused.runId}`, source: 'resume', continuationOfRunId: paused.runId })).toMatchObject({ status: 'accepted', runId: continuation, replayed: true })
      expect(runsOf(f, 't1')).toHaveLength(2)
    })

    it('Resume now continues at once and the timer never fires a second continuation', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)
      f.advance(10 * 60_000)

      f.engine.requestResume(paused.runId, true)
      const fired = await fire(f)
      expect(fired!.result).toMatchObject({ status: 'accepted' })
      const continuation = (fired!.result as { runId: string }).runId
      expect(f.store.getRun(continuation)).toMatchObject({ source: 'resume_now', outcome: { resumedFromPause: 'user' } })
      expect(f.store.getRun(paused.runId)!.outcome!.pause).toMatchObject({ endedBy: 'resume_now' })

      f.advance(HOUR)
      expect(await fire(f)).toBeNull()
      expect(runsOf(f, 't1')).toHaveLength(2)
    })

    it('a timer that fires after a person\'s message finds nothing to continue', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)
      const sent = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'person', source: 'gui' })
      expect(sent).toMatchObject({ status: 'accepted', endedPause: { runId: paused.runId } })
      expect(f.store.getRun(paused.runId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'user_message' } } })

      f.advance(HOUR)
      expect(await fire(f)).toBeNull()
      expect(runsOf(f, 't1').map((run) => run.source)).toEqual(['gui', 'gui'])
    })
  })

  describe('Stop while paused', () => {
    it('ends the pause and the timer, and nothing continues at the reset', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)
      f.advance(5 * 60_000)

      const stopped = f.engine.stopSubtree({ threadId: 't1', reason: 'user' })
      expect(stopped.cancelledRuns).toEqual([{ threadId: 't1', runId: paused.runId }])
      expect(f.store.getRun(paused.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'stop' } } })
      expect(f.store.getPausedRun('t1')).toBeNull()

      f.advance(HOUR)
      expect(await fire(f)).toBeNull()
      expect(runsOf(f, 't1')).toHaveLength(1)
    })

    it('a timer already claimed when the Stop came finds the run cancelled and sends nothing', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)
      f.advance(HOUR)
      const claimed = f.outbox.claimNext('worker', f.now(), { lanes: ['replaySafe'] })!
      f.engine.stopSubtree({ threadId: 't1', reason: 'user' })

      // A running timer is never cancelled by the Stop; its executor re-checks the run.
      expect(f.outbox.get(claimed.effectId)!.status).toBe('running')
      expect(await execute(f, claimed)).toBeUndefined()
      f.outbox.succeed(claimed.effectId, 'worker', f.now())
      expect(f.store.getRun(paused.runId)!.status).toBe('cancelled')
      expect(runsOf(f, 't1')).toHaveLength(1)
    })

    it('a Stop after the continue turn was admitted cancels it', async () => {
      const f = track(delegationFixture())
      await pausedRun(f)
      f.advance(HOUR)
      const fired = await fire(f)
      const continuation = (fired!.result as { runId: string }).runId

      const stopped = f.engine.stopSubtree({ threadId: 't1', reason: 'user' })
      expect(stopped.cancelledRuns).toContainEqual({ threadId: 't1', runId: continuation })
      expect(f.store.getRun(continuation)!.status).toBe('cancelled')
    })
  })

  describe('a daemon restart while paused', () => {
    /** A second daemon on the same run database, its clock back at the fixture start. */
    const restart = (first: DelegationFixture, pid = 2) => {
      const profileHome = first.profileHome
      first.dispose(true)
      const second = track(delegationFixture({ profileHome, pid }))
      return { second, boot: second.engine.reconcileOnBoot() }
    }

    it('leaves the paused run and its timer alone, and continues once at the reset', async () => {
      const first = delegationFixture()
      const paused = await pausedRun(first)
      const { second, boot } = restart(first)

      expect(boot.interrupted).toEqual([])
      expect(second.store.getRun(paused.runId)).toMatchObject({ status: 'paused', outcome: { pause: { until: UNTIL, autoResume: true } } })
      expect(second.outbox.listForRun(paused.runId).filter((effect) => effect.kind === 'run.resume').map((effect) => effect.status)).toEqual(['pending'])
      // The thread is not active, so it takes a person's message as before.
      expect(second.store.getActiveRun('t1')).toBeNull()

      expect(await fire(second)).toBeNull()
      second.advance(HOUR)
      const fired = await fire(second)
      expect(fired!.result).toMatchObject({ status: 'accepted' })
      expect(second.store.getRun(paused.runId)!.status).toBe('interrupted')
      expect(await fire(second)).toBeNull()
      expect(runsOf(second, 't1')).toHaveLength(2)
    })

    it('a restart while the timer was running re-queues it, and the continue turn is sent once', async () => {
      const first = delegationFixture()
      const paused = await pausedRun(first)
      first.advance(HOUR)
      const claimed = first.outbox.claimNext('worker', first.now(), { lanes: ['replaySafe'] })!
      expect(first.outbox.get(claimed.effectId)!.status).toBe('running')

      const { second, boot } = restart(first)
      expect(boot.interrupted).toEqual([])
      expect(second.outbox.get(claimed.effectId)!.status).toBe('pending')
      second.advance(HOUR)
      expect(await fire(second, 'worker-2')).toMatchObject({ result: { status: 'accepted' } })
      expect(second.store.getRun(paused.runId)!.status).toBe('interrupted')
      expect(runsOf(second, 't1')).toHaveLength(2)
    })

    it('a restart after the continue turn was admitted and before the timer settled sends no second one', async () => {
      const first = delegationFixture()
      const paused = await pausedRun(first)
      first.advance(HOUR)
      const claimed = first.outbox.claimNext('worker', first.now(), { lanes: ['replaySafe'] })!
      const sent = await execute(first, claimed)
      expect(sent).toMatchObject({ status: 'accepted' })
      // Crash here: the effect is still `running`.

      const { second } = restart(first)
      expect(second.outbox.get(claimed.effectId)!.status).toBe('pending')
      second.advance(HOUR)
      const again = await fire(second, 'worker-2')
      expect(again).toMatchObject({ result: undefined })
      expect(second.store.getRun(paused.runId)!.status).toBe('interrupted')
      expect(runsOf(second, 't1')).toHaveLength(2)
    })

    it('a timer that fires more than a day late is dropped as stale: the run stays paused until Resume now', async () => {
      const first = delegationFixture()
      const paused = await pausedRun(first)
      const { second } = restart(first)
      second.advance(2 * 24 * HOUR)

      // The executor's 24 h rule (PR 3) drops an automatic timer the reset left behind while Mousse was off.
      second.engine.endPause(paused.runId, 'stale')
      expect(second.store.getRun(paused.runId)).toMatchObject({ status: 'paused', outcome: { pause: { autoResume: false, stale: true } } })
      expect(second.store.getRun(paused.runId)!.outcome!.pause!.endedBy).toBeUndefined()
      second.engine.requestResume(paused.runId, true)
      expect(await fire(second)).toMatchObject({ result: { status: 'accepted' } })
      expect(second.store.getRun(paused.runId)!.status).toBe('interrupted')
    })
  })

  describe('nothing started on the thread\'s behalf runs beside the pause', () => {
    it('refuses it for the whole wait, and the continue turn is the only run created', async () => {
      const f = track(delegationFixture())
      const paused = await pausedRun(f)
      const behalf = ['wake', 'provider-continuation', 'integration', 'steer-late', 'delegation']

      for (const source of behalf)
        expect(await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: `${source}-1`, source })).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      f.advance(HOUR - 1_000)
      for (const source of behalf)
        expect(await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: `${source}-2`, source })).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      expect(runsOf(f, 't1')).toHaveLength(1)
      expect(f.store.getRun(paused.runId)!.status).toBe('paused')

      f.advance(1_000)
      await fire(f)
      expect(runsOf(f, 't1').map((run) => run.source)).toEqual(['gui', 'resume'])
    })

    it('a run of that kind admitted before the pause does not start: the pause and its timer stay', async () => {
      const f = track(delegationFixture())
      const running = await f.runningRun('t1')
      // Admitted while the thread was busy with the run that is about to hit the limit.
      const wake = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'wake-1', source: 'wake' })
      if (wake.status !== 'accepted') throw new Error('wake rejected')
      f.engine.pauseRun({ runId: running.runId, pause: pause(), resumeAt: UNTIL })

      expect(() => f.engine.markStarting(wake.runId)).toThrow(/paused/)
      expect(f.store.getRun(wake.runId)!.status).toBe('queued')
      expect(f.store.getRun(running.runId)!.status).toBe('paused')
      expect(f.outbox.listForRun(running.runId).filter((effect) => effect.kind === 'run.resume').map((effect) => effect.status)).toEqual(['pending'])
    })
  })
})
