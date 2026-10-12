import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunFsck } from '../../src/mms/run/fsck/RunFsck'
import { RunStore } from '../../src/mms/run/RunStore'

describe('RunFsck', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const seed = (): RunStore => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-fsck-'))
    db = new ProfileDatabase({ profileHome })
    return new RunStore(db)
  }

  const check = () => {
    db?.close()
    db = undefined
    return new RunFsck({ profileHome: profileHome! }).check()
  }

  const codes = () => check().map((finding) => finding.code)

  it('reports no findings for an empty profile home and does not create a database', () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-fsck-'))
    expect(new RunFsck({ profileHome }).check()).toEqual([])
    expect(existsSync(join(profileHome, 'run'))).toBe(false)
  })

  it('reports no findings for a healthy lifecycle', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    const starting = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'starting' })
    const running = store.casRunStatus({ runId: run.runId, expectedEpoch: starting.epoch, status: 'running' })
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'running' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: running.epoch, status: 'completed' })
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'completed' })
    store.putReceipt({
      clientRequestId: 'req',
      threadId: 't',
      commandKind: 'send',
      status: 'accepted',
      result: { runId: run.runId, sequence: 1 },
      createdAt: '2026-10-12T00:00:00.000Z'
    })
    expect(check()).toEqual([])
  })

  it('attempt_status_mismatch: terminal run with a live attempt', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    store.createAttempt({ runId: run.runId, reason: 'initial' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'failed' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['attempt_status_mismatch'])
    expect(findings[0].details).toMatchObject({ runId: run.runId, attemptStatus: 'pending' })
  })

  it('dangling_active_attempt: active attempt id points nowhere', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    store.casRunStatus({
      runId: run.runId,
      expectedEpoch: 0,
      status: 'starting',
      patch: { activeAttemptId: 'attempt:ghost:1' }
    })
    expect(codes()).toEqual(['dangling_active_attempt'])
  })

  it('dangling_active_attempt: running run whose attempt never started', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    store.createAttempt({ runId: run.runId, reason: 'initial' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'running' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['dangling_active_attempt'])
    expect(findings[0].details).toMatchObject({ reason: 'not_running' })
  })

  it('event_seq_gap: run event for an unknown run', () => {
    const store = seed()
    store.appendEvent({ threadId: 't', runId: 'run:thread:t:ordinal:9', type: 'run.status', payload: {} })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['event_seq_gap'])
    expect(findings[0].details).toMatchObject({ reason: 'unknown_run' })
  })

  it('receipt_unknown_run: accepted receipt for a run that does not exist', () => {
    const store = seed()
    store.putReceipt({
      clientRequestId: 'req',
      threadId: 't',
      commandKind: 'send',
      status: 'accepted',
      result: { runId: 'run:thread:t:ordinal:7', sequence: 3 },
      createdAt: '2026-10-12T00:00:00.000Z'
    })
    store.putReceipt({
      clientRequestId: 'ignored',
      threadId: 't',
      commandKind: 'stop',
      status: 'ignored',
      result: { runId: 'run:thread:t:ordinal:8', sequence: 3 },
      createdAt: '2026-10-12T00:00:00.000Z'
    })
    expect(codes()).toEqual(['receipt_unknown_run'])
  })

  it('multiple_active_runs: two active runs on one thread', () => {
    const store = seed()
    const a = store.createRun({ threadId: 't', source: 'gui' })
    const b = store.createRun({ threadId: 't', source: 'gui' })
    store.casRunStatus({ runId: a.runId, expectedEpoch: 0, status: 'starting' })
    store.casRunStatus({ runId: b.runId, expectedEpoch: 0, status: 'finalizing' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['multiple_active_runs'])
    expect(findings[0].details).toEqual({ threadId: 't', runIds: [a.runId, b.runId] })
  })
})
