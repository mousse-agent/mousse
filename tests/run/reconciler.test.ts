import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderCapabilities } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox, EFFECT_LEASE_GRACE_MS } from '../../src/mms/run/EffectOutbox'
import { RECONCILER_THREAD_ID, Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
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
  const setup = (heartbeatMs = 10_000, capabilitiesFor?: (threadId: string) => ProviderCapabilities | null, credentialsFor?: (store: RunStore) => { pruneExpired(): number }) => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-reconciler-'))
    let clock = T0
    db = new ProfileDatabase({ profileHome, clock: () => clock })
    const store = new RunStore(db)
    const now = () => new Date(clock).toISOString()
    const outbox = new EffectOutbox(store, { now })
    const tools = new ToolInvocations(store)
    const engine = new RunEngine({ store, outbox, tools, now, pid: 1 })
    const credentials = credentialsFor?.(store)
    const reconciler = new Reconciler({ store, outbox, tools, now, heartbeatMs, capabilitiesFor, credentials })
    return {
      store,
      outbox,
      tools,
      engine,
      reconciler,
      credentials,
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

  it('leaves a healthy running run alone and writes nothing', async () => {
    const { store, engine, reconciler } = setup()
    const run = await runningRun(engine)
    const seq = store.maxSeq('t')
    const report = reconciler.runOnce()
    expect(
      [report.expiredLeases, report.staleRuns, report.forcedInterrupts, report.queuedStarts, report.strandedCancelled, report.outcomeUnknownTools]
    ).toEqual([[], [], [], [], [], []])
    expect(store.getRun(run.runId)!.status).toBe('running')
    expect(store.maxSeq('t')).toBe(seq)
  })

  it('a rule that throws does not skip the rest; the failure is an event naming the rule (L1)', async () => {
    const { store, outbox, engine, reconciler, advance } = setup()
    const run = await runningRun(engine)
    advance(60_000)
    outbox.reclaimExpired = () => {
      throw new Error('disk on fire')
    }
    const report = reconciler.runOnce()
    expect(report.expiredLeases).toEqual([])
    // Rule 2 still ran after rule 1 failed.
    expect(report.staleRuns).toEqual([run.runId])
    const failures = store.listEvents(RECONCILER_THREAD_ID).filter((event) => event.type === 'reconcile.rule_failed')
    expect(failures.map((event) => event.payload)).toEqual([{ rule: 'expired_leases', error: 'disk on fire' }])
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

  it('rule 2: a sparse-event adapter gets 6x the silence window', async () => {
    const sparse: ProviderCapabilities = { ...PI_LOOP_CAPABILITIES, events: 'sparse' }
    const { store, engine, reconciler, advance } = setup(10_000, (threadId) => (threadId === 'sparse' ? sparse : PI_LOOP_CAPABILITIES))
    const rich = await runningRun(engine, 'rich')
    const quiet = await runningRun(engine, 'sparse')
    advance(21_000)
    expect(reconciler.runOnce().staleRuns).toEqual([rich.runId])
    advance(98_000)
    expect(reconciler.runOnce().staleRuns).toEqual([])
    expect(store.getRun(quiet.runId)!.status).toBe('running')
    advance(2_000)
    expect(reconciler.runOnce().staleRuns).toEqual([quiet.runId])
  })

  it('rule 2: a local action is exempt while its heartbeat is fresh, without consulting capabilities', async () => {
    let asked = 0
    const { store, engine, reconciler, advance } = setup(10_000, () => {
      asked += 1
      return { ...PI_LOOP_CAPABILITIES, events: 'sparse' }
    })
    const undo = store.createRun({ threadId: 't', source: 'undo' })
    engine.markStarting(undo.runId)
    engine.markRunning(undo.runId)
    for (let i = 0; i < 6; i++) {
      advance(10_000)
      engine.heartbeat(undo.runId)
      expect(reconciler.runOnce().staleRuns).toEqual([])
    }
    // Its daemon died mid-action: the base window applies, not the adapter's.
    advance(21_000)
    expect(reconciler.runOnce().staleRuns).toEqual([undo.runId])
    expect(asked).toBe(0)
  })

  it('rule 5: a queued run whose turn.start died is started again from the stored send', async () => {
    const { store, engine, outbox, reconciler } = setup()
    const sent = await engine.dispatch({ kind: 'send', threadId: 't', clientRequestId: 'send-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const send = { runId: sent.runId, threadId: 't', input: { content: 'hello', mode: 'agent' }, reuseLastUser: false }
    const dead = outbox.enqueue({ threadId: 't', runId: sent.runId, kind: 'turn.start', payload: send })
    outbox.cancelProcessBound('daemon_restart')
    const report = reconciler.runOnce()
    expect(report.queuedStarts).toEqual([sent.runId])
    expect(report.strandedCancelled).toEqual([])
    const fresh = outbox.listForRun(sent.runId).at(-1)!
    expect(fresh).toMatchObject({ effectId: `effect:${sent.runId}:turn.start:2`, status: 'pending', payload: send })
    expect(store.getRun(sent.runId)!.status).toBe('queued')
    const repair = store.listEvents('t').find((event) => event.type === 'reconcile.restarted_queued_run')!
    expect(repair.payload).toEqual({ runId: sent.runId, effectId: fresh.effectId, previousEffectId: dead.effectId })
    // The live effect makes the run no longer stranded.
    expect(reconciler.runOnce().queuedStarts).toEqual([])
  })

  it('rule 5: a stranded queued run without a stored send is cancelled', async () => {
    const { store, engine, outbox, reconciler } = setup()
    const sent = await engine.dispatch({ kind: 'send', threadId: 't', clientRequestId: 'send-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    outbox.enqueue({ threadId: 't', runId: sent.runId, kind: 'turn.start' })
    outbox.cancelProcessBound('daemon_restart')
    expect(reconciler.runOnce().strandedCancelled).toEqual([sent.runId])
    expect(store.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { error: 'no turn payload after restart' } })
    expect(types(store)).toContain('reconcile.cancelled_stranded_run')
  })

  it('rule 5: leaves queue items, runs without a turn.start and runs behind an active run alone', async () => {
    const { store, engine, outbox, reconciler } = setup()
    const send = async (threadId: string, key: string) => {
      const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      return sent.runId
    }
    // A queue item's send: the message queue's recovery drains it.
    const item = await send('q', 'q-1')
    outbox.enqueue({ threadId: 'q', runId: item, kind: 'turn.start', payload: { runId: item, threadId: 'q', input: 'hi', queueItemId: 'item-1' } })
    // A run still waiting on the message queue (no effect yet).
    const waiting = await send('w', 'w-1')
    // A run whose dead effect stored a send, behind another thread run that is active.
    const active = await runningRun(engine, 'busy')
    const behind = await send('busy', 'busy-2')
    outbox.enqueue({ threadId: 'busy', runId: behind, kind: 'turn.start', payload: { runId: behind, threadId: 'busy', input: 'later' } })
    outbox.cancelProcessBound('daemon_restart')
    const report = reconciler.runOnce()
    expect(report.queuedStarts).toEqual([])
    expect(report.strandedCancelled).toEqual([])
    for (const runId of [item, waiting, behind]) expect(store.getRun(runId)!.status).toBe('queued')
    // Once the active run ends, the run behind it starts again.
    engine.markTerminal(active.runId, 'completed')
    expect(reconciler.runOnce().queuedStarts).toEqual([behind])
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

    // After stop() a lease that expires is left alone: no further pass runs.
    advance(60_000)
    expect(outbox.claimNext('1:1', now())?.effectId).toBe(effect.effectId)
    advance(60_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(outbox.get(effect.effectId)!.status).toBe('running')
  })

  it('reports no credential count when no credential store is attached', () => {
    expect('prunedCredentials' in setup().reconciler.runOnce()).toBe(false)
  })

  it('prunes dead MCP credentials in every pass', async () => {
    const withStore = setup(10_000, undefined, (store) => new McpCredentials(store))
    const credentials = withStore.credentials as McpCredentials
    const run = await runningRun(withStore.engine)
    credentials.mintOrReuse({ threadId: 't', runId: run.runId, provider: 'claude-subscription', modeCeiling: 'default' })
    expect(withStore.reconciler.runOnce().prunedCredentials).toBe(0)
    expect(credentials.listForThread('t')).toHaveLength(1)
    withStore.advance(25 * 60 * 60 * 1000)
    expect(withStore.reconciler.runOnce().prunedCredentials).toBe(1)
    expect(credentials.listForThread('t')).toEqual([])
    expect(withStore.reconciler.runOnce().prunedCredentials).toBe(0)
  })

  it('records a failing credential prune as rule_failed and still completes the pass', () => {
    const f = setup(10_000, undefined, () => ({ pruneExpired: () => { throw new Error('credential table is locked') } }))
    const report = f.reconciler.runOnce()
    expect(report.prunedCredentials).toBe(0)
    expect(report.expiredLeases).toEqual([])
    expect(f.store.listEvents(RECONCILER_THREAD_ID).map((event) => event.payload)).toContainEqual({ rule: 'prune_credentials', error: 'credential table is locked' })
  })
})
