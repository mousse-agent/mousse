import { randomUUID } from 'node:crypto'
import { fail } from './db/RunStoreError'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { InboxKind, InboxRecord, InboxStatus } from './types'

type Row = Record<string, unknown>

/** Allowed status moves. `delivered -> pending` is boot recovery of a wake that never ran. */
const TRANSITIONS: Record<InboxStatus, ReadonlySet<InboxStatus>> = {
  pending: new Set<InboxStatus>(['delivered', 'acknowledged']),
  delivered: new Set<InboxStatus>(['acknowledged', 'pending']),
  acknowledged: new Set<InboxStatus>()
}

/**
 * Stored notifications for a thread (docs/run-engine/SPEC.md §14.1). A child's result is one
 * `child_result` row written in the child's terminal transaction; the reconciler (rule 4) wakes
 * the thread for its pending rows. Every write joins the caller's transaction or opens one and
 * appends an `inbox.status` thread event carrying the full row.
 */
export class Inbox {
  constructor(private readonly store: RunStore) {}

  append(input: {
    threadId: string
    runId?: string | null
    kind: InboxKind
    payload: unknown
    inboxId?: string
  }): InboxRecord {
    return this.db.transaction(() => {
      const record: InboxRecord = {
        inboxId: input.inboxId ?? `inbox:${randomUUID()}`,
        threadId: input.threadId,
        runId: input.runId ?? null,
        kind: input.kind,
        payload: JSON.parse(stableStringify(input.payload ?? null)) as unknown,
        status: 'pending',
        createdAt: this.now()
      }
      this.db
        .statement(
          `INSERT INTO inbox(inbox_id, thread_id, run_id, kind, payload, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.inboxId,
          record.threadId,
          record.runId,
          record.kind,
          stableStringify(record.payload),
          record.status,
          record.createdAt
        )
      this.recorded(record)
      return record
    })
  }

  get(inboxId: string): InboxRecord | null {
    const row = this.db.statement('SELECT * FROM inbox WHERE inbox_id = ?').get(inboxId)
    return row ? toInbox(row) : null
  }

  /** Rows in `ids` that exist, in the order given. */
  getMany(ids: readonly string[]): InboxRecord[] {
    return ids.map((id) => this.get(id)).filter((row): row is InboxRecord => row !== null)
  }

  /** Oldest first. */
  listPending(threadId: string): InboxRecord[] {
    return this.listByStatus(threadId, 'pending')
  }

  listByStatus(threadId: string, status: InboxStatus): InboxRecord[] {
    return this.db
      .statement(
        `SELECT * FROM inbox WHERE thread_id = ? AND status = ? ORDER BY created_at, rowid`
      )
      .all(threadId, status)
      .map(toInbox)
  }

  /** Oldest first. */
  listForThread(threadId: string): InboxRecord[] {
    return this.db
      .statement('SELECT * FROM inbox WHERE thread_id = ? ORDER BY created_at, rowid')
      .all(threadId)
      .map(toInbox)
  }

  /** Threads with at least one pending row. */
  listThreadsWithPending(): string[] {
    return this.db
      .statement(
        `SELECT thread_id, MIN(rowid) AS first FROM inbox WHERE status = 'pending'
         GROUP BY thread_id ORDER BY first`
      )
      .all()
      .map((row) => String(row.thread_id))
  }

  /** `child_result` rows of one delegation, oldest first. */
  listForDelegation(delegationId: string): InboxRecord[] {
    return this.db
      .statement(
        `SELECT * FROM inbox WHERE kind = 'child_result'
           AND json_extract(payload, '$.delegationId') = ? ORDER BY created_at, rowid`
      )
      .all(delegationId)
      .map(toInbox)
  }

  /** pending -> delivered. Rows already past `pending` are left alone. */
  markDelivered(ids: readonly string[]): InboxRecord[] {
    return this.move(ids, 'delivered', ['pending'])
  }

  /** pending|delivered -> acknowledged. */
  markAcknowledged(ids: readonly string[]): InboxRecord[] {
    return this.move(ids, 'acknowledged', ['pending', 'delivered'])
  }

  /** delivered -> pending: a wake that was cut off before it ran (boot recovery). */
  markPendingAgain(ids: readonly string[]): InboxRecord[] {
    return this.move(ids, 'pending', ['delivered'])
  }

  private move(ids: readonly string[], to: InboxStatus, from: InboxStatus[]): InboxRecord[] {
    return this.db.transaction(() => {
      const moved: InboxRecord[] = []
      for (const id of ids) {
        const current = this.get(id)
        if (!current) fail('bad_request', `Unknown inbox row ${id}.`)
        if (!from.includes(current.status) || !TRANSITIONS[current.status].has(to)) continue
        const result = this.db
          .statement('UPDATE inbox SET status = ? WHERE inbox_id = ? AND status = ?')
          .run(to, id, current.status)
        if (Number(result.changes) !== 1)
          fail('stale_write', `Inbox row ${id} changed while it was being updated.`)
        const next = { ...current, status: to }
        this.recorded(next)
        moved.push(next)
      }
      return moved
    })
  }

  private recorded(record: InboxRecord): void {
    this.store.appendEvent({
      threadId: record.threadId,
      runId: record.runId,
      type: 'inbox.status',
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

function toInbox(row: Row): InboxRecord {
  return {
    inboxId: String(row.inbox_id),
    threadId: String(row.thread_id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    kind: row.kind as InboxKind,
    payload: JSON.parse(String(row.payload)) as unknown,
    status: row.status as InboxStatus,
    createdAt: String(row.created_at)
  }
}
