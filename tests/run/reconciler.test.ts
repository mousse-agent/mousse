import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox, EFFECT_LEASE_GRACE_MS } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'

const T0 = Date.parse('2026-10-12T00:00:00.000Z')

describe('Reconciler', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  /** One fake clock drives the database, the engine, the outbox and the reconciler. */
  const setup = (heartbeatMs = 10_000) => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-reconciler-'))
    let clock = T0
    db = new ProfileDatabase({ profileHome, clock: () => clock })
    const store = new RunStore(db)
    const now = () => new Date(clock).toISOString()
    const outbox = new EffectOutbox(store, { now })
    const tools = new ToolInvocations(store)
    const engine = new RunEngine({ store, outbox, tools, now, pid: 1 })
    const reconciler = new Reconciler({ store, outbox, tools, now, heartbeatMs })
    return {
      store,
      outbox,
      tools,
      engine,
      reconciler,
      now,
      advance: (ms: number) => {
        clock += ms
      }
    }
  }

  const runningRun = async (engine: RunEngine, threadId = 't') => {
    const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId: `req-${threadId}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    return engine.markRunning(sent.runId)
  }

  const types = (store: RunStore, threadId = 't') => store.listEvents(threadId).map((event) => event.type)

  it('reports nothing on a quiet store', () => {
    const { reconciler } = setup()
    expect(reconciler.runOnce()).toEqual({
      expiredLeases: [],
      staleRuns: [],
      forcedInterrupts: [],
      queuedStarts: [],
      outcomeUnknownTools: []
    })
  })

  it('rule 1: an expired lease goes back to pending, or failed when attempts are exhausted', () => {
    const { store, outbox, reconciler, now, advance } = setup()
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    outbox.claimNext('1:1', now())
    advance(30_000 + EFFECT_LEASE_GRACE_MS - 1)
    expect(reconciler.runOnce().expiredLeases).toEqual([])
    advance(1)
    expect(reconciler.runOnce().expiredLeases).toEqual([effect.effectId])
    expect(outbox.get(effect.effectId)).toMatchObject({ status: 'pending', lastError: 'lease expired' })
    expect(types(store)).toContain('reconcile.expired_lease')

    // Exhaust the attempts: every claim expires.
    for (let attempt = 2; attempt <= 5; attempt++) {
      advance(60_000)
      expect(outbox.claimNext('1:1', now())!.attempts).toBe(attempt)
      advance(30_000 + EFFECT_LEASE_GRACE_MS)
      reconciler.runOnce()
    }
    expect(outbox.get(effect.effectId)).toMatchObject({ status: 'failed', attempts: 5, lastError: 'lease expired' })
    const last = store.listEvents('t').filter((event) => event.type === 'reconcile.expired_lease').at(-1)!
    expect(last.payload).toEqual({ effectId: effect.effectId, status: 'failed', attempts: 5 })
  })

  it('rule 2: a running run with no live effect and no heartbeat is interrupted by provider', async () => {
    const { store, engine, outbox, reconciler, advance, now } = setup()
    const run = await runningRun(engine)
    advance(15_000)
    engine.heartbeat(run.runId)
    expect(store.getRun(run.runId)!.epoch).toBe(run.epoch)
    advance(19_000)
    expect(reconciler.runOnce().staleRuns).toEqual([])

    // A running effect for the run keeps it alive however stale the heartbeat.
    const turn = outbox.enqueue({ threadId: 't', runId: run.runId, kind: 'turn.start' })
    outbox.claimNext('1:1', now())
    advance(60_000)
    expect(reconciler.runOnce().staleRuns).toEqual([])
    outbox.succeed(turn.effectId, '1:1', now())

    expect(reconciler.runOnce().staleRuns).toEqual([run.runId])
    const after = store.getRun(run.runId)!
    expect(after).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'provider', error: 'no terminal event' }
    })
    expect(store.getAttempt(after.activeAttemptId!)!.status).toBe('interrupted')
    const repair = store.listEvents('t').find((event) => event.type === 'reconcile.stale_run')!
    expect(repair.payload).toMatchObject({ runId: run.runId, fromStatus: 'running', status: 'interrupted' })
    expect(reconciler.runOnce().staleRuns).toEqual([])
  })

  it('rule 2: measures from started_at when no heartbeat was ever written', async () => {
    const { store, engine, reconciler, advance } = setup()
    const run = await runningRun(engine)
    advance(19_000)
    expect(reconciler.runOnce().staleRuns).toEqual([])
    advance(2_000)
    expect(reconciler.runOnce().staleRuns).toEqual([run.runId])
    expect(store.getRun(run.runId)!.status).toBe('interrupted')
  })

  it('rule 3: a stopped run with no interrupt effect is forced interrupted after 10 s', async () => {
    const { store, engine, reconciler, advance } = setup(3_600_000)
    const run = await runningRun(engine)
    await engine.dispatch({ kind: 'stop', threadId: 't', clientRequestId: 'stop-1', runId: run.runId })
    advance(10_000)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([])
    advance(1_000)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([run.runId])
    expect(store.getRun(run.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'user', stopRequested: true }
    })
    const repair = store.listEvents('t').find((event) => event.type === 'reconcile.forced_interrupt')!
    expect(repair.payload).toMatchObject({ severity: 'warning', interruptEffectId: null })
  })

  it('rule 3: waits for the latest turn.interrupt effect to be terminal for 10 s', async () => {
    const { store, engine, outbox, reconciler, advance, now } = setup(3_600_000)
    const run = await runningRun(engine)
    await engine.dispatch({ kind: 'stop', threadId: 't', clientRequestId: 'stop-1', runId: run.runId })
    const interrupt = outbox.enqueue({ threadId: 't', runId: run.runId, kind: 'turn.interrupt' })
    advance(20_000)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([])
    outbox.claimNext('1:1', now())
    advance(5_000)
    outbox.succeed(interrupt.effectId, '1:1', now())
    advance(10_000)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([])
    advance(1)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([run.runId])
    const repair = store.listEvents('t').find((event) => event.type === 'reconcile.forced_interrupt')!
    expect(repair.payload).toMatchObject({ interruptEffectId: interrupt.effectId, interruptStatus: 'succeeded' })
  })

  it('rule 3: ignores runs without stopRequested', async () => {
    const { engine, reconciler, advance } = setup(3_600_000)
    await runningRun(engine)
    advance(60_000)
    expect(reconciler.runOnce().forcedInterrupts).toEqual([])
  })

  it('rule 6: a started tool on a terminal run becomes outcome_unknown', async () => {
    const { store, engine, tools, reconciler, now } = setup()
    const run = await runningRun(engine)
    tools.start({ invocationId: 'call-1', runId: run.runId, attemptId: run.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: now() })
    tools.start({ invocationId: 'call-2', runId: run.runId, attemptId: run.activeAttemptId!, tool: 'read_file', argsDigest: 'd', now: now() })
    tools.commit('call-2', now())
    expect(reconciler.runOnce().outcomeUnknownTools).toEqual([])
    engine.markTerminal(run.runId, 'failed', { error: 'boom' })
    expect(reconciler.runOnce().outcomeUnknownTools).toEqual(['call-1'])
    expect(tools.get('call-1')!.status).toBe('outcome_unknown')
    expect(tools.get('call-2')!.status).toBe('committed')
    expect(types(store)).toContain('reconcile.tool_outcome_unknown')
    expect(reconciler.runOnce().outcomeUnknownTools).toEqual([])
  })

  it('start() runs passes on an interval and stop() halts them', async () => {
    const { outbox, reconciler, now, advance } = setup()
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    outbox.claimNext('1:1', now())
    advance(60_000)
    reconciler.start(10)
    await new Promise((resolve) => setTimeout(resolve, 50))
    reconciler.stop()
    expect(outbox.get(effect.effectId)!.status).toBe('pending')
  })
})
