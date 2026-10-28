import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { LocalActionGated, RunEngine } from '../../src/mms/run/RunEngine'

import { RunStore } from '../../src/mms/run/RunStore'
import type { RunPause, RunPauseEnd, RunResumePayload, ThreadEvent } from '../../src/mms/run/types'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

function codeOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    if (error instanceof RunStoreError) return error.code
    throw error
  }
  return undefined
}

describe('RunEngine', () => {
  let profileHome: string | undefined
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const openDb = (fault?: (point: string) => void): ProfileDatabase => {
    profileHome ??= mkdtempSync(join(tmpdir(), 'mousse-run-engine-'))
    let tick = Date.UTC(2026, 9, 12)
    const db = new ProfileDatabase({ profileHome, clock: () => (tick += 1000), fault })
    dbs.push(db)
    return db
  }

  const open = (fault?: (point: string) => void) => {
    const store = new RunStore(openDb(fault))
    const engine = new RunEngine({ store })
    const events: ThreadEvent[] = []
    const signals: Array<[string, unknown]> = []
    engine.on('event', (event: ThreadEvent) => events.push(event))
    engine.on('stop-requested', (payload) => signals.push(['stop-requested', payload]))
    engine.on('steer-accepted', (payload) => signals.push(['steer-accepted', payload]))
    return { store, engine, events, signals }
  }

  const send = (engine: RunEngine, threadId: string, clientRequestId: string) =>
    engine.dispatch({ kind: 'send', threadId, clientRequestId, source: 'gui' })

  it('accepts a send as a queued run with a receipt and emits its events', async () => {
    const { store, engine, events } = open()
    const result = await send(engine, 't1', 'req-1')
    expect(result).toEqual({
      status: 'accepted',
      runId: 'run:thread:t1:ordinal:1',
      sequence: 1,
      replayed: false
    })
    expect(store.getRun('run:thread:t1:ordinal:1')).toMatchObject({
      status: 'queued',
      source: 'gui',
      clientRequestId: 'req-1'
    })
    expect(store.getReceipt('req-1')).toMatchObject({
      threadId: 't1',
      commandKind: 'send',
      status: 'accepted',
      result: { runId: 'run:thread:t1:ordinal:1', sequence: 1 }
    })
    expect(events.map((event) => [event.seq, event.type])).toEqual([[1, 'run.created']])
  })

  it('replays a duplicate clientRequestId without writing anything', async () => {
    const { store, engine, events } = open()
    const first = await send(engine, 't1', 'req-1')
    const again = await send(engine, 't1', 'req-1')
    expect(again).toEqual({ ...first, replayed: true })
    expect(store.listRuns('t1')).toHaveLength(1)
    expect(store.maxSeq('t1')).toBe(1)
    expect(events).toHaveLength(1)
  })

  it('rejects a clientRequestId reused on another thread without a receipt', async () => {
    const { store, engine } = open()
    await send(engine, 't1', 'req-1')
    const result = await send(engine, 't2', 'req-1')
    expect(result).toEqual({ status: 'rejected', reason: 'client_request_id_conflict', sequence: 0 })
    expect(store.getReceipt('req-1')!.threadId).toBe('t1')
    expect(store.listRuns('t2')).toEqual([])
  })

  it('rejects a clientRequestId reused for another command kind on the same thread (M10)', async () => {
    const { store, engine } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const stop = await engine.dispatch({ kind: 'stop', threadId: 't1', clientRequestId: 'req-1', runId: sent.runId })
    expect(stop).toMatchObject({ status: 'rejected', reason: 'client_request_id_conflict' })
    expect(store.getRun(sent.runId)!.outcome?.stopRequested).toBeUndefined()
    expect(store.getReceipt('req-1')!.commandKind).toBe('send')
    // The same kind still replays.
    expect(await send(engine, 't1', 'req-1')).toMatchObject({ status: 'accepted', runId: sent.runId, replayed: true })
  })

  it('rejects a stale expectedSequence without a receipt', async () => {
    const { store, engine } = open()
    await send(engine, 't1', 'req-1')
    const stale = await engine.dispatch(
      { kind: 'send', threadId: 't1', clientRequestId: 'req-2', source: 'gui' },
      { expectedSequence: 0 }
    )
    expect(stale).toEqual({ status: 'rejected', reason: 'stale_sequence', sequence: 1 })
    expect(store.getReceipt('req-2')).toBeNull()
    const fresh = await engine.dispatch(
      { kind: 'send', threadId: 't1', clientRequestId: 'req-2', source: 'gui' },
      { expectedSequence: 1 }
    )
    expect(fresh.status).toBe('accepted')
  })

  it('writes no receipt and no rows when the commit fails', async () => {
    let failCommit = false
    const { store, engine } = open((point) => {
      if (failCommit && point === 'transaction.beforeCommit') throw new Error('injected')
    })
    failCommit = true
    await expect(send(engine, 't1', 'req-1')).rejects.toThrow('injected')
    failCommit = false
    expect(store.getReceipt('req-1')).toBeNull()
    expect(store.listRuns('t1')).toEqual([])
    expect(store.maxSeq('t1')).toBe(0)
  })

  it('ignores a stop for a run that is not active and records command.ignored', async () => {
    const { store, engine, signals } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const result = await engine.dispatch({
      kind: 'stop',
      threadId: 't1',
      clientRequestId: 'stop-1',
      runId: sent.runId
    })
    expect(result).toEqual({
      status: 'ignored',
      reason: 'run_not_active',
      runId: sent.runId,
      activeRunId: null,
      sequence: 2
    })
    const ignored = store.listEvents('t1').at(-1)!
    expect(ignored).toMatchObject({
      type: 'command.ignored',
      runId: sent.runId,
      payload: { kind: 'stop', runId: sent.runId, activeRunId: null, reason: 'run_not_active' }
    })
    expect(store.getReceipt('stop-1')!.status).toBe('ignored')
    expect(signals).toEqual([])
    const replay = await engine.dispatch({
      kind: 'stop',
      threadId: 't1',
      clientRequestId: 'stop-1',
      runId: sent.runId
    })
    expect(replay).toEqual({ ...result, replayed: true })
    expect(store.maxSeq('t1')).toBe(2)
  })

  it('accepts a stop for the active run by flagging stopRequested under CAS', async () => {
    const { store, engine, signals } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    const running = engine.markRunning(sent.runId)
    const result = await engine.dispatch({
      kind: 'stop',
      threadId: 't1',
      clientRequestId: 'stop-1',
      runId: sent.runId
    })
    expect(result).toMatchObject({ status: 'accepted', runId: sent.runId, replayed: false })
    const stopped = store.getRun(sent.runId)!
    expect(stopped.status).toBe('running')
    expect(stopped.outcome).toEqual({ stopRequested: true })
    expect(stopped.epoch).toBe(running.epoch + 1)
    expect(signals).toEqual([['stop-requested', { threadId: 't1', runId: sent.runId }]])
    // The bridge's own stop does not make its next mark stale.
    const terminal = engine.markTerminal(sent.runId, 'interrupted', { interruptedBy: 'user' })
    expect(terminal.outcome).toEqual({ interruptedBy: 'user', stopRequested: true })
  })

  it('accepts a steer for the active run and emits steer-accepted', async () => {
    const { engine, signals } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    const result = await engine.dispatch({
      kind: 'steer',
      threadId: 't1',
      clientRequestId: 'steer-1',
      runId: sent.runId
    })
    expect(result).toMatchObject({ status: 'accepted', runId: sent.runId })
    expect(signals).toEqual([['steer-accepted', { threadId: 't1', runId: sent.runId }]])
  })

  it('advances a run through the mark hooks with run.status events in order', async () => {
    const { store, engine, events } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const starting = engine.markStarting(sent.runId)
    expect(starting.startedAt).not.toBeNull()
    expect(starting.activeAttemptId).toBe(`attempt:${sent.runId}:1`)
    engine.markRunning(sent.runId)
    engine.markFinalizing(sent.runId)
    const done = engine.markTerminal(sent.runId, 'completed')
    expect(done).toMatchObject({ status: 'completed', epoch: 4 })
    expect(done.completedAt).not.toBeNull()
    expect(store.getAttempt(done.activeAttemptId!)).toMatchObject({
      reason: 'initial',
      status: 'completed'
    })
    const statuses = events
      .filter((event) => event.type === 'run.status')
      .map((event) => (event.payload as { status: string }).status)
    expect(statuses).toEqual(['starting', 'running', 'finalizing', 'completed'])
    expect(events.map((event) => event.type)).toEqual([
      'run.created',
      'attempt.created',
      'run.status',
      'run.status',
      'attempt.status',
      'run.status',
      'run.status',
      'attempt.status'
    ])
    expect(events.map((event) => event.seq)).toEqual(store.listEvents('t1').map((e) => e.seq))
    // Terminal states are final: a second terminal write is a bad request.
    expect(codeOf(() => engine.markTerminal(sent.runId, 'failed'))).toBe('bad_request')
  })

  it('refuses out-of-order marks and writes by another writer as stale', async () => {
    const { store, engine } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    expect(codeOf(() => engine.markRunning(sent.runId))).toBe('bad_request')
    const starting = engine.markStarting(sent.runId)
    store.casRunOutcome({
      runId: sent.runId,
      expectedEpoch: starting.epoch,
      outcomePatch: { error: 'someone else' }
    })
    expect(codeOf(() => engine.markRunning(sent.runId))).toBe('stale_write')
  })

  it('records the provider ref on the active attempt without bumping the run epoch', async () => {
    const { store, engine, events } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    expect(codeOf(() => engine.recordProviderRef(sent.runId, { provider: 'openai' }))).toBe(
      'bad_request'
    )
    engine.markStarting(sent.runId)
    const running = engine.markRunning(sent.runId)
    const attempt = engine.recordProviderRef(sent.runId, { provider: 'openai', model: 'gpt' })
    expect(attempt).toMatchObject({ status: 'running', providerRef: { provider: 'openai', model: 'gpt' } })
    expect(store.getAttempt(running.activeAttemptId!)?.providerRef).toEqual({
      provider: 'openai',
      model: 'gpt'
    })
    expect(store.getRun(sent.runId)?.epoch).toBe(running.epoch)
    expect(events.at(-1)?.type).toBe('attempt.status')
    // Later marks still CAS against the same epoch.
    expect(engine.markFinalizing(sent.runId).status).toBe('finalizing')
    engine.markTerminal(sent.runId, 'completed')
    expect(codeOf(() => engine.recordProviderRef(sent.runId, { provider: 'openai' }))).toBe(
      'bad_request'
    )
  })

  it('refuses a provider ref when another writer moved the run', async () => {
    const { store, engine } = open()
    const sent = await send(engine, 't1', 'req-1')
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    const running = engine.markRunning(sent.runId)
    store.casRunOutcome({
      runId: sent.runId,
      expectedEpoch: running.epoch,
      outcomePatch: { error: 'someone else' }
    })
    expect(codeOf(() => engine.recordProviderRef(sent.runId, { provider: 'openai' }))).toBe(
      'stale_write'
    )
  })
  describe('continuations (SPEC §16.4)', () => {
    /** An ended (or still active) run on `threadId`, left in `status`. */
    const runAt = async (engine: RunEngine, threadId: string, key: string, status: 'queued' | 'running' | 'completed' | 'uncertain') => {
      const sent = await send(engine, threadId, key)
      if (sent.status !== 'accepted') throw new Error('send rejected')
      if (status === 'queued') return sent.runId
      engine.markStarting(sent.runId)
      engine.markRunning(sent.runId)
      if (status === 'completed') engine.markTerminal(sent.runId, 'completed')
      if (status === 'uncertain') engine.markTerminal(sent.runId, 'uncertain', { uncertainReason: 'non_idempotent_tool_in_flight' })
      return sent.runId
    }
    const continueFrom = (engine: RunEngine, threadId: string, from: string, extra: { acknowledgeUncertain?: boolean } = {}) =>
      engine.dispatch({ kind: 'send', threadId, clientRequestId: `continue:${from}`, source: 'gui', continuationOfRunId: from, ...extra })

    it.each([
      ['an unknown run', async () => 'run:missing', 'continuation_not_found'],
      ['a run of another thread', async (engine: RunEngine) => runAt(engine, 'other', 'req-other', 'completed'), 'continuation_not_found'],
      ['a queued run', async (engine: RunEngine) => runAt(engine, 't', 'req-queued', 'queued'), 'continuation_source_active'],
      ['a running run', async (engine: RunEngine) => runAt(engine, 't', 'req-running', 'running'), 'continuation_source_active'],
      ['an uncertain run that is not acknowledged', async (engine: RunEngine) => runAt(engine, 't', 'req-uncertain', 'uncertain'), 'uncertain_not_acknowledged']
    ])('refuses to continue %s and stores neither a run nor a receipt', async (_title, source, reason) => {
      const { store, engine } = open()
      const from = await source(engine)
      const before = store.listRuns('t').length
      const result = await continueFrom(engine, 't', from)
      expect(result).toMatchObject({ status: 'rejected', reason })
      expect(store.listRuns('t')).toHaveLength(before)
      expect(store.getReceipt(`continue:${from}`)).toBeNull()
    })

    it('accepts a continuation of a completed run, or of an uncertain run once acknowledged, and records its source', async () => {
      const { store, engine } = open()
      const completed = await runAt(engine, 't', 'req-done', 'completed')
      const first = await continueFrom(engine, 't', completed)
      if (first.status !== 'accepted') throw new Error(`continuation refused: ${JSON.stringify(first)}`)
      expect(store.getRun(first.runId)).toMatchObject({ outcome: { continuationOf: completed } })
      const uncertain = await runAt(engine, 'u', 'req-cut', 'uncertain')
      const second = await continueFrom(engine, 'u', uncertain, { acknowledgeUncertain: true })
      if (second.status !== 'accepted') throw new Error(`acknowledged continuation refused: ${JSON.stringify(second)}`)
      expect(store.getRun(second.runId)).toMatchObject({ outcome: { continuationOf: uncertain } })
    })
  })

  describe('takeRestartNote (SPEC §12.5)', () => {
    const note = (epoch: number) => ({ runIds: [`run:old-${epoch}`], uncertainRunIds: [], cutOffTools: [], epoch })
    const record = (store: RunStore, epoch: number) => store.appendEvent({ threadId: 't', type: 'restart.note', payload: note(epoch) })

    it('hands out the latest note once, records its delivery and reports none afterwards', () => {
      const { store, engine } = open()
      expect(engine.takeRestartNote('t')).toBeNull()
      record(store, 1); record(store, 2)
      expect(engine.takeRestartNote('t')).toEqual(note(2))
      expect(store.listEvents('t').filter((event) => event.type === 'restart.note.delivered')).toHaveLength(1)
      expect(engine.takeRestartNote('t')).toBeNull()
      record(store, 3)
      expect(engine.takeRestartNote('t')).toEqual(note(3))
    })

    it('does not count the starting run as having moved past the note, but any other run that started after it', async () => {
      const { store, engine } = open()
      record(store, 1)
      const current = await send(engine, 't', 'req-current')
      if (current.status !== 'accepted') throw new Error('send rejected')
      engine.markStarting(current.runId)
      // Another run started after the note: the thread moved on, so the note is stale for a run that starts later.
      expect(engine.takeRestartNote('t', 'run:thread:t:ordinal:99')).toBeNull()
      expect(store.listEvents('t').filter((event) => event.type === 'restart.note.delivered')).toEqual([])
      // The run that is starting now is not "another run": it receives the note and owns the delivery event.
      expect(engine.takeRestartNote('t', current.runId)).toEqual(note(1))
      expect(store.listEvents('t').find((event) => event.type === 'restart.note.delivered')).toMatchObject({ runId: current.runId })
    })
  })

})

