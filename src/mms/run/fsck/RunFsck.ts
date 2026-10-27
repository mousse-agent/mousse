/**
 * Run Engine consistency checker. Inspects a profile's run state and reports findings such as
 * attempt/run status disagreement, dangling active attempts, thread event inconsistencies,
 * receipts for unknown runs and more than one active run per thread. See
 * docs/run-engine/SPEC.md §7.
 *
 * Phase 2 (schema version 2, SPEC §12.7) adds effect lease, dead-epoch, effect-less active run and
 * stranded tool-invocation checks, and queued runs nothing will start. Phase 4 (schema version 3)
 * adds running delegations whose child run already ended.
 *
 * Not checked: non-terminal runs from an earlier daemon epoch (runs do not record their epoch)
 * and in-memory `turnStates` versus `runs` (needs a live daemon).
 */
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ProfileDatabase } from '../db/ProfileDatabase'
import type { Row } from '../db/rows'
import { TERMINAL_RUN_STATUSES } from '../types'

export interface FsckFinding {
  code: string
  severity: 'error' | 'warning'
  message: string
  details?: Record<string, unknown>
}

export interface RunFsckOptions {
  /** Root of the profile whose run state is checked (holds the profile database). */
  profileHome: string
  /**
   * Run ids carried by the thread's durable message queue (`queue.json`), when the caller can read
   * thread storage. Without it a queued run counts as waiting on the queue unless its `turn.start`
   * already ended.
   */
  queuedRunIds?: (threadId: string) => readonly string[] | null
}

export interface RunFsckCheckOptions {
  queuedRunIds?: RunFsckOptions['queuedRunIds']
}

const TERMINAL = [...TERMINAL_RUN_STATUSES]
const TERMINAL_SQL = TERMINAL.map((status) => `'${status}'`).join(',')
/** Same predicate as `RunStore.getActiveRun`. */
const ACTIVE_SQL = `'starting','running','finalizing'`

export class RunFsck {
  readonly profileHome: string
  private readonly queuedRunIds: RunFsckOptions['queuedRunIds']

  constructor(opts: RunFsckOptions) {
    this.profileHome = opts.profileHome
    this.queuedRunIds = opts.queuedRunIds
  }

  /** Opens the profile database only when it exists; never creates or migrates it. */
  check(): FsckFinding[] {
    if (!existsSync(this.profileHome)) return []
    const path = join(realpathSync(resolve(this.profileHome)), 'run', 'run.db')
    if (!existsSync(path)) return []
    const db = new ProfileDatabase({ profileHome: this.profileHome })
    try {
      if (db.userVersion() < 1) return []
      return RunFsck.checkDatabase(db, { queuedRunIds: this.queuedRunIds })
    } finally {
      db.close()
    }
  }

  static checkDatabase(db: ProfileDatabase, options: RunFsckCheckOptions = {}): FsckFinding[] {
    const findings = [
      ...attemptStatusMismatches(db),
      ...danglingActiveAttempts(db),
      ...eventSequenceFindings(db),
      ...receiptsForUnknownRuns(db),
      ...multipleActiveRuns(db),
      ...(db.userVersion() >= 10 ? [...pausedRunsWithLiveAttempt(db), ...pausedRunsWithoutTimer(db)] : [])
    ]
    if (db.userVersion() < 2) return findings
    const now = new Date(db.clock()).toISOString()
    return [
      ...findings,
      ...expiredEffectLeases(db, now),
      ...effectsForDeadEpochs(db),
      ...activeRunsWithoutEffect(db),
      ...toolsStartedOnTerminalRuns(db),
      ...queuedRunsWithoutEffectOrQueueItem(db, options.queuedRunIds),
      ...(db.userVersion() >= 3 ? runningDelegationsWithTerminalChild(db) : [])
    ]
  }
}

/**
 * A queued run that nothing will start: no `pending|running` `turn.start`, and not on its thread's
 * message queue. With `queuedRunIds` the queue is read; without it a run whose latest `turn.start`
 * ended and that is no queue item's (`queueItemId` in its payload) counts, while a run that never
 * had a `turn.start` is assumed to wait on the queue. Reconciler rule 5 repairs the stranded ones.
 */
