import { createHash, randomUUID } from 'node:crypto'
import { fail } from './db/RunStoreError'
import { Inbox } from './Inbox'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type {
  ChildResultPayload,
  DelegationRecord,
  DelegationResult,
  DelegationStatus,
  DelegationWake,
  LineageRecord,
  LineageRelationship,
  RunRecord
} from './types'

type Row = Record<string, unknown>

/** Characters of a child's final text kept in its delegation row. */
export const DELEGATION_RESULT_MAX_CHARS = 64_000

/** Allowed delegation status moves (SPEC §14.1). */
const TRANSITIONS: Record<DelegationStatus, ReadonlySet<DelegationStatus>> = {
  running: new Set<DelegationStatus>(['result_available', 'cancelled', 'failed']),
  result_available: new Set<DelegationStatus>(['acknowledged', 'cancelled']),
  acknowledged: new Set<DelegationStatus>(),
  cancelled: new Set<DelegationStatus>(),
  failed: new Set<DelegationStatus>(['acknowledged'])
}

export function promptDigest(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}

/**
 * Lineage and delegation rows (docs/run-engine/SPEC.md §14.1). Synchronous; every write joins the
 * caller's transaction or opens one and appends a thread event (`thread.lineage` on the child
 * thread, `delegation.status` on the parent thread) carrying the full row.
 */
export class Delegations {
  private readonly inbox: Inbox

  constructor(
    private readonly store: RunStore,
    inbox?: Inbox
  ) {
    this.inbox = inbox ?? new Inbox(store)
  }

  createLineage(input: {
    threadId: string
    parentThreadId: string
    parentRunId: string
    relationship: LineageRelationship
  }): LineageRecord {
    return this.db.transaction(() => {
      if (this.getLineage(input.threadId)) fail('conflict', `Thread ${input.threadId} already has lineage.`)
      if (input.threadId === input.parentThreadId) fail('bad_request', 'A thread cannot be its own parent.')
      const record: LineageRecord = { ...input, createdAt: this.now() }
      this.db
        .statement(
          `INSERT INTO thread_lineage(thread_id, parent_thread_id, parent_run_id, relationship, created_at)
           VALUES(?, ?, ?, ?, ?)`
        )
        .run(record.threadId, record.parentThreadId, record.parentRunId, record.relationship, record.createdAt)
      this.store.appendEvent({ threadId: record.threadId, type: 'thread.lineage', payload: record })
      return record
    })
  }

  getLineage(threadId: string): LineageRecord | null {
    const row = this.db.statement('SELECT * FROM thread_lineage WHERE thread_id = ?').get(threadId)
    return row ? toLineage(row) : null
  }

  /** Child threads of `parentThreadId`, oldest first. */
  listChildThreads(parentThreadId: string): LineageRecord[] {
    return this.db
      .statement('SELECT * FROM thread_lineage WHERE parent_thread_id = ? ORDER BY created_at, rowid')
      .all(parentThreadId)
      .map(toLineage)
  }

