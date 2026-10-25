import type { SQLInputValue } from 'node:sqlite'
import type { ProfileDatabase } from './db/ProfileDatabase'
import { RUN_MIGRATIONS } from './db/migrations'
import { json, str, type Row } from './db/rows'
import { fail } from './db/RunStoreError'
import { settleWaitingDelegations } from './delegation/hold'
import { stableStringify } from './json'
import { currentStopGeneration } from './stopGeneration'
import {
  TERMINAL_RUN_STATUSES,
  attemptId as makeAttemptId,
  runId as makeRunId,
  type AttemptReason,
  type AttemptRecord,
  type AttemptStatus,
  type ProviderRef,
  type ReceiptRecord,
  type RunOutcome,
  type RunRecord,
  type RunStatus,
  type ThreadEvent
} from './types'

export type RunPatch = Partial<
  Pick<RunRecord, 'startedAt' | 'completedAt' | 'outcome' | 'activeAttemptId' | 'userMessageId'>
>

const TERMINAL_LIST = [...TERMINAL_RUN_STATUSES]
const TERMINAL_PLACEHOLDERS = TERMINAL_LIST.map(() => '?').join(',')

/**
 * Typed, synchronous data access for runs, attempts, receipts and thread events.
 * Every mutation is transactional: it joins the caller's `db.transaction` or opens its own.
 */
export class RunStore {
  private readonly eventListeners = new Set<(event: ThreadEvent) => void>()
  /** Threads whose waiting tasks `settleHold` still has to look at, and whether it is looking now. */
  private readonly settleQueue = new Set<string>()
  private settling = false
  private providerBackground: ((threadId: string) => boolean) | null = null
  private unreadSteers: ((threadId: string) => boolean) | null = null

  constructor(readonly db: ProfileDatabase) {
    db.migrate(RUN_MIGRATIONS)
  }

  /**
   * Input (4) of the hold predicate (`childBusy`): whether the provider still runs background work
   * for a thread after its runs ended. The host supplies it; it must be synchronous and in memory,
   * because the predicate reads it inside transactions. Absent means no thread has any.
   */
  setProviderBackgroundWork(read: ((threadId: string) => boolean) | null): void {
    this.providerBackground = read
  }

  /** Never throws: a provider that cannot answer has no background work to wait for. */
  providerBackgroundWork(threadId: string): boolean {
    try {
      return this.providerBackground?.(threadId) === true
    } catch {
      return false
    }
  }

  /**
   * Input (5) of the hold predicate (`childBusy`): whether the thread's live turn holds steers it has
   * not read yet. A person's plain-text steer lives only in the turn's memory until the turn settles
   * and queues it as a follow-up turn, which happens after the turn's terminal write; without this the
   * thread would look idle in between and its task would publish before the thread answered the steer.
   * Synchronous and in memory, like `setProviderBackgroundWork`. Absent means no thread has any.
   */
  setUnreadSteers(read: ((threadId: string) => boolean) | null): void {
    this.unreadSteers = read
  }

  /** Never throws: a host that cannot answer has no unread steers to wait for. */
  hasUnreadSteers(threadId: string): boolean {
    try {
      return this.unreadSteers?.(threadId) === true
    } catch {
      return false
    }
  }

  /**
   * Something `settleWaitingDelegations` reads for `threadId` changed: a run ended, an inbox row or
   * a delivery effect changed status, a delegation of the thread left `running`, a queue entry was
   * removed, the provider's background work changed. Publishes the tasks waiting on the thread that
   * are no longer held, inside the caller's transaction (or one of its own). A call made while a
   * settlement is running (publishing one task changes the next thread's inputs) is queued and
   * handled after the current thread is done, so no thread is judged on a half-written state.
   */
  settleHold(threadId: string): void {
    this.settleQueue.add(threadId)
    if (this.settling) return
    this.settling = true
    try {
      while (this.settleQueue.size) {
        const [next] = this.settleQueue
        this.settleQueue.delete(next)
        settleWaitingDelegations(this, next)
      }
    } finally {
      // A throw leaves the threads still queued for the next call: settling is idempotent, so a
      // thread whose turn did not come is judged then. (Inside a transaction the throw rolls back
      // what was written, and the next evaluation reads the committed state.)
      this.settling = false
    }
  }