function queuedRunsWithoutEffectOrQueueItem(
  db: ProfileDatabase,
  queuedRunIds: RunFsckOptions['queuedRunIds']
): FsckFinding[] {
  const rows = db
    .statement(
      `SELECT r.run_id, r.thread_id, r.source,
         (SELECT e.payload FROM effects e WHERE e.run_id = r.run_id AND e.kind = 'turn.start'
           ORDER BY e.rowid DESC LIMIT 1) AS latest_payload
       FROM runs r
       WHERE r.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.run_id = r.run_id AND e.kind = 'turn.start'
           AND e.status IN ('pending','running'))
       ORDER BY r.thread_id, r.ordinal`
    )
    .all()
  const queues = new Map<string, ReadonlySet<string> | null>()
  const onQueue = (threadId: string, runId: string): boolean | null => {
    if (!queuedRunIds) return null
    if (!queues.has(threadId)) {
      let ids: readonly string[] | null = null
      try {
        ids = queuedRunIds(threadId)
      } catch {
        ids = null
      }
      queues.set(threadId, ids ? new Set(ids) : null)
    }
    const ids = queues.get(threadId)
    return ids ? ids.has(runId) : null
  }
  const findings: FsckFinding[] = []
  for (const row of rows) {
    const runId = String(row.run_id)
    const threadId = String(row.thread_id)
    let payload: unknown = null
    try {
      payload = typeof row.latest_payload === 'string' ? JSON.parse(row.latest_payload) : null
    } catch {
      payload = null
    }
    const queueItem = Boolean(payload && typeof payload === 'object' && typeof (payload as Row).queueItemId === 'string')
    const queued = onQueue(threadId, runId)
    const stranded = queued === null ? row.latest_payload !== null && row.latest_payload !== undefined && !queueItem : !queued
    if (!stranded) continue
    findings.push({
      code: 'queued_run_without_effect_or_queue_item',
      severity: 'warning',
      message: `Run ${runId} is queued but has no pending or running turn.start and is not on its thread's queue.`,
      details: { runId, threadId, source: row.source, hadTurnStart: row.latest_payload !== null && row.latest_payload !== undefined }
    })
  }
  return findings
}

/** A delegation still `running` whose child run is terminal: the publication gate missed it. */
function runningDelegationsWithTerminalChild(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT d.delegation_id, d.parent_thread_id, d.child_thread_id, d.child_run_id, r.status AS run_status
       FROM delegations d JOIN runs r ON r.run_id = d.child_run_id
       WHERE d.status = 'running' AND r.status IN (${TERMINAL_SQL})
       ORDER BY d.rowid`
    )
    .all()
    .map((row: Row) => ({
      code: 'delegation_running_child_terminal',
      severity: 'error' as const,
      message: `Delegation ${String(row.delegation_id)} is running but its child run ${String(row.child_run_id)} is ${String(row.run_status)}.`,
      details: {
        delegationId: row.delegation_id,
        parentThreadId: row.parent_thread_id,
        childThreadId: row.child_thread_id,
        childRunId: row.child_run_id,
        runStatus: row.run_status
      }
    }))
}

function attemptStatusMismatches(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT a.attempt_id, a.status AS attempt_status, r.run_id, r.status AS run_status
       FROM run_attempts a JOIN runs r ON r.run_id = a.run_id
       WHERE r.status IN (${TERMINAL_SQL}) AND a.status IN ('pending','running')
       ORDER BY r.run_id, a.ordinal`
    )
    .all()
    .map((row: Row) => ({
      code: 'attempt_status_mismatch',
      severity: 'error' as const,
      message: `Run ${String(row.run_id)} is ${String(row.run_status)} but attempt ${String(row.attempt_id)} is ${String(row.attempt_status)}.`,
      details: {
        runId: row.run_id,
        attemptId: row.attempt_id,
        runStatus: row.run_status,
        attemptStatus: row.attempt_status
      }
    }))
}

