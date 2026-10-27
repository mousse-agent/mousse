import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { DaemonEpoch } from '../../src/mms/run/DaemonEpoch'
import { Delegations } from '../../src/mms/run/Delegations'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunFsck } from '../../src/mms/run/fsck/RunFsck'
import { RunStore } from '../../src/mms/run/RunStore'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'

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

  it('reports no findings for a paused run whose attempt was interrupted', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    const running = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'running' })
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'running' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: running.epoch, status: 'paused' })
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'interrupted' })
    expect(check()).toEqual([])
  })

  it('paused_run_with_live_attempt: a paused run whose attempt is still running', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    const running = store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'running' })
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'running' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: running.epoch, status: 'paused' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['paused_run_with_live_attempt'])
    expect(findings[0]).toMatchObject({ severity: 'error', details: { runId: run.runId, attemptId: attempt.attemptId, attemptStatus: 'running' } })
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

  // Phase 2 checks (SPEC §12.7). Times far in the past or future keep them independent of the
  // wall clock that `RunFsck.check()` uses.
  const PAST = '2000-01-01T00:00:00.000Z'
  const FUTURE = '2999-01-01T00:00:00.000Z'

  it('effect_lease_expired_unclaimed: running effect whose lease expired', () => {
    const store = seed()
    const { epoch } = new DaemonEpoch(store).begin(1, PAST)
    const outbox = new EffectOutbox(store, { allowReservedKinds: true })
    const effect = outbox.enqueue({ threadId: 't', kind: 'title.generate', availableAt: PAST })
    outbox.claimNext(`${epoch}:1`, PAST)
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['effect_lease_expired_unclaimed'])
    expect(findings[0].details).toMatchObject({ effectId: effect.effectId, leaseOwner: '1:1' })
  })

  it('effect_running_for_dead_epoch: running effect leased by an older daemon epoch', () => {
    const store = seed()
    const epochs = new DaemonEpoch(store)
    epochs.begin(1, FUTURE)
    epochs.begin(2, FUTURE)
    const outbox = new EffectOutbox(store, { allowReservedKinds: true })
    const dead = outbox.enqueue({ threadId: 't', kind: 'title.generate', availableAt: FUTURE })
    outbox.enqueue({ threadId: 'u', kind: 'title.generate', availableAt: FUTURE })
    outbox.claimNext('1:1', FUTURE)
    outbox.claimNext('2:2', FUTURE)
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['effect_running_for_dead_epoch'])
    expect(findings[0].details).toMatchObject({ effectId: dead.effectId, currentEpoch: 2 })
  })

  it('run_active_without_effect: effect-driven active run with no live effect (warning)', () => {
    const store = seed()
    const outbox = new EffectOutbox(store, { allowReservedKinds: true })
    const driven = store.createRun({ threadId: 't', source: 'gui' })
    store.casRunStatus({ runId: driven.runId, expectedEpoch: 0, status: 'running' })
    const turn = outbox.enqueue({ threadId: 't', runId: driven.runId, kind: 'turn.start' })
    outbox.cancel(turn.effectId, PAST, 'gone')
    // A legacy-driven active run (never had an effect) is not reported in Phase 2a.
    const legacy = store.createRun({ threadId: 'u', source: 'gui' })
    store.casRunStatus({ runId: legacy.runId, expectedEpoch: 0, status: 'running' })
    const findings = check()
    expect(findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['run_active_without_effect', 'warning']
    ])
    expect(findings[0].details).toEqual({ runId: driven.runId, threadId: 't', status: 'running' })
  })

  it('tool_started_on_terminal_run: started tool invocation outlived its run', () => {
    const store = seed()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const attempt = store.createAttempt({ runId: run.runId, reason: 'initial' })
    const tools = new ToolInvocations(store)
    tools.start({ invocationId: 'call-1', runId: run.runId, attemptId: attempt.attemptId, tool: 'bash', argsDigest: 'd', now: PAST })
    tools.start({ invocationId: 'call-2', runId: run.runId, attemptId: attempt.attemptId, tool: 'bash', argsDigest: 'd', now: PAST })
    tools.commit('call-2', PAST)
    store.setAttemptStatus({ attemptId: attempt.attemptId, status: 'interrupted' })
    store.casRunStatus({ runId: run.runId, expectedEpoch: 0, status: 'interrupted' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['tool_started_on_terminal_run'])
    expect(findings[0].details).toMatchObject({ invocationId: 'call-1', runStatus: 'interrupted' })
  })

  it('queued_run_without_effect_or_queue_item: a queued run nothing will start (warning)', () => {
    const store = seed()
    const outbox = new EffectOutbox(store)
    // Stranded: its turn.start died and it is not a queue item.
    const stranded = store.createRun({ threadId: 't', source: 'gui' })
    const dead = outbox.enqueue({ threadId: 't', runId: stranded.runId, kind: 'turn.start', payload: { runId: stranded.runId, threadId: 't', input: { content: 'x' } } })
    outbox.cancel(dead.effectId, PAST, 'daemon_restart')
    // Waiting: a pending turn.start, a queue item's dead turn.start, and a run with no turn.start yet.
    const pending = store.createRun({ threadId: 'u', source: 'gui' })
    outbox.enqueue({ threadId: 'u', runId: pending.runId, kind: 'turn.start' })
    const item = store.createRun({ threadId: 'v', source: 'queue' })
    const itemStart = outbox.enqueue({ threadId: 'v', runId: item.runId, kind: 'turn.start', payload: { runId: item.runId, threadId: 'v', input: { content: 'x' }, queueItemId: 'q1' } })
    outbox.cancel(itemStart.effectId, PAST, 'daemon_restart')
    const queuedOnly = store.createRun({ threadId: 'w', source: 'gui' })
    const findings = check()
    expect(findings.map((finding) => [finding.code, finding.severity])).toEqual([['queued_run_without_effect_or_queue_item', 'warning']])
    expect(findings[0].details).toMatchObject({ runId: stranded.runId, threadId: 't', hadTurnStart: true })
    // With the queue readable, a run on no queue is reported even without a turn.start.
    const withQueues = new RunFsck({ profileHome: profileHome!, queuedRunIds: (threadId) => (threadId === 'v' ? [item.runId] : []) }).check()
    expect(withQueues.filter((finding) => finding.code === 'queued_run_without_effect_or_queue_item').map((finding) => finding.details?.runId))
      .toEqual([stranded.runId, queuedOnly.runId])
  })

  it('delegation_running_child_terminal: a running delegation whose child run ended', () => {
    const store = seed()
    const child = store.createRun({ threadId: 'child', source: 'delegation' })
    const delegations = new Delegations(store)
    const delegation = delegations.create({ parentRunId: 'run:p', parentThreadId: 'p', childThreadId: 'child', childRunId: child.runId, prompt: 'x', wake: 'always' })
    // Ended without the publication gate (no lineage row): the delegation stays running.
    store.casRunStatus({ runId: child.runId, expectedEpoch: 0, status: 'failed' })
    const findings = check()
    expect(findings.map((finding) => finding.code)).toEqual(['delegation_running_child_terminal'])
    expect(findings[0].details).toMatchObject({ delegationId: delegation.delegationId, childRunId: child.runId, runStatus: 'failed' })
  })
})