  /**
   * Observes every appended thread event after its transaction commits, in `seq` order. Events
   * of a rolled-back transaction are never delivered. Covers appends from the engine, the outbox,
   * the tool ledger and the reconciler alike.
   */
  onEvent(listener: (event: ThreadEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  createRun(input: {
    threadId: string
    source: string
    clientRequestId?: string
    userMessageId?: string
    requestedAt?: string
    outcome?: RunOutcome
  }): RunRecord {
    return this.db.transaction(() => {
      const max = this.db
        .statement('SELECT COALESCE(MAX(ordinal), 0) AS max FROM runs WHERE thread_id = ?')
        .get(input.threadId)!
      const ordinal = Number(max.max) + 1
      const record: RunRecord = {
        runId: makeRunId(input.threadId, ordinal),
        threadId: input.threadId,
        ordinal,
        status: 'queued',
        epoch: 0,
        activeAttemptId: null,
        source: input.source,
        clientRequestId: input.clientRequestId ?? null,
        userMessageId: input.userMessageId ?? null,
        requestedAt: input.requestedAt ?? this.now(),
        startedAt: null,
        completedAt: null,
        outcome: input.outcome ?? null,
        heartbeatAt: null
      }
      this.db
        .statement(
          `INSERT INTO runs(run_id, thread_id, ordinal, status, epoch, active_attempt_id, source,
             client_request_id, user_message_id, requested_at, started_at, completed_at, outcome, stop_generation)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...runParams(record), currentStopGeneration(this, record.threadId))
      this.appendEvent({
        threadId: record.threadId,
        runId: record.runId,
        type: 'run.created',
        payload: record
      })
      return record
    })
  }

  createAttempt(input: { runId: string; reason: AttemptReason }): AttemptRecord {
    return this.db.transaction(() => {
      const run = this.requireRun(input.runId)
      if (TERMINAL_RUN_STATUSES.has(run.status))
        fail('bad_request', `Cannot create an attempt for terminal run ${run.runId}.`)
      const max = this.db
        .statement('SELECT COALESCE(MAX(ordinal), 0) AS max FROM run_attempts WHERE run_id = ?')
        .get(run.runId)!
      const ordinal = Number(max.max) + 1
      const record: AttemptRecord = {
        attemptId: makeAttemptId(run.runId, ordinal),
        runId: run.runId,
        ordinal,
        reason: input.reason,
        status: 'pending',
        providerRef: null,
        startedAt: null,
        completedAt: null
      }
      this.db
        .statement(
          `INSERT INTO run_attempts(attempt_id, run_id, ordinal, reason, status, provider_ref,
             started_at, completed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...attemptParams(record))
      this.db
        .statement('UPDATE runs SET active_attempt_id = ? WHERE run_id = ?')
        .run(record.attemptId, run.runId)
      this.appendEvent({
        threadId: run.threadId,
        runId: run.runId,
        type: 'attempt.created',
        payload: record
      })
      return record
    })
  }

  /** Compare-and-set on `(run_id, epoch)`. Terminal statuses are final. */
  casRunStatus(input: {
    runId: string
    expectedEpoch: number
    status: RunStatus
    patch?: RunPatch
  }): RunRecord {
    return this.db.transaction(() => {
      const current = this.requireCasTarget(input.runId, input.expectedEpoch)
      const next: RunRecord = { ...current, status: input.status, epoch: current.epoch + 1 }
      const patch = input.patch ?? {}
      if (patch.startedAt !== undefined) next.startedAt = patch.startedAt
      if (patch.completedAt !== undefined) next.completedAt = patch.completedAt
      if (patch.outcome !== undefined) next.outcome = patch.outcome
      if (patch.activeAttemptId !== undefined) next.activeAttemptId = patch.activeAttemptId
      if (patch.userMessageId !== undefined) next.userMessageId = patch.userMessageId
      return this.writeCas(next, input.expectedEpoch)
    })
  }

  /** Merges `outcomePatch` into the run outcome under the same CAS rule as `casRunStatus`. */
  casRunOutcome(input: {
    runId: string
    expectedEpoch: number
    outcomePatch: Partial<RunOutcome>
  }): RunRecord {
    return this.db.transaction(() => {
      const current = this.requireCasTarget(input.runId, input.expectedEpoch)
      const outcome = JSON.parse(
        stableStringify({ ...(current.outcome ?? {}), ...input.outcomePatch })
      ) as RunOutcome
      return this.writeCas({ ...current, epoch: current.epoch + 1, outcome }, input.expectedEpoch)
    })
  }

  setAttemptStatus(input: {
    attemptId: string
    status: AttemptStatus
    providerRef?: ProviderRef | null
    startedAt?: string | null
    completedAt?: string | null
  }): AttemptRecord {
    return this.db.transaction(() => {
      const current = this.getAttempt(input.attemptId)
      if (!current) fail('bad_request', `Unknown attempt ${input.attemptId}.`)
      const next: AttemptRecord = { ...current, status: input.status }
      if (input.providerRef !== undefined) next.providerRef = input.providerRef
      if (input.startedAt !== undefined) next.startedAt = input.startedAt
      if (input.completedAt !== undefined) next.completedAt = input.completedAt
      this.db
        .statement(
          `UPDATE run_attempts SET status = ?, provider_ref = ?, started_at = ?, completed_at = ?
           WHERE attempt_id = ?`
        )
        .run(
          next.status,
          jsonOrNull(next.providerRef),
          next.startedAt,
          next.completedAt,
          next.attemptId
        )
      const run = this.requireRun(next.runId)
      this.appendEvent({
        threadId: run.threadId,
        runId: run.runId,
        type: 'attempt.status',
        payload: next
      })
      return next
    })
  }

  /**
   * Records that the executing turn is alive (SPEC §12.4 rule 2). A liveness touch, not a status
   * write: no epoch bump and no event. Returns false for an unknown or terminal run.
   */
  touchHeartbeat(runId: string, now: string): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .statement(
          `UPDATE runs SET heartbeat_at = ? WHERE run_id = ? AND status NOT IN (${TERMINAL_PLACEHOLDERS})`
        )
        .run(now, runId, ...TERMINAL_LIST)
      return Number(result.changes) === 1
    })
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.statement('SELECT * FROM runs WHERE run_id = ?').get(runId)
    return row ? toRun(row) : null
  }

