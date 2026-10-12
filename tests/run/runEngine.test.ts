import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { ThreadEvent } from '../../src/mms/run/types'

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

  it('interrupts active runs on boot and leaves queued runs alone', async () => {
    const { engine } = open()
    const a = await send(engine, 't1', 'req-a')
    const b = await send(engine, 't1', 'req-b')
    const c = await send(engine, 't2', 'req-c')
    if (a.status !== 'accepted' || b.status !== 'accepted' || c.status !== 'accepted')
      throw new Error('send rejected')
    engine.markStarting(a.runId)
    engine.markRunning(a.runId)
    engine.markStarting(c.runId)

    // A fresh engine on a fresh connection, as after a daemon restart.
    const store = new RunStore(openDb())
    const rebooted = new RunEngine({ store })
    const events: ThreadEvent[] = []
    rebooted.on('event', (event: ThreadEvent) => events.push(event))
    expect(rebooted.reconcileOnBoot()).toEqual({ interrupted: [a.runId, c.runId] })
    expect(store.getRun(a.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'daemon_restart' }
    })
    expect(store.getAttempt(store.getRun(a.runId)!.activeAttemptId!)!.status).toBe('interrupted')
    expect(store.getRun(c.runId)!.status).toBe('interrupted')
    expect(store.getRun(b.runId)!.status).toBe('queued')
    expect(events.filter((event) => event.type === 'run.status')).toHaveLength(2)
    expect(rebooted.reconcileOnBoot()).toEqual({ interrupted: [] })
  })
})
