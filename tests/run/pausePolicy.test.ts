import { afterEach, describe, expect, it } from 'vitest'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { decideUsageLimit, pauseCount, usageLimitOf, type UsageLimitDecision } from '../../src/mms/run/pausePolicy'
import type { RunPause } from '../../src/mms/run/types'
import { AppError } from '../../src/shared/errors'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const HOUR = 3_600_000
// `usageLimitError` judges a reset time against the real clock, so the tests do too.
const NOW = Date.now()
const none = () => null

describe('the usage-limit pause decision', () => {
  const decide = (error: unknown, overrides: Partial<Parameters<typeof decideUsageLimit>[0]> = {}) =>
    decideUsageLimit({ error, run: { outcome: {} }, lookup: none, cap: 3, autoResume: true, nowMs: NOW, ...overrides })

  it('pauses until the provider\'s reset time and names the window', () => {
    const resetsAt = new Date(NOW + HOUR).toISOString()
    const decision = decide(usageLimitError({ provider: 'claude', resetsAt, estimated: false, limitKind: 'five_hour' }))
    expect(decision).toEqual({
      action: 'pause',
      pause: { reason: 'usage_limit', until: resetsAt, estimated: false, provider: 'claude', limitKind: 'five_hour', count: 1, autoResume: true }
    })
  })

  it('estimates five hours when the provider gave no time, a past time, or one too far ahead', () => {
    const estimate = new Date(NOW + 5 * HOUR).toISOString()
    for (const resetsAt of [undefined, new Date(NOW - HOUR).toISOString(), new Date(NOW + 30 * 24 * HOUR).toISOString()]) {
      // The error is built a moment ago; the decision re-checks the time against its own clock.
      const error = usageLimitError({ provider: 'codex', ...(resetsAt ? { resetsAt } : {}), estimated: resetsAt === undefined })
      expect(decide(error, { nowMs: NOW })).toMatchObject({ action: 'pause', pause: { until: estimate, estimated: true } })
    }
  })

  it('records whether the user turned automatic resume on', () => {
    const error = usageLimitError({ provider: 'claude', resetsAt: new Date(NOW + HOUR).toISOString(), estimated: false })
    expect(decide(error, { autoResume: false })).toMatchObject({ action: 'pause', pause: { autoResume: false } })
  })

  it('leaves every other failure to the ordinary failure path', () => {
    expect(decide(new Error('boom'))).toBeUndefined()
    expect(decide(new AppError({ code: 'provider_unavailable', message: 'down', errorInfo: { category: 'unavailable', retryable: true } }))).toBeUndefined()
    // A gateway rate limit with no usage limit behind it is a short wait, not a plan limit.
    expect(usageLimitOf(new AppError({ code: 'rate_limited', message: 'slow down', errorInfo: { category: 'unavailable', retryable: true } }))).toBeUndefined()
  })

  it('leaves a run that is being stopped to the Stop', () => {
    const error = usageLimitError({ provider: 'claude', estimated: true })
    expect(decide(error, { run: { outcome: { stopRequested: true } } })).toBeUndefined()
  })
})

describe('the repeat cap', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  const limit = () => usageLimitError({ provider: 'claude', resetsAt: new Date(NOW + HOUR).toISOString(), estimated: false, limitKind: 'five_hour' })

  /** The turn of `runId` ends on a usage limit: decide, pause when the decision says so. */
  const hit = (runId: string, cap: number): UsageLimitDecision => {
    const run = f!.store.getRun(runId)!
    const decision = decideUsageLimit({ error: limit(), run, lookup: (id) => f!.store.getRun(id), cap, autoResume: true, nowMs: NOW })!
    if (decision.action === 'pause') f!.engine.pauseRun({ runId, pause: decision.pause, resumeAt: decision.pause.until })
    else f!.engine.markTerminal(runId, 'failed', undefined, { error: decision.message })
    return decision
  }

  /** The continue turn of the paused run: sent by the timer, or by a person for Resume now. */
  const resume = async (paused: string, source: 'resume' | 'resume_now') => {
    const sent = await f!.engine.dispatch({
      kind: 'send',
      threadId: 't1',
      clientRequestId: `queue:resume:${paused}:${source}`,
      source,
      continuationOfRunId: paused
    })
    if (sent.status !== 'accepted') throw new Error(`resume rejected: ${JSON.stringify(sent)}`)
    f!.engine.markStarting(sent.runId)
    f!.engine.markRunning(sent.runId)
    return sent.runId
  }

  it('pauses three automatic resumes in a row and fails the fourth hit', async () => {
    f = delegationFixture()
    let runId = (await f.runningRun('t1')).runId
    const counts: number[] = []
    for (let n = 1; n <= 3; n += 1) {
      const decision = hit(runId, 3)
      expect(decision.action).toBe('pause')
      counts.push((f.store.getRun(runId)!.outcome!.pause as RunPause).count)
      runId = await resume(runId, 'resume')
    }
    expect(counts).toEqual([1, 2, 3])

    const fourth = hit(runId, 3)
    expect(fourth).toEqual({ action: 'fail', message: 'Usage limit reached 4 times in a row; the run stopped. Send a message to try again.' })
    expect(f.store.getRun(runId)).toMatchObject({ status: 'failed' })
    expect(f.store.getPausedRun('t1')).toBeNull()
  })

  it('a Resume now in the chain starts it again at one', async () => {
    f = delegationFixture()
    let runId = (await f.runningRun('t1')).runId
    hit(runId, 3)
    runId = await resume(runId, 'resume')
    hit(runId, 3)
    expect(f.store.getRun(runId)!.outcome!.pause!.count).toBe(2)
    runId = await resume(runId, 'resume_now')
    expect(f.store.getRun(runId)!.outcome).toMatchObject({ resumedFromPause: 'user' })

    expect(hit(runId, 3)).toMatchObject({ action: 'pause', pause: { count: 1 } })
  })

  it('a person\'s message starts a new chain', async () => {
    f = delegationFixture()
    let runId = (await f.runningRun('t1')).runId
    hit(runId, 3)
    runId = await resume(runId, 'resume')
    hit(runId, 3)
    const sent = await f.engine.dispatch({ kind: 'send', threadId: 't1', clientRequestId: 'person', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    f.engine.markStarting(sent.runId)
    f.engine.markRunning(sent.runId)
    expect(pauseCount(f.store.getRun(sent.runId)!, (id) => f.store.getRun(id))).toBe(1)
  })

  it('a cap of one fails the first repeat', async () => {
    f = delegationFixture()
    let runId = (await f.runningRun('t1')).runId
    expect(hit(runId, 1).action).toBe('pause')
    runId = await resume(runId, 'resume')
    expect(hit(runId, 1)).toMatchObject({ action: 'fail' })
  })
})