  create(input: {
    delegationId?: string
    parentRunId: string
    parentThreadId: string
    childThreadId: string
    childRunId: string
    provider?: string | null
    model?: string | null
    prompt: string
    wake: DelegationWake
  }): DelegationRecord {
    return this.db.transaction(() => {
      const record: DelegationRecord = {
        delegationId: input.delegationId ?? `delegation:${randomUUID()}`,
        parentRunId: input.parentRunId,
        parentThreadId: input.parentThreadId,
        childThreadId: input.childThreadId,
        childRunId: input.childRunId,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptDigest: promptDigest(input.prompt),
        wake: input.wake,
        status: 'running',
        result: null,
        createdAt: this.now(),
        completedAt: null
      }
      this.db
        .statement(
          `INSERT INTO delegations(delegation_id, parent_run_id, parent_thread_id, child_thread_id,
             child_run_id, provider, model, prompt_digest, wake, status, result, created_at, completed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.delegationId,
          record.parentRunId,
          record.parentThreadId,
          record.childThreadId,
          record.childRunId,
          record.provider,
          record.model,
          record.promptDigest,
          record.wake,
          record.status,
          null,
          record.createdAt,
          null
        )
      this.recorded(record)
      return record
    })
  }

  get(delegationId: string): DelegationRecord | null {
    const row = this.db.statement('SELECT * FROM delegations WHERE delegation_id = ?').get(delegationId)
    return row ? toDelegation(row) : null
  }

  /** Oldest first. */
  listForParentRun(parentRunId: string): DelegationRecord[] {
    return this.list('parent_run_id', parentRunId)
  }

  /** Oldest first. */
  listForParentThread(parentThreadId: string): DelegationRecord[] {
    return this.list('parent_thread_id', parentThreadId)
  }

  /** Oldest first. */
  listForChildThread(childThreadId: string): DelegationRecord[] {
    return this.list('child_thread_id', childThreadId)
  }

  getByChildRun(childRunId: string): DelegationRecord | null {
    const row = this.db
      .statement('SELECT * FROM delegations WHERE child_run_id = ? ORDER BY rowid LIMIT 1')
      .get(childRunId)
    return row ? toDelegation(row) : null
  }

  /**
   * Compare-and-set on the stored status: `from` must be the current status and the move must be
   * allowed. A miss raises `stale_write` (the caller lost a race) or `bad_request`.
   */
  setStatus(input: {
    delegationId: string
    from: DelegationStatus
    to: DelegationStatus
    result?: DelegationResult | null
    completedAt?: string | null
  }): DelegationRecord {
    return this.db.transaction(() => {
      const current = this.get(input.delegationId)
      if (!current) fail('bad_request', `Unknown delegation ${input.delegationId}.`)
      if (current.status !== input.from)
        fail('stale_write', `Delegation ${input.delegationId} is ${current.status}, not ${input.from}.`)
      if (!TRANSITIONS[current.status].has(input.to))
        fail('bad_request', `Delegation ${input.delegationId} cannot move from ${current.status} to ${input.to}.`)
      const next: DelegationRecord = {
        ...current,
        status: input.to,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {})
      }
      const changed = this.db
        .statement(
          `UPDATE delegations SET status = ?, result = ?, completed_at = ?
           WHERE delegation_id = ? AND status = ?`
        )
        .run(
          next.status,
          next.result ? stableStringify(next.result) : null,
          next.completedAt,
          next.delegationId,
          input.from
        )
      if (Number(changed.changes) !== 1)
        fail('stale_write', `Delegation ${input.delegationId} changed while it was being updated.`)
      this.recorded(next)
      return next
    })
  }

  /**
   * Publication gate (SPEC §14.1), called inside a run's terminal write. When `run` is the child
   * run of a delegation on a `subagent` child thread and that delegation is still `running`, the
   * delegation becomes `result_available` with the run's final text (or failure) and one
   * `child_result` inbox row is written for the parent thread, in the same transaction. A cancelled
   * delegation publishes nothing: a late child can finish but not publish. Never throws for a run
   * that is not a delegated child.
   */
  publishResult(run: RunRecord, resultText?: string): DelegationRecord | null {
    return this.db.transaction(() => {
      const lineage = this.getLineage(run.threadId)
      if (!lineage || lineage.relationship !== 'subagent') return null
      const delegation = this.getByChildRun(run.runId)
      if (!delegation || delegation.childThreadId !== run.threadId || delegation.status !== 'running')
        return null
      const result = childResult(run, resultText)
      const now = this.now()
      const next = this.setStatus({
        delegationId: delegation.delegationId,
        from: 'running',
        to: 'result_available',
        result,
        completedAt: now
      })
      const payload: ChildResultPayload = {
        delegationId: delegation.delegationId,
        childThreadId: delegation.childThreadId,
        childRunId: delegation.childRunId,
        result
      }
      this.inbox.append({
        threadId: delegation.parentThreadId,
        runId: delegation.parentRunId,
        kind: 'child_result',
        payload
      })
      return next
    })
  }

  private list(column: 'parent_run_id' | 'parent_thread_id' | 'child_thread_id', value: string): DelegationRecord[] {
    return this.db
      .statement(`SELECT * FROM delegations WHERE ${column} = ? ORDER BY created_at, rowid`)
      .all(value)
      .map(toDelegation)
  }

  private recorded(record: DelegationRecord): void {
    this.store.appendEvent({
      threadId: record.parentThreadId,
      runId: record.parentRunId,
      type: 'delegation.status',
      payload: record
    })
  }

  private get db() {
    return this.store.db
  }

  private now(): string {
    return new Date(this.db.clock()).toISOString()
  }
}

/** The stored result of a terminal child run. */
export function childResult(run: RunRecord, resultText?: string): DelegationResult {
  const text = resultText?.slice(0, DELEGATION_RESULT_MAX_CHARS)
  if (run.status === 'completed') return { runStatus: run.status, text: text ?? '' }
  const error =
    run.outcome?.error ??
    run.outcome?.uncertainReason ??
    (run.outcome?.interruptedBy ? `interrupted by ${run.outcome.interruptedBy}` : run.status)
  return { runStatus: run.status, ...(text ? { text } : {}), error }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toLineage(row: Row): LineageRecord {
  return {
    threadId: String(row.thread_id),
    parentThreadId: String(row.parent_thread_id),
    parentRunId: String(row.parent_run_id),
    relationship: row.relationship as LineageRelationship,
    createdAt: String(row.created_at)
  }
}

function toDelegation(row: Row): DelegationRecord {
  return {
    delegationId: String(row.delegation_id),
    parentRunId: String(row.parent_run_id),
    parentThreadId: String(row.parent_thread_id),
    childThreadId: String(row.child_thread_id),
    childRunId: String(row.child_run_id),
    provider: str(row.provider),
    model: str(row.model),
    promptDigest: String(row.prompt_digest),
    wake: row.wake as DelegationWake,
    status: row.status as DelegationStatus,
    result: typeof row.result === 'string' ? (JSON.parse(row.result) as DelegationResult) : null,
    createdAt: String(row.created_at),
    completedAt: str(row.completed_at)
  }
}