describe('RunEngine.runLocalAction (SPEC §16.3)', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  /** A real clock: the local action's heartbeat timer and the reconciler race in wall time. */
  const setup = (heartbeatMs: number) => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-local-action-'))
    db = new ProfileDatabase({ profileHome })
    const store = new RunStore(db)
    const engine = new RunEngine({ store, heartbeatMs })
    const reconciler = new Reconciler({ store, outbox: engine.outbox, tools: engine.tools, heartbeatMs })
    return { store, engine, reconciler }
  }

  it('heartbeats through an action three heartbeat intervals long and completes', async () => {
    const heartbeatMs = 40
    const { engine, reconciler } = setup(heartbeatMs)
    const stale: string[] = []
    const pass = setInterval(() => stale.push(...reconciler.runOnce().staleRuns), 10)
    try {
      const { runId, result } = await engine.runLocalAction({ threadId: 't', source: 'undo' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 3 * heartbeatMs))
        return 'restored'
      })
      expect(result).toBe('restored')
      expect(stale).toEqual([])
      expect(engine.getRun(runId)!.status).toBe('completed')
    } finally {
      clearInterval(pass)
    }
  })

  it('keeps a terminal state something else wrote while the action ran', async () => {
    const { engine } = setup(10_000)
    const { runId, result } = await engine.runLocalAction({ threadId: 't', source: 'revert' }, async (run) => {
      engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'provider', error: 'no terminal event' })
      return 'done'
    })
    expect(result).toBe('done')
    expect(engine.getRun(runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'provider' } })
    // A failing action whose run already ended still rethrows its own error.
    await expect(
      engine.runLocalAction({ threadId: 't', source: 'undo' }, async (run) => {
        engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'provider' })
        throw new Error('git failed')
      })
    ).rejects.toThrow('git failed')
  })

  it('runs the gate under the thread mutex before the run exists; a gated action creates no run (M6)', async () => {
    const { engine } = setup(10_000)
    const order: string[] = []
    const gated = engine.runLocalAction({ threadId: 't', source: 'undo' }, async () => 'never', {
      gate: () => {
        order.push('gate')
        // A send racing the gate waits for the mutex: it cannot start a run in between.
        void engine.dispatch({ kind: 'send', threadId: 't', clientRequestId: 'racing-send', source: 'gui' }).then(() => order.push('send'))
        expect(engine.listRuns('t')).toEqual([])
        throw new LocalActionGated({ requiresReview: true })
      }
    })
    await expect(gated).rejects.toMatchObject({ value: { requiresReview: true } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['gate', 'send'])
    expect(engine.listRuns('t').map((run) => run.source)).toEqual(['gui'])
    // An ungated action records its outcome on the completed run.
    engine.markStarting(engine.listRuns('t')[0].runId)
    engine.markTerminal(engine.listRuns('t')[0].runId, 'completed')
    const { runId } = await engine.runLocalAction({ threadId: 't', source: 'undo' }, async () => 'ok', { gate: () => undefined, outcome: { undoStrategy: 'checkpoint' } })
    expect(engine.getRun(runId)).toMatchObject({ status: 'completed', outcome: { undoStrategy: 'checkpoint' } })
  })
})

function reasonOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    if (error instanceof CommandRejection) return error.reason
    if (error instanceof RunStoreError) return error.code
    throw error
  }
  return undefined
}

describe('RunEngine pause (SPEC §5)', () => {
  let f: DelegationFixture | undefined
  afterEach(() => {
    f?.dispose()
    f = undefined
  })

  /** The fixture clock starts at 2026-10-12T00:00:00Z; the limit resets an hour later. */
  const UNTIL = '2026-10-12T01:00:00.000Z'
  const pauseOf = (overrides: Partial<RunPause> = {}): RunPause => ({
    reason: 'usage_limit',
    until: UNTIL,
    estimated: false,
    provider: 'claude',
    limitKind: 'five_hour',
    count: 1,
    autoResume: true,
    ...overrides
  })
  const fixture = (): DelegationFixture => (f = delegationFixture())
  /** A run in `running` on `threadId`, paused with a `run.resume` timer at `UNTIL`. */
  const paused = async (threadId = 't1') => {
    const run = await f!.runningRun(threadId)
    return f!.engine.pauseRun({ runId: run.runId, pause: pauseOf(), resumeAt: UNTIL })
  }
  const resumeEffects = (runId: string) => f!.outbox.listForRun(runId).filter((effect) => effect.kind === 'run.resume')
  const sendFrom = (threadId: string, clientRequestId: string, source: string, continuationOfRunId?: string) =>
    f!.engine.dispatch({ kind: 'send', threadId, clientRequestId, source, ...(continuationOfRunId ? { continuationOfRunId } : {}) })

  it('pauseRun moves a running run to paused with its attempt interrupted and a timer at the reset', async () => {
    fixture()
    const run = await f!.runningRun('t1')
    const next = f!.engine.pauseRun({ runId: run.runId, pause: pauseOf(), resumeAt: UNTIL })

    expect(next).toMatchObject({ status: 'paused', epoch: run.epoch + 1, outcome: { pause: pauseOf() } })
    expect(f!.store.getAttempt(next.activeAttemptId!)).toMatchObject({ status: 'interrupted' })
    expect(f!.store.getPausedRun('t1')).toEqual(next)
    // Paused is not active: the thread takes a person's message, and the run is not terminal.
    expect(f!.store.getActiveRun('t1')).toBeNull()
    expect(next.completedAt).toBeNull()
    const [timer] = resumeEffects(run.runId)
    expect(timer).toMatchObject({
      effectId: `effect:${run.runId}:run.resume:1`,
      class: 'replay_safe',
      status: 'pending',
      availableAt: UNTIL,
      payload: { kind: 'resume', runId: run.runId, threadId: 't1', until: UNTIL } satisfies RunResumePayload
    })
    expect(f!.store.listEvents('t1').filter((event) => event.type === 'run.status').at(-1)!.payload).toMatchObject({ status: 'paused' })
  })

  it('pauseRun arms no timer without resumeAt, and works from finalizing', async () => {
    fixture()
    const run = await f!.runningRun('t1')
    f!.engine.markFinalizing(run.runId)
    const next = f!.engine.pauseRun({ runId: run.runId, pause: pauseOf({ autoResume: false }) })
    expect(next.status).toBe('paused')
    expect(resumeEffects(run.runId)).toEqual([])
  })

  it('pauseRun is refused for a run being stopped, and changes nothing', async () => {
    fixture()
    const run = await f!.runningRun('t1')
    const stop = await f!.engine.dispatch({ kind: 'stop', threadId: 't1', clientRequestId: 'stop-1', runId: run.runId })
    expect(stop.status).toBe('accepted')

    expect(reasonOf(() => f!.engine.pauseRun({ runId: run.runId, pause: pauseOf(), resumeAt: UNTIL }))).toBe('bad_request')

    expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'running', outcome: { stopRequested: true } })
    expect(resumeEffects(run.runId)).toEqual([])
    expect(f!.store.getAttempt(f!.store.getRun(run.runId)!.activeAttemptId!)).toMatchObject({ status: 'running' })
  })

  it('pauseRun is refused for a run that is not running, or on a thread that is already paused', async () => {
    fixture()
    const queued = await sendFrom('t1', 'send-1', 'gui')
    if (queued.status !== 'accepted') throw new Error('send rejected')
    expect(reasonOf(() => f!.engine.pauseRun({ runId: queued.runId, pause: pauseOf() }))).toBe('bad_request')
    f!.engine.markStarting(queued.runId)
    f!.engine.markRunning(queued.runId)
    f!.engine.pauseRun({ runId: queued.runId, pause: pauseOf() })
    // A second run cannot be paused beside the first: `getPausedRun` allows one per thread.
    const other = f!.store.createRun({ threadId: 't1', source: 'gui' })
    f!.store.casRunStatus({ runId: other.runId, expectedEpoch: 0, status: 'running' })
    expect(reasonOf(() => f!.engine.pauseRun({ runId: other.runId, pause: pauseOf() }))).toBe('conflict')
  })

  it('markTerminal refuses a paused run: a pause ends only through endPause, so its timer cannot be left behind', async () => {
    fixture()
    const run = await paused()
    for (const status of ['failed', 'cancelled', 'interrupted', 'completed'] as const)
      expect(reasonOf(() => f!.engine.markTerminal(run.runId, status))).toBe('conflict')
    expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'paused', epoch: run.epoch })
    expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['pending'])

    // The way out keeps working, and the later run's Resume now is not held up by a dead timer.
    f!.engine.endPause(run.runId, 'cancel')
    const next = await f!.runningRun('t1')
    f!.engine.pauseRun({ runId: next.runId, pause: pauseOf(), resumeAt: '2026-10-12T05:00:00.000Z' })
    const manual = f!.engine.requestResume(next.runId, true)
    expect(f!.outbox.claimNext('o', f!.now())!.effectId).toBe(manual.effectId)
  })

  it('pauseRun cancels a pending timer left on the thread by a run that is not paused', async () => {
    fixture()
    const first = await f!.runningRun('t1')
    f!.engine.markTerminal(first.runId, 'failed')
    // Whatever left it (a bug, an older build), it would hold up the resume lane for hours.
    const dead = f!.outbox.enqueue({ threadId: 't1', runId: first.runId, kind: 'run.resume', availableAt: '2026-10-12T05:00:00.000Z' })
    const second = await f!.runningRun('t1')
    f!.engine.pauseRun({ runId: second.runId, pause: pauseOf(), resumeAt: UNTIL })

    expect(f!.outbox.get(dead.effectId)).toMatchObject({ status: 'cancelled', lastError: 'run_not_paused' })
    expect(resumeEffects(second.runId).map((effect) => effect.status)).toEqual(['pending'])
  })

  describe('requestResume', () => {
    it('replaces the pending timer with one available now that is marked manual', async () => {
      fixture()
      const run = await paused()
      const [timer] = resumeEffects(run.runId)

      const effect = f!.engine.requestResume(run.runId, true)

      expect(f!.outbox.get(timer.effectId)).toMatchObject({ status: 'cancelled', lastError: 'resume_requested' })
      expect(effect).toMatchObject({
        effectId: `effect:${run.runId}:run.resume:2`,
        status: 'pending',
        availableAt: f!.now(),
        payload: { kind: 'resume', runId: run.runId, until: UNTIL, manual: true }
      })
      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
    })

    it('a second press returns the manual effect and writes nothing', async () => {
      fixture()
      const run = await paused()
      const first = f!.engine.requestResume(run.runId, true)
      const effects = f!.store.db.statement('SELECT COUNT(*) AS n FROM effects').get()!.n
      expect(f!.engine.requestResume(run.runId, true)).toEqual(first)
      expect(f!.store.db.statement('SELECT COUNT(*) AS n FROM effects').get()!.n).toBe(effects)
    })

    it('queues a manual timer behind an automatic one that is running: the press is not absorbed', async () => {
      fixture()
      const run = await paused()
      f!.advance(61 * 60_000)
      const claimed = f!.outbox.claimNext('owner', f!.now())
      expect(claimed).toMatchObject({ kind: 'run.resume', status: 'running' })

      const effect = f!.engine.requestResume(run.runId, true)

      expect(effect).toMatchObject({ status: 'pending', payload: { manual: true } })
      expect(effect.effectId).not.toBe(claimed!.effectId)
      expect(f!.outbox.get(claimed!.effectId)!.status).toBe('running')
      expect(resumeEffects(run.runId)).toHaveLength(2)
      // The resume lane is first-in, first-out: the manual one is claimable once the running one settles.
      expect(f!.outbox.claimNext('owner-2', f!.now())).toBeNull()
      f!.outbox.succeed(claimed!.effectId, 'owner', f!.now())
      expect(f!.outbox.claimNext('owner-2', f!.now())!.effectId).toBe(effect.effectId)
    })

    it('a Resume now press is not lost when the running automatic timer rules the pause stale', async () => {
      fixture()
      const run = await paused()
      f!.advance(3 * 24 * 60 * 60_000)
      const claimed = f!.outbox.claimNext('owner', f!.now())!
      const manual = f!.engine.requestResume(run.runId, true)

      // The running executor drops its own (automatic) timer as stale; the press stays queued.
      f!.engine.endPause(run.runId, 'stale')
      f!.outbox.succeed(claimed.effectId, 'owner', f!.now())

      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
      expect(f!.outbox.get(manual.effectId)!.status).toBe('pending')
      expect(f!.outbox.claimNext('owner-2', f!.now())!.effectId).toBe(manual.effectId)
    })

    it('leaves a manual timer that is already running alone and returns it', async () => {
      fixture()
      const run = await paused()
      const manual = f!.engine.requestResume(run.runId, true)
      const claimed = f!.outbox.claimNext('owner', f!.now())
      expect(claimed!.effectId).toBe(manual.effectId)

      expect(f!.engine.requestResume(run.runId, true)).toMatchObject({ effectId: manual.effectId, status: 'running' })
      // The automatic timer the first press replaced is the only other one, and it is cancelled.
      expect(resumeEffects(run.runId).map((effect) => effect.status).sort()).toEqual(['cancelled', 'running'])
    })

    it('an automatic request leaves a running timer alone', async () => {
      fixture()
      const run = await paused()
      f!.advance(61 * 60_000)
      const claimed = f!.outbox.claimNext('owner', f!.now())!
      expect(f!.engine.requestResume(run.runId, false)).toMatchObject({ effectId: claimed.effectId, status: 'running' })
      expect(resumeEffects(run.runId)).toHaveLength(1)
    })

    it('works on a stale pause and is refused with a conflict on a run that is not paused', async () => {
      fixture()
      const run = await paused()
      f!.engine.endPause(run.runId, 'stale')
      expect(f!.engine.requestResume(run.runId, true).status).toBe('pending')

      f!.engine.endPause(run.runId, 'cancel')
      expect(reasonOf(() => f!.engine.requestResume(run.runId, true))).toBe('conflict')
      const running = await f!.runningRun('t2')
      expect(reasonOf(() => f!.engine.requestResume(running.runId, true))).toBe('conflict')
      expect(reasonOf(() => f!.engine.requestResume('run:missing', false))).toBe('conflict')
    })
  })

  describe('endPause', () => {
    const cases: Array<[RunPauseEnd, 'cancelled' | 'interrupted', 'user' | 'provider']> = [
      ['user_message', 'cancelled', 'user'],
      ['cancel', 'cancelled', 'user'],
      ['stop', 'cancelled', 'user'],
      ['deleted', 'cancelled', 'user'],
      ['resume', 'interrupted', 'provider'],
      ['resume_now', 'interrupted', 'provider']
    ]
    it.each(cases)('%s ends the run %s (interrupted by %s) and cancels only a pending timer', async (endedBy, status, interruptedBy) => {
      fixture()
      const run = await paused()
      const [timer] = resumeEffects(run.runId)

      const ended = f!.engine.endPause(run.runId, endedBy)

      expect(ended).toMatchObject({ status, outcome: { interruptedBy, pause: { ...pauseOf(), endedBy } } })
      if (status === 'cancelled') expect(ended.outcome!.error).toBe('Paused by a usage limit; cancelled.')
      else expect(ended.outcome!.error).toBeUndefined()
      expect(ended.completedAt).not.toBeNull()
      expect(f!.outbox.get(timer.effectId)).toMatchObject({ status: 'cancelled', lastError: endedBy })
      expect(f!.store.getPausedRun('t1')).toBeNull()
      expect(f!.store.getAttempt(ended.activeAttemptId!)).toMatchObject({ status: 'interrupted' })
    })

    it('never cancels a timer that is running: its executor settles itself', async () => {
      fixture()
      const run = await paused()
      f!.advance(61 * 60_000)
      const claimed = f!.outbox.claimNext('owner', f!.now())!

      f!.engine.endPause(run.runId, 'user_message')

      expect(f!.outbox.get(claimed.effectId)).toMatchObject({ status: 'running' })
    })

    it('stale is not an end: the run stays paused with its automatic timer dropped and endedBy unset', async () => {
      fixture()
      const run = await paused()
      const ended = f!.engine.endPause(run.runId, 'stale')
      expect(ended).toMatchObject({ status: 'paused', outcome: { pause: { ...pauseOf(), autoResume: false, stale: true } } })
      expect(ended.outcome!.pause!.endedBy).toBeUndefined()
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['cancelled'])
      // Resume now still works, and ends it as any resume does.
      expect(f!.engine.requestResume(run.runId, true)).toMatchObject({ status: 'pending', payload: { manual: true } })
    })

    it('stale keeps a Resume now that is already queued', async () => {
      fixture()
      const run = await paused()
      const manual = f!.engine.requestResume(run.runId, true)
      f!.engine.endPause(run.runId, 'stale')
      expect(f!.outbox.get(manual.effectId)!.status).toBe('pending')
    })

    it('is refused with a conflict once the pause has ended', async () => {
      fixture()
      const run = await paused()
      f!.engine.endPause(run.runId, 'cancel')
      expect(reasonOf(() => f!.engine.endPause(run.runId, 'cancel'))).toBe('conflict')
      expect(reasonOf(() => f!.engine.endPause('run:missing', 'cancel'))).toBe('conflict')
    })

    it('updatePause patches a paused run only', async () => {
      fixture()
      const run = await paused()
      const next = f!.engine.updatePause(run.runId, { resumeItemId: `resume:${run.runId}`, resumeRequested: 'auto' })
      expect(next.outcome!.pause).toMatchObject({ resumeItemId: `resume:${run.runId}`, resumeRequested: 'auto', until: UNTIL })
      f!.engine.endPause(run.runId, 'cancel')
      expect(reasonOf(() => f!.engine.updatePause(run.runId, { autoResume: false }))).toBe('conflict')
    })
  })

  describe('a send on a paused thread', () => {
    it("a person's message creates its run, then ends the pause in the same transaction", async () => {
      fixture()
      const run = await paused()
      const item = f!.engine.updatePause(run.runId, { resumeItemId: `resume:${run.runId}` })
      expect(item.outcome!.pause!.resumeItemId).toBe(`resume:${run.runId}`)

      const sent = await sendFrom('t1', 'message-1', 'gui')

      expect(sent).toEqual({
        status: 'accepted',
        runId: 'run:thread:t1:ordinal:2',
        sequence: expect.any(Number),
        replayed: false,
        endedPause: { runId: run.runId, resumeItemId: `resume:${run.runId}` }
      })
      expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'user_message' } } })
      expect(f!.store.getRun(sent.status === 'accepted' ? sent.runId : '')).toMatchObject({ status: 'queued', source: 'gui' })
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['cancelled'])
      // A retry replays the receipt, endedPause included, and writes nothing.
      expect(await sendFrom('t1', 'message-1', 'gui')).toEqual({ ...sent, replayed: true })
    })

    it('a scheduled send is refused thread_paused and writes nothing: the pause, its timer and its chain stay', async () => {
      fixture()
      const run = await paused()

      const sent = await sendFrom('t1', 'schedule:job:1', 'schedule')

      expect(sent).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['pending'])
      expect(f!.store.getReceipt('schedule:job:1')).toBeNull()
      expect(f!.store.listRuns('t1')).toHaveLength(1)
    })

    it('a subagent keeps its task running across the hand-over', async () => {
      fixture()
      const parent = await f!.runningRun('parent')
      const task = await f!.delegate(parent.runId, 'call-1')
      f!.engine.markStarting(task.childRunId)
      f!.engine.markRunning(task.childRunId)
      f!.engine.pauseRun({ runId: task.childRunId, pause: pauseOf(), resumeAt: UNTIL })
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('running')

      await sendFrom('child-1', 'follow-up', 'gui')

      expect(f!.store.getRun(task.childRunId)!.status).toBe('cancelled')
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('running')
    })

    it('the continue turn records what it continues, ends the pause as a hand-over and cancels the timer', async () => {
      fixture()
      const run = await paused()
      const sent = await sendFrom('t1', 'queue:resume:1', 'resume', run.runId)
      if (sent.status !== 'accepted') throw new Error(`rejected: ${sent.reason}`)

      expect(sent.endedPause).toEqual({ runId: run.runId })
      expect(f!.store.getRun(sent.runId)).toMatchObject({
        status: 'queued',
        source: 'resume',
        outcome: { continuationOf: run.runId, resumedFromPause: 'auto' }
      })
      expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'provider', pause: { endedBy: 'resume' } } })
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['cancelled'])
      // A repeated `queue:resume:<runId>` is a replay: one continuation.
      expect(await sendFrom('t1', 'queue:resume:1', 'resume', run.runId)).toEqual({ ...sent, replayed: true })
      expect(f!.store.listRuns('t1')).toHaveLength(2)
    })

    it('Resume now records that a person resumed', async () => {
      fixture()
      const run = await paused()
      const sent = await sendFrom('t1', 'queue:resume:now', 'resume_now', run.runId)
      if (sent.status !== 'accepted') throw new Error(`rejected: ${sent.reason}`)
      expect(f!.store.getRun(sent.runId)!.outcome).toEqual({ continuationOf: run.runId, resumedFromPause: 'user' })
      expect(f!.store.getRun(run.runId)!.outcome!.pause!.endedBy).toBe('resume_now')
    })

    it('a continue turn after the pause ended is rejected pause_ended and creates nothing', async () => {
      fixture()
      const run = await paused()
      await sendFrom('t1', 'message-1', 'gui')
      const runs = f!.store.listRuns('t1').length

      expect(await sendFrom('t1', 'queue:resume:late', 'resume', run.runId)).toMatchObject({ status: 'rejected', reason: 'pause_ended' })
      expect(f!.store.listRuns('t1')).toHaveLength(runs)
      expect(f!.store.getReceipt('queue:resume:late')).toBeNull()
    })

    it('a continue turn must name the paused run', async () => {
      fixture()
      const run = await paused()
      expect(await sendFrom('t1', 'resume-a', 'resume')).toMatchObject({ status: 'rejected', reason: 'pause_ended' })
      expect(await sendFrom('t1', 'resume-b', 'resume', 'run:thread:t1:ordinal:9')).toMatchObject({ status: 'rejected', reason: 'pause_ended' })
      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
    })

    it('only a continue turn may name a paused run as the run it continues', async () => {
      fixture()
      const run = await paused()
      expect(await sendFrom('t1', 'continue-1', 'gui', run.runId)).toMatchObject({ status: 'rejected', reason: 'continuation_source_active' })
      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
    })

    it.each(['wake', 'provider-continuation', 'integration', 'steer-late'])('work started by %s is rejected thread_paused and leaves the pause and its timer intact', async (source) => {
      fixture()
      const run = await paused()
      const before = f!.store.maxSeq('t1')

      expect(await sendFrom('t1', `${source}-1`, source)).toMatchObject({ status: 'rejected', reason: 'thread_paused' })

      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['pending'])
      expect(f!.store.listRuns('t1')).toHaveLength(1)
      expect(f!.store.maxSeq('t1')).toBe(before)
    })

    it("a parent's continue_subagent on a paused subagent waits: thread_paused, the count chain survives", async () => {
      fixture()
      const parent = await f!.runningRun('parent')
      const task = await f!.delegate(parent.runId, 'call-1')
      f!.engine.markStarting(task.childRunId)
      f!.engine.markRunning(task.childRunId)
      f!.engine.pauseRun({ runId: task.childRunId, pause: pauseOf(), resumeAt: UNTIL })

      const result = await f!.engine.dispatch({
        kind: 'send',
        threadId: 'child-1',
        clientRequestId: 'delegation:follow-up',
        source: 'delegation',
        delegation: { parentThreadId: 'parent', parentRunId: parent.runId, prompt: 'More', wake: 'always' }
      })

      expect(result).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      expect(f!.store.getRun(task.childRunId)!.status).toBe('paused')
      expect(resumeEffects(task.childRunId).map((effect) => effect.status)).toEqual(['pending'])
      expect(f!.engine.delegations.listForChildThread('child-1')).toHaveLength(1)
    })
  })

  describe('markStarting on a paused thread', () => {
    it("a person's run that was queued before the pause ends it by starting", async () => {
      fixture()
      const first = await f!.runningRun('t1')
      const queued = await sendFrom('t1', 'message-2', 'gui')
      if (queued.status !== 'accepted') throw new Error('send rejected')
      f!.engine.pauseRun({ runId: first.runId, pause: pauseOf(), resumeAt: UNTIL })

      f!.engine.markStarting(queued.runId)

      expect(f!.store.getRun(first.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'user_message' } } })
      expect(f!.store.getRun(queued.runId)!.status).toBe('starting')
      expect(resumeEffects(first.runId).map((effect) => effect.status)).toEqual(['cancelled'])
    })

    it('a scheduled run (a webhook-triggered one too) is refused like work on the thread\'s behalf: it never ends a pause', async () => {
      fixture()
      const first = await f!.runningRun('t1')
      const scheduled = f!.store.createRun({ threadId: 't1', source: 'schedule' })
      f!.engine.pauseRun({ runId: first.runId, pause: pauseOf(), resumeAt: UNTIL })

      expect(reasonOf(() => f!.engine.markStarting(scheduled.runId))).toBe('conflict')

      expect(f!.store.getRun(scheduled.runId)!.status).toBe('queued')
      expect(f!.store.getRun(first.runId)!.status).toBe('paused')
      expect(resumeEffects(first.runId).map((effect) => effect.status)).toEqual(['pending'])
    })

    it('a run started on the thread\'s behalf is refused with a conflict and the pause and its timer stay', async () => {
      fixture()
      const first = await f!.runningRun('t1')
      const wake = f!.store.createRun({ threadId: 't1', source: 'wake' })
      f!.engine.pauseRun({ runId: first.runId, pause: pauseOf(), resumeAt: UNTIL })

      expect(reasonOf(() => f!.engine.markStarting(wake.runId))).toBe('conflict')

      expect(f!.store.getRun(wake.runId)!.status).toBe('queued')
      expect(f!.store.getRun(first.runId)!.status).toBe('paused')
      expect(resumeEffects(first.runId).map((effect) => effect.status)).toEqual(['pending'])
    })
  })

  describe('Stop', () => {
    it('a Stop after the continue turn was admitted cancels it, and the fence refuses it at execution', async () => {
      fixture()
      const run = await paused()
      const sent = await sendFrom('t1', 'queue:resume:1', 'resume', run.runId)
      if (sent.status !== 'accepted') throw new Error('send rejected')
      expect(f!.engine.isFenced(sent.runId)).toBe(false)

      const stopped = f!.engine.stopSubtree({ threadId: 't1', reason: 'user' })

      expect(stopped.cancelledRuns).toEqual([{ threadId: 't1', runId: sent.runId }])
      expect(f!.store.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
      expect(f!.engine.isFenced(sent.runId)).toBe(true)
    })

    it("a parent's Stop after its subagent's continue turn was admitted cancels that turn too", async () => {
      fixture()
      const parent = await f!.runningRun('parent')
      const task = await f!.delegate(parent.runId, 'call-1')
      f!.engine.markStarting(task.childRunId)
      f!.engine.markRunning(task.childRunId)
      f!.engine.pauseRun({ runId: task.childRunId, pause: pauseOf(), resumeAt: UNTIL })
      const sent = await sendFrom('child-1', 'queue:resume:child', 'resume_now', task.childRunId)
      if (sent.status !== 'accepted') throw new Error('send rejected')

      const stopped = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })

      expect(stopped.cancelledRuns).toEqual([{ threadId: 'child-1', runId: sent.runId }])
      expect(f!.store.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
      expect(f!.engine.isFenced(sent.runId)).toBe(true)
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('cancelled')
    })

    it('ends the paused run of the thread and cancels its timer', async () => {
      fixture()
      const run = await paused()
      const stopped = f!.engine.stopSubtree({ threadId: 't1', reason: 'user' })
      expect(stopped.status).toBe('stopped')
      expect(stopped.cancelledRuns).toEqual([{ threadId: 't1', runId: run.runId }])
      expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'stop' } } })
      expect(resumeEffects(run.runId).map((effect) => effect.status)).toEqual(['cancelled'])
    })

    it('leaves a timer a worker already claimed running; the run itself is cancelled', async () => {
      fixture()
      const run = await paused()
      f!.advance(61 * 60_000)
      const claimed = f!.outbox.claimNext('owner', f!.now())!
      expect(claimed).toMatchObject({ kind: 'run.resume' })

      f!.engine.stopSubtree({ threadId: 't1', reason: 'user' })

      expect(f!.outbox.get(claimed.effectId)).toMatchObject({ status: 'running' })
      expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'cancelled' })
    })

    it("a parent's Stop ends the pause of its subagent, cancels the task and the timer", async () => {
      fixture()
      const parent = await f!.runningRun('parent')
      const task = await f!.delegate(parent.runId, 'call-1')
      f!.engine.markStarting(task.childRunId)
      f!.engine.markRunning(task.childRunId)
      f!.engine.pauseRun({ runId: task.childRunId, pause: pauseOf(), resumeAt: UNTIL })

      const stopped = f!.engine.stopSubtree({ threadId: 'parent', reason: 'user' })

      expect(stopped.threads).toEqual(['parent', 'child-1'])
      expect(f!.store.getRun(task.childRunId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'stop' } } })
      expect(resumeEffects(task.childRunId).map((effect) => effect.status)).toEqual(['cancelled'])
      expect(f!.engine.delegations.get(task.delegationId)!.status).toBe('cancelled')
    })

    it('a Stop that names the paused run ends it, through a stop command and through stopSubtree', async () => {
      fixture()
      const run = await paused()
      const ignoredBefore = f!.store.listEvents('t1').filter((event) => event.type === 'command.ignored').length
      const stop = await f!.engine.dispatch({ kind: 'stop', threadId: 't1', clientRequestId: 'stop-1', runId: run.runId })
      expect(stop).toMatchObject({ status: 'accepted', runId: run.runId })
      expect(f!.store.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'stop' } } })
      expect(f!.store.getRun(run.runId)!.outcome!.stopRequested).toBeUndefined()
      expect(f!.store.listEvents('t1').filter((event) => event.type === 'command.ignored')).toHaveLength(ignoredBefore)

      const second = await paused('t2')
      const scoped = f!.engine.stopSubtree({ threadId: 't2', reason: 'user', runId: second.runId })
      expect(scoped.status).toBe('stopped')
      expect(f!.store.getRun(second.runId)!.status).toBe('cancelled')
    })

    it('task_cancel of a subagent with a paused run ends the pause and the timer', async () => {
      fixture()
      const parent = await f!.runningRun('parent')
      const task = await f!.delegate(parent.runId, 'call-1')
      f!.engine.markStarting(task.childRunId)
      f!.engine.markRunning(task.childRunId)
      f!.engine.pauseRun({ runId: task.childRunId, pause: pauseOf(), resumeAt: UNTIL })

      expect(await f!.engine.cancelDelegation(task.delegationId)).toEqual([task.delegationId])

      expect(f!.store.getRun(task.childRunId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'stop' } } })
      expect(resumeEffects(task.childRunId).map((effect) => effect.status)).toEqual(['cancelled'])
    })

    it('a steer for a paused run is ignored: only a message or a Stop reaches it', async () => {
      fixture()
      const run = await paused()
      const steer = await f!.engine.dispatch({ kind: 'steer', threadId: 't1', clientRequestId: 'steer-1', runId: run.runId })
      expect(steer).toMatchObject({ status: 'ignored', reason: 'run_not_active' })
      expect(f!.store.getRun(run.runId)!.status).toBe('paused')
    })
  })
})