  /**

   * The one run that currently owns the thread's execution (`starting|running|finalizing`).
   * Queued runs wait behind it and are listed by `listQueuedRuns`. More than one active run is
   * an invariant violation (SPEC §2.3) and raises `conflict`.
   */
  getActiveRun(threadId: string): RunRecord | null {
    const rows = this.db
      .statement(
        `SELECT * FROM runs WHERE thread_id = ? AND status IN ('starting','running','finalizing')
         ORDER BY ordinal LIMIT 2`
      )
      .all(threadId)
    if (rows.length > 1) fail('conflict', `Thread ${threadId} has more than one active run.`)
    return rows.length ? toRun(rows[0]) : null
  }

  /** Runs waiting to start on this thread, oldest first. */
  listQueuedRuns(threadId: string): RunRecord[] {
    return this.db
      .statement(`SELECT * FROM runs WHERE thread_id = ? AND status = 'queued' ORDER BY ordinal`)
      .all(threadId)
      .map(toRun)
  }

  /** Newest first. */
  listRuns(threadId: string, options: { limit?: number } = {}): RunRecord[] {
    return this.db
      .statement('SELECT * FROM runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT ?')
      .all(threadId, limit(options.limit))
      .map(toRun)
  }

  listNonTerminalRuns(): RunRecord[] {
    return this.db
      .statement(
        `SELECT * FROM runs WHERE status NOT IN (${TERMINAL_PLACEHOLDERS})
         ORDER BY thread_id, ordinal`
      )
      .all(...TERMINAL_LIST)
      .map(toRun)
  }

