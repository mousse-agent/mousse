import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { RunStore } from '../../src/mms/run/RunStore'
import { runId } from '../../src/mms/run/types'

function codeOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    if (error instanceof RunStoreError) return error.code
    throw error
  }
  return undefined
}

describe('RunStore', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const open = (): RunStore => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-run-store-'))
    let tick = Date.UTC(2026, 9, 12)
    db = new ProfileDatabase({ profileHome, clock: () => (tick += 1000) })
    return new RunStore(db)
  }

  it('assigns per-thread ordinals independently across threads', () => {
    const store = open()
    const a = [1, 2, 3].map(() => store.createRun({ threadId: 'thread/a', source: 'gui' }))
    const b = store.createRun({ threadId: 'thread-b', source: 'cli', clientRequestId: 'req-1' })
    expect(a.map((run) => run.ordinal)).toEqual([1, 2, 3])
    expect(a[0].runId).toBe('run:thread:thread%2Fa:ordinal:1')
    expect(a[0]).toMatchObject({ status: 'queued', epoch: 0, outcome: null })
    expect(b).toMatchObject({ ordinal: 1, runId: runId('thread-b', 1), clientRequestId: 'req-1' })
    expect(store.getRun(a[2].runId)).toEqual(a[2])
    expect(store.listRuns('thread/a').map((run) => run.ordinal)).toEqual([3, 2, 1])
    expect(store.listRuns('thread/a', { limit: 2 }).map((run) => run.ordinal)).toEqual([3, 2])
    const created = store.listEvents('thread/a')
    expect(created.map((event) => event.type)).toEqual([
      'run.created',
      'run.created',
      'run.created'
    ])
    expect(created[0].payload).toEqual(JSON.parse(JSON.stringify(a[0])))
  })

  it('advances status by CAS, bumping epoch and appending events in order', () => {
    const store = open()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    expect(attempt.attemptId).toBe(`attempt:${run.runId}:1`)
    expect(store.getRun(run.runId)!.activeAttemptId).toBe(attempt.attemptId)
    const starting = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'starting' })
    const running = store.casRunStatus({
      runId: run.runId,
      expectedEpoch: starting.epoch,
      status: 'running',
      patch: { startedAt: '2026-10-12T00:00:05.000Z' }
    })
    store.setAttemptStatus({
      attemptId: attempt.attemptId,
      status: 'running',
      providerRef: { provider: 'fake', model: 'm' }
    })
    const stopped = store.casRunOutcome({
      runId: run.runId,
      expectedEpoch: running.epoch,
      outcomePatch: { stopRequested: true }
    })
    const done = store.casRunStatus({
      runId: run.runId,
      expectedEpoch: stopped.epoch,
      status: 'interrupted',
      patch: { outcome: { ...stopped.outcome, interruptedBy: 'user' } }
    })
    expect([starting.epoch, running.epoch, stopped.epoch, done.epoch]).toEqual([1, 2, 3, 4])
    expect(stopped).toMatchObject({ status: 'running', outcome: { stopRequested: true } })
    expect(store.getRun(run.runId)).toEqual(done)
    expect(done.outcome).toEqual({ stopRequested: true, interruptedBy: 'user' })
    expect(store.getAttempt(attempt.attemptId)!.providerRef).toEqual({
      provider: 'fake',
      model: 'm'
    })
    const events = store.listEvents('t')
    expect(events.map((event) => event.type)).toEqual([
      'run.created',
      'attempt.created',
      'run.status',
      'run.status',
      'attempt.status',
      'run.status',
      'run.status'
    ])
    expect(events.map((event) => event.seq)).toEqual(
      [...events.map((event) => event.seq)].sort((x, y) => x - y)
    )
    expect(events.at(-1)!.payload).toMatchObject({ status: 'interrupted', epoch: 4 })
  })

  it('rejects a stale epoch and leaves the row unchanged', () => {
    const store = open()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const starting = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'starting' })
    const seq = store.maxSeq('t')
    expect(
      codeOf(() => store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'running' }))
    ).toBe('stale_write')
    expect(
      codeOf(() =>
        store.casRunOutcome({
          runId: run.runId,
          expectedEpoch: 0,
          outcomePatch: { stopRequested: true }
        })
      )
    ).toBe('stale_write')
    expect(store.getRun(run.runId)).toEqual(starting)
    expect(store.maxSeq('t')).toBe(seq)
  })

  it('refuses transitions out of a terminal status', () => {
    const store = open()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const done = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'completed' })
    expect(
      codeOf(() =>
        store.casRunStatus({ runId: run.runId, expectedEpoch: done.epoch, status: 'running' })
      )
    ).toBe('bad_request')
    expect(
      codeOf(() =>
        store.casRunOutcome({
          runId: run.runId,
          expectedEpoch: done.epoch,
          outcomePatch: { error: 'x' }
        })
      )
    ).toBe('bad_request')
    expect(store.getRun(run.runId)).toEqual(done)
  })

  it('distinguishes the single active run from queued runs', () => {
    const store = open()
    expect(store.getActiveRun('t')).toBeNull()
    const first = store.createRun({ threadId: 't', source: 'gui' })
    // A queued run does not own execution yet.
    expect(store.getActiveRun('t')).toBeNull()
    expect(store.listQueuedRuns('t').map((run) => run.runId)).toEqual([first.runId])
    expect(store.listNonTerminalRuns().map((run) => run.runId)).toEqual([first.runId])
    store.casRunStatus({ runId: first.runId, expectedEpoch: 0, status: 'starting' })
    expect(store.getActiveRun('t')!.runId).toBe(first.runId)
    // Sends during an active run queue behind it without conflicting.
    const second = store.createRun({ threadId: 't', source: 'gui' })
    expect(store.getActiveRun('t')!.runId).toBe(first.runId)
    expect(store.listQueuedRuns('t').map((run) => run.runId)).toEqual([second.runId])
    store.casRunStatus({ runId: first.runId, expectedEpoch: 1, status: 'failed' })
    expect(store.getActiveRun('t')).toBeNull()
    expect(store.listNonTerminalRuns().map((run) => run.runId)).toEqual([second.runId])
    // Two runs owning execution at once is an invariant violation.
    store.casRunStatus({ runId: second.runId, expectedEpoch: 0, status: 'starting' })
    const third = store.createRun({ threadId: 't', source: 'gui' })
    store.casRunStatus({ runId: third.runId, expectedEpoch: 0, status: 'starting' })
    expect(codeOf(() => store.getActiveRun('t'))).toBe('conflict')
  })

  it('stores receipts once and conflicts on a duplicate', () => {
    const store = open()
    const receipt = {
      clientRequestId: 'req-1',
      threadId: 't',
      commandKind: 'send',
      status: 'accepted' as const,
      result: { runId: 'r', sequence: 3 },
      createdAt: '2026-10-12T00:00:00.000Z'
    }
    expect(store.getReceipt('req-1')).toBeNull()
    store.putReceipt(receipt)
    expect(store.getReceipt('req-1')).toEqual(receipt)
    expect(codeOf(() => store.putReceipt({ ...receipt, status: 'ignored' }))).toBe('conflict')
    expect(store.getReceipt('req-1')).toEqual(receipt)
  })

  it('pages events with afterSeq and reports maxSeq per thread', () => {
    const store = open()
    expect(store.maxSeq('t')).toBe(0)
    const seqs = [1, 2, 3, 4, 5].map((n) =>
      store.appendEvent({ threadId: 't', type: 'test', payload: { n } })
    )
    store.appendEvent({ threadId: 'other', type: 'test', payload: { n: 0 } })
    expect(store.maxSeq('t')).toBe(seqs[4])
    const page1 = store.listEvents('t', { limit: 2 })
    const page2 = store.listEvents('t', { afterSeq: page1.at(-1)!.seq, limit: 2 })
    const page3 = store.listEvents('t', { afterSeq: page2.at(-1)!.seq, limit: 2 })
    expect([...page1, ...page2, ...page3].map((event) => event.payload)).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ n }))
    )
    expect(store.listEvents('t', { afterSeq: seqs[4] })).toEqual([])
  })

  it('joins an outer transaction and rolls back with it', () => {
    const store = open()
    expect(() =>
      store.db.transaction(() => {
        store.createRun({ threadId: 't', source: 'gui' })
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(store.listRuns('t')).toEqual([])
    expect(store.maxSeq('t')).toBe(0)
  })
})