function danglingActiveAttempts(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT r.run_id, r.status AS run_status, r.active_attempt_id, a.run_id AS attempt_run_id,
         a.status AS attempt_status
       FROM runs r LEFT JOIN run_attempts a ON a.attempt_id = r.active_attempt_id
       WHERE r.active_attempt_id IS NOT NULL AND (
         a.attempt_id IS NULL OR a.run_id <> r.run_id OR
         (r.status IN ('running','finalizing') AND a.status <> 'running'))
       ORDER BY r.run_id`
    )
    .all()
    .map((row: Row) => {
      const reason =
        row.attempt_run_id === null || row.attempt_run_id === undefined
          ? 'missing'
          : row.attempt_run_id !== row.run_id
            ? 'other_run'
            : 'not_running'
      return {
        code: 'dangling_active_attempt',
        severity: 'error' as const,
        message: `Run ${String(row.run_id)} points at active attempt ${String(row.active_attempt_id)} (${reason}).`,
        details: {
          runId: row.run_id,
          attemptId: row.active_attempt_id,
          runStatus: row.run_status,
          attemptStatus: row.attempt_status ?? null,
          reason
        }
      }
    })
}

/**
 * `thread_events.seq` is a global AUTOINCREMENT key, so per-thread sequences legitimately skip
 * numbers. What must hold is strict increase per thread and that run events name known runs.
 */
function eventSequenceFindings(db: ProfileDatabase): FsckFinding[] {
  const findings: FsckFinding[] = []
  const last = new Map<string, number>()
  for (const row of db.statement('SELECT seq, thread_id FROM thread_events ORDER BY rowid').all()) {
    const threadId = String(row.thread_id)
    const seq = Number(row.seq)
    const previous = last.get(threadId)
    if (previous !== undefined && seq <= previous)
      findings.push({
        code: 'event_seq_gap',
        severity: 'error',
        message: `Thread ${threadId} event seq ${seq} does not follow ${previous}.`,
        details: { threadId, seq, previous, reason: 'non_increasing' }
      })
    last.set(threadId, seq)
  }
  const orphans = db
    .statement(
      `SELECT e.seq, e.thread_id, e.run_id, e.type FROM thread_events e
       LEFT JOIN runs r ON r.run_id = e.run_id
       WHERE e.run_id IS NOT NULL AND (e.type LIKE 'run.%' OR e.type LIKE 'attempt.%')
         AND (r.run_id IS NULL OR r.thread_id <> e.thread_id)
       ORDER BY e.seq`
    )
    .all()
  for (const row of orphans)
    findings.push({
      code: 'event_seq_gap',
      severity: 'error',
      message: `Thread ${String(row.thread_id)} event ${String(row.seq)} (${String(row.type)}) names unknown run ${String(row.run_id)}.`,
      details: {
        threadId: row.thread_id,
        seq: row.seq,
        runId: row.run_id,
        type: row.type,
        reason: 'unknown_run'
      }
    })
  return findings
}

function receiptsForUnknownRuns(db: ProfileDatabase): FsckFinding[] {
  const findings: FsckFinding[] = []
  const rows = db
    .statement(
      `SELECT client_request_id, thread_id, command_kind, result FROM receipts
       WHERE status = 'accepted' ORDER BY created_at, client_request_id`
    )
    .all()
  const exists = db.statement('SELECT 1 AS found FROM runs WHERE run_id = ?')
  for (const row of rows) {
    let runId: unknown
    try {
      runId = typeof row.result === 'string' ? (JSON.parse(row.result) as Row)?.runId : undefined
    } catch {
      runId = undefined
    }
    if (typeof runId !== 'string' || !exists.get(runId))
      findings.push({
        code: 'receipt_unknown_run',
        severity: 'error',
        message: `Accepted receipt ${String(row.client_request_id)} names unknown run ${String(runId)}.`,
        details: {
          clientRequestId: row.client_request_id,
          threadId: row.thread_id,
          commandKind: row.command_kind,
          runId: runId ?? null
        }
      })
  }
  return findings
}

function multipleActiveRuns(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT thread_id, COUNT(*) AS count, GROUP_CONCAT(run_id, ' ') AS run_ids FROM runs
       WHERE status IN (${ACTIVE_SQL}) GROUP BY thread_id HAVING COUNT(*) > 1 ORDER BY thread_id`
    )
    .all()
    .map((row: Row) => ({
      code: 'multiple_active_runs',
      severity: 'error' as const,
      message: `Thread ${String(row.thread_id)} has ${Number(row.count)} active runs.`,
      details: { threadId: row.thread_id, runIds: String(row.run_ids).split(' ') }
    }))
}

/** A paused run waits for a usage limit; its attempt was interrupted when it paused, so none may still be live. */
function pausedRunsWithLiveAttempt(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT r.run_id, r.thread_id, a.attempt_id, a.status AS attempt_status
       FROM runs r JOIN run_attempts a ON a.run_id = r.run_id
       WHERE r.status = 'paused' AND a.status IN ('pending','running')
       ORDER BY r.run_id, a.ordinal`
    )
    .all()
    .map((row: Row) => ({
      code: 'paused_run_with_live_attempt',
      severity: 'error' as const,
      message: `Run ${String(row.run_id)} is paused but attempt ${String(row.attempt_id)} is ${String(row.attempt_status)}.`,
      details: { runId: row.run_id, threadId: row.thread_id, attemptId: row.attempt_id, attemptStatus: row.attempt_status }
    }))
}

/**
 * A paused run that promises to continue by itself (`autoResume`) but has no `run.resume` waiting or
 * running: its timer ended `failed` or `cancelled`, so the banner would say "continues at reset"
 * and nothing will. Resume now still works. A continue turn already queued for it
 * (`pause.resumeItemId`) is the queue's to finish and is not a finding.
 */
function pausedRunsWithoutTimer(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT r.run_id, r.thread_id,
              json_extract(r.outcome, '$.pause.until') AS until
       FROM runs r
       WHERE r.status = 'paused'
         AND json_extract(r.outcome, '$.pause.autoResume') = 1
         AND json_extract(r.outcome, '$.pause.resumeItemId') IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM effects e
           WHERE e.run_id = r.run_id AND e.kind = 'run.resume' AND e.status IN ('pending','running')
         )
       ORDER BY r.run_id`
    )
    .all()
    .map((row: Row) => ({
      code: 'paused_run_without_timer',
      severity: 'warning' as const,
      message: `Run ${String(row.run_id)} is paused to resume by itself at ${String(row.until)}, but no run.resume is waiting for it.`,
      details: { runId: row.run_id, threadId: row.thread_id, until: row.until }
    }))
}