  /**
   * Runs a daemon shutdown interrupted (`interrupted`, `interruptedBy: 'daemon_restart'`) that
   * completed at or after `since`, oldest first (SPEC §12.5: the next boot notes them).
   */
  listInterruptedByRestartSince(since: string): RunRecord[] {
    return this.db
      .statement(
        `SELECT * FROM runs WHERE status = 'interrupted' AND completed_at >= ?
           AND json_extract(outcome, '$.interruptedBy') = 'daemon_restart'
         ORDER BY thread_id, ordinal`
      )
      .all(since)
      .map(toRun)
  }

  getAttempt(attemptId: string): AttemptRecord | null {

    const row = this.db.statement('SELECT * FROM run_attempts WHERE attempt_id = ?').get(attemptId)
    return row ? toAttempt(row) : null
  }

  listAttempts(runId: string): AttemptRecord[] {
    return this.db
      .statement('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY ordinal')
      .all(runId)
      .map(toAttempt)
  }

  getReceipt(clientRequestId: string): ReceiptRecord | null {
    const row = this.db
      .statement('SELECT * FROM receipts WHERE client_request_id = ?')
      .get(clientRequestId)
    return row ? toReceipt(row) : null
  }

  putReceipt(record: ReceiptRecord): ReceiptRecord {
    return this.db.transaction(() => {
      if (this.getReceipt(record.clientRequestId))
        fail('conflict', `Receipt ${record.clientRequestId} already exists.`)
      this.db
        .statement(
          `INSERT INTO receipts(client_request_id, thread_id, command_kind, status, result, created_at)
           VALUES(?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.clientRequestId,
          record.threadId,
          record.commandKind,
          record.status,
          jsonOrNull(record.result),
          record.createdAt
        )
      return record
    })
  }

  /** Appends to the thread's event log and returns the new `seq`. */
  appendEvent(input: {
    threadId: string
    runId?: string | null
    type: string
    payload: unknown
  }): number {
    return this.db.transaction(() => {
      const payload = stableStringify(input.payload)
      const createdAt = this.now()
      const result = this.db
        .statement(
          'INSERT INTO thread_events(thread_id, run_id, type, payload, created_at) VALUES(?, ?, ?, ?, ?)'
        )
        .run(input.threadId, input.runId ?? null, input.type, payload, createdAt)
      const seq = Number(result.lastInsertRowid)
      if (this.eventListeners.size) {
        const event: ThreadEvent = {
          seq,
          threadId: input.threadId,
          runId: input.runId ?? null,
          type: input.type,
          payload: JSON.parse(payload) as unknown,
          createdAt
        }
        this.db.afterCommit(() => {
          for (const listener of this.eventListeners) {
            try {
              listener(event)
            } catch {
              /* A listener cannot undo a durable commit. */
            }
          }
        })
      }
      return seq
    })
  }

  /** Ascending by `seq`, strictly after `afterSeq`. */
  listEvents(threadId: string, options: { afterSeq?: number; limit?: number } = {}): ThreadEvent[] {
    const afterSeq = options.afterSeq ?? 0
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      fail('bad_request', 'afterSeq must be a nonnegative integer.')
    return this.db
      .statement('SELECT * FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(threadId, afterSeq, limit(options.limit))
      .map(toEvent)
  }

  maxSeq(threadId: string): number {
    const row = this.db
      .statement('SELECT COALESCE(MAX(seq), 0) AS max FROM thread_events WHERE thread_id = ?')
      .get(threadId)!
    return Number(row.max)
  }

  private now(): string {
    return new Date(this.db.clock()).toISOString()
  }

  private requireRun(runId: string): RunRecord {
    const run = this.getRun(runId)
    if (!run) fail('bad_request', `Unknown run ${runId}.`)
    return run
  }

  private requireCasTarget(runId: string, expectedEpoch: number): RunRecord {
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)
      fail('bad_request', 'expectedEpoch must be a nonnegative integer.')
    const current = this.requireRun(runId)
    if (current.epoch !== expectedEpoch)
      fail('stale_write', `Run ${runId} is at epoch ${current.epoch}, not ${expectedEpoch}.`)
    if (TERMINAL_RUN_STATUSES.has(current.status))
      fail('bad_request', `Run ${runId} is ${current.status}; terminal states are final.`)
    return current
  }

  private writeCas(next: RunRecord, expectedEpoch: number): RunRecord {
    const result = this.db
      .statement(
        `UPDATE runs SET status = ?, epoch = epoch + 1, active_attempt_id = ?, user_message_id = ?,
           started_at = ?, completed_at = ?, outcome = ?
         WHERE run_id = ? AND epoch = ?`
      )
      .run(
        next.status,
        next.activeAttemptId,
        next.userMessageId,
        next.startedAt,
        next.completedAt,
        jsonOrNull(next.outcome),
        next.runId,
        expectedEpoch
      )
    if (Number(result.changes) !== 1)
      fail('stale_write', `Run ${next.runId} changed since epoch ${expectedEpoch}.`)
    this.appendEvent({
      threadId: next.threadId,
      runId: next.runId,
      type: 'run.status',
      payload: next
    })
    return next
  }
}

function limit(value: number | undefined): number {
  if (value === undefined) return -1
  if (!Number.isSafeInteger(value) || value < 1)
    fail('bad_request', 'limit must be a positive integer.')
  return value
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : stableStringify(value)
}

function runParams(record: RunRecord): SQLInputValue[] {
  return [
    record.runId,
    record.threadId,
    record.ordinal,
    record.status,
    record.epoch,
    record.activeAttemptId,
    record.source,
    record.clientRequestId,
    record.userMessageId,
    record.requestedAt,
    record.startedAt,
    record.completedAt,
    jsonOrNull(record.outcome)
  ]
}

function attemptParams(record: AttemptRecord): SQLInputValue[] {
  return [
    record.attemptId,
    record.runId,
    record.ordinal,
    record.reason,
    record.status,
    jsonOrNull(record.providerRef),
    record.startedAt,
    record.completedAt
  ]
}

function toRun(row: Row): RunRecord {
  return {
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    ordinal: Number(row.ordinal),
    status: row.status as RunStatus,
    epoch: Number(row.epoch),
    activeAttemptId: str(row.active_attempt_id),
    source: String(row.source),
    clientRequestId: str(row.client_request_id),
    userMessageId: str(row.user_message_id),
    requestedAt: String(row.requested_at),
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    outcome: json<RunOutcome>(row.outcome),
    heartbeatAt: str(row.heartbeat_at)
  }
}

function toAttempt(row: Row): AttemptRecord {
  return {
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    ordinal: Number(row.ordinal),
    reason: row.reason as AttemptReason,
    status: row.status as AttemptStatus,
    providerRef: json<ProviderRef>(row.provider_ref),
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at)
  }
}

function toReceipt(row: Row): ReceiptRecord {
  return {
    clientRequestId: String(row.client_request_id),
    threadId: String(row.thread_id),
    commandKind: String(row.command_kind),
    status: row.status as ReceiptRecord['status'],
    result: json<unknown>(row.result),
    createdAt: String(row.created_at)
  }
}

function toEvent(row: Row): ThreadEvent {
  return {
    seq: Number(row.seq),
    threadId: String(row.thread_id),
    runId: str(row.run_id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)) as unknown,
    createdAt: String(row.created_at)
  }
}