/** A running effect whose lease expired and that the reconciler has not reclaimed yet. */
function expiredEffectLeases(db: ProfileDatabase, now: string): FsckFinding[] {
  return db
    .statement(
      `SELECT effect_id, thread_id, run_id, kind, lease_owner, lease_expires_at FROM effects
       WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY rowid`
    )
    .all(now)
    .map((row: Row) => ({
      code: 'effect_lease_expired_unclaimed',
      severity: 'error' as const,
      message: `Effect ${String(row.effect_id)} is running on a lease that expired at ${String(row.lease_expires_at)}.`,
      details: {
        effectId: row.effect_id,
        threadId: row.thread_id,
        runId: row.run_id ?? null,
        kind: row.kind,
        leaseOwner: row.lease_owner ?? null,
        leaseExpiresAt: row.lease_expires_at ?? null
      }
    }))
}

/** A running effect leased by a daemon epoch other than the newest one. */
function effectsForDeadEpochs(db: ProfileDatabase): FsckFinding[] {
  const current = db.statement('SELECT MAX(epoch) AS epoch FROM daemon_epochs').get()?.epoch
  const currentEpoch = current === null || current === undefined ? null : Number(current)
  return db
    .statement(
      `SELECT effect_id, thread_id, run_id, kind, lease_owner FROM effects
       WHERE status = 'running' ORDER BY rowid`
    )
    .all()
    .filter((row: Row) => {
      const prefix = Number(String(row.lease_owner ?? '').split(':')[0])
      return currentEpoch === null || !Number.isSafeInteger(prefix) || prefix !== currentEpoch
    })
    .map((row: Row) => ({
      code: 'effect_running_for_dead_epoch',
      severity: 'error' as const,
      message: `Effect ${String(row.effect_id)} is running for lease owner ${String(row.lease_owner)}, not daemon epoch ${String(currentEpoch)}.`,
      details: {
        effectId: row.effect_id,
        threadId: row.thread_id,
        runId: row.run_id ?? null,
        kind: row.kind,
        leaseOwner: row.lease_owner ?? null,
        currentEpoch
      }
    }))
}

/**
 * An active run driven by effects (it has at least one) with no pending or running effect left.
 * Runs that never had an effect are legacy-driven during Phase 2a and are not reported.
 */
function activeRunsWithoutEffect(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT r.run_id, r.thread_id, r.status FROM runs r
       WHERE r.status IN (${ACTIVE_SQL})
         AND EXISTS (SELECT 1 FROM effects e WHERE e.run_id = r.run_id)
         AND NOT EXISTS (
           SELECT 1 FROM effects e WHERE e.run_id = r.run_id AND e.status IN ('pending','running'))
       ORDER BY r.run_id`
    )
    .all()
    .map((row: Row) => ({
      code: 'run_active_without_effect',
      severity: 'warning' as const,
      message: `Run ${String(row.run_id)} is ${String(row.status)} but has no pending or running effect.`,
      details: { runId: row.run_id, threadId: row.thread_id, status: row.status }
    }))
}

/** A tool invocation still `started` although its run is terminal (reconciler rule 6 pending). */
function toolsStartedOnTerminalRuns(db: ProfileDatabase): FsckFinding[] {
  return db
    .statement(
      `SELECT t.invocation_id, t.tool, t.run_id, r.status AS run_status FROM tool_invocations t
       JOIN runs r ON r.run_id = t.run_id
       WHERE t.status = 'started' AND r.status IN (${TERMINAL_SQL})
       ORDER BY t.rowid`
    )
    .all()
    .map((row: Row) => ({
      code: 'tool_started_on_terminal_run',
      severity: 'error' as const,
      message: `Tool ${String(row.tool)} (${String(row.invocation_id)}) is still started but run ${String(row.run_id)} is ${String(row.run_status)}.`,
      details: {
        invocationId: row.invocation_id,
        tool: row.tool,
        runId: row.run_id,
        runStatus: row.run_status
      }
    }))
}
