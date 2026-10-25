import { randomUUID } from 'node:crypto'
import { str, type Row } from './db/rows'
import { fail } from './db/RunStoreError'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { InboxKind, InboxRecord, InboxStatus } from './types'

/** Allowed status moves. `delivered -> pending` returns a row whose delivery failed or was cut off. */
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
        createdAt: this.now(),
        deliveredBy: null
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

  /**
   * The rows a thread's parent holds about the subagent `childThreadId`, oldest first: its results
   * (`child_result`) and its questions (`child_question`, a `reconcile_notice`). `kind` narrows to one.
   */
  listForChildThread(childThreadId: string, kind?: 'child_result' | 'child_question'): InboxRecord[] {
    const results = `kind = 'child_result'`
    const questions = `(kind = 'reconcile_notice' AND json_extract(payload, '$.kind') = 'child_question')`
    const filter = kind === 'child_result' ? results : kind === 'child_question' ? questions : `(${results} OR ${questions})`
    return this.db
      .statement(
        `SELECT * FROM inbox WHERE json_extract(payload, '$.childThreadId') = ? AND ${filter}
         ORDER BY created_at, rowid`
      )
      .all(childThreadId)
      .map(toInbox)
  }

  /** Every `child_question` row that is not acknowledged yet, oldest first (boot: their requests died with the process). */
  listOpenChildQuestions(): InboxRecord[] {
    return this.db
      .statement(
        `SELECT * FROM inbox WHERE kind = 'reconcile_notice' AND json_extract(payload, '$.kind') = 'child_question'
           AND status <> 'acknowledged' ORDER BY created_at, rowid`
      )
      .all()
      .map(toInbox)
  }

  /**
   * Delivered rows whose delivery reached the run `runId`, oldest first: those of its wake `turn.start`
   * (or of a queued steer's), and those of a `turn.steer` that the model read (`markSteerTaken`). A
   * steer that has not run yet, or that the turn took but never read, has delivered nothing: the run
   * may end first, and then the steer is queued as a turn of its own.
   */
  listDeliveredByRun(runId: string): InboxRecord[] {
    return this.db
      .statement(
        `SELECT i.* FROM inbox i JOIN effects e ON e.effect_id = i.delivered_by
         WHERE i.status = 'delivered' AND e.run_id = ?
           AND (e.kind <> 'turn.steer' OR json_extract(i.payload, '$.steerTakenBy') = i.delivered_by)
         ORDER BY i.created_at, i.rowid`
      )
      .all(runId)
      .map(toInbox)
  }

  /** Delivered rows that a queue item carries (`queue:<itemId>`), oldest first. */
  listDeliveredByQueue(): InboxRecord[] {
    return this.db
      .statement(`SELECT * FROM inbox WHERE status = 'delivered' AND delivered_by LIKE 'queue:%' ORDER BY created_at, rowid`)
      .all()
      .map(toInbox)
  }

  /**
   * Gives rows back without a failure: delivered -> pending, not counted as a delivery attempt
   * (`pendingCount` skips it), for a delivery that never started or was withdrawn (a queued
   * notice the user removed). With `from`, only rows that owner still delivers move.
   */
  release(ids: readonly string[], from?: string): string[] {
    return this.db.transaction(() => {
      const moved: string[] = []
      for (const id of ids) {
        const current = this.get(id)
        if (!current || current.status !== 'delivered') continue
        if (from !== undefined && current.deliveredBy !== from) continue
        // Recorded while the row is still delivered, so the pending write below is the only one counted.
        this.patchPayload(id, { releases: Number((current.payload as { releases?: unknown } | null)?.releases ?? 0) + 1 })
        this.markPendingAgain([id])
        moved.push(id)
      }
      return moved
    })
  }

  /**
   * A delivery the user stopped: the rows stay `delivered` (as before) but belong to nothing, so
   * neither the reconciler nor boot gives them back. With `from`, only rows that owner delivers.
   */
  detachDelivery(ids: readonly string[], from: string): void {
    this.db.transaction(() => {
      for (const id of ids) {
        const current = this.get(id)
        if (current?.status !== 'delivered' || current.deliveredBy !== from) continue
        this.db.statement('UPDATE inbox SET delivered_by = NULL WHERE inbox_id = ? AND status = ?').run(id, 'delivered')
        this.recorded({ ...current, deliveredBy: null })
        // Owned by nothing now: it no longer holds the tasks waiting on its thread.
        this.store.settleHold(current.threadId)
      }
    })
  }

  /**
   * The live turn holds the steer `effectId` carried (it is in the turn's pending steers, not read
   * yet). Only code that holds steers writes this, so rows of a steer delivered before it existed
   * (a native steer of an older version) are never mistaken for an unread one.
   */
  markSteerHeld(ids: readonly string[], effectId: string): void {
    this.db.transaction(() => {
      for (const id of ids) {
        const current = this.get(id)
        if (current?.status === 'delivered' && current.deliveredBy === effectId) this.patchPayload(id, { steerHeldBy: effectId })
      }
    })
  }

  /** The model read the steer `effectId` carried: its rows count as delivered to that run. */
  markSteerTaken(ids: readonly string[], effectId: string): void {
    this.db.transaction(() => {
      for (const id of ids) {
        const current = this.get(id)
        if (current?.status === 'delivered' && current.deliveredBy === effectId) this.patchPayload(id, { steerTakenBy: effectId })
      }
    })
  }

  /**
   * Records what the notice that delivers these rows showed (`noticeShown`: the task's whole result
   * was in it), so that acknowledging them later marks as read exactly the tasks that were shown.
   */
  recordNoticeVisibility(rows: readonly InboxRecord[], items: ReadonlyArray<{ delegationId: string; fullyShown: boolean }>): void {
    this.db.transaction(() => {
      for (const row of rows) {
        if (row.kind !== 'child_result') continue
        const item = items.find((entry) => entry.delegationId === (row.payload as { delegationId?: string }).delegationId)
        if (item) this.patchPayload(row.inboxId, { noticeShown: item.fullyShown })
      }
    })
  }

  /**
   * A delivered row changes hands: its notice now rides another effect, or a queued turn
   * (`queue:<itemId>`). With `from`, only a row that `from` still delivers moves, so a row some other
   * delivery took over in the meantime is left alone. The row stays `delivered`.
   */
  redirectDelivery(ids: readonly string[], deliveredBy: string, from?: string): InboxRecord[] {
    return this.db.transaction(() => {
      const moved: InboxRecord[] = []
      for (const id of ids) {
        const current = this.get(id)
        if (!current || current.status !== 'delivered' || current.deliveredBy === deliveredBy) continue
        if (from !== undefined && current.deliveredBy !== from) continue
        this.db.statement('UPDATE inbox SET delivered_by = ? WHERE inbox_id = ? AND status = ?').run(deliveredBy, id, 'delivered')
        const next = { ...current, deliveredBy }
        this.recorded(next)
        moved.push(next)
      }
      for (const threadId of new Set(moved.map((row) => row.threadId))) this.store.settleHold(threadId)
      return moved
    })
  }

  /** Merges `patch` into the row's payload object (a `null` value removes the key). */
  patchPayload(inboxId: string, patch: Record<string, unknown>): InboxRecord {
    return this.db.transaction(() => {
      const current = this.get(inboxId)
      if (!current) fail('bad_request', `Unknown inbox row ${inboxId}.`)
      const merged: Record<string, unknown> = { ...((current.payload as Record<string, unknown> | null) ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key]
        else merged[key] = value
      }
      const payload = JSON.parse(stableStringify(merged)) as unknown
      this.db.statement('UPDATE inbox SET payload = ? WHERE inbox_id = ?').run(stableStringify(payload), inboxId)
      const next = { ...current, payload }
      this.recorded(next)
      // A delivery that gave up (`deliveryFailed`) no longer holds the thread's tasks.
      this.store.settleHold(next.threadId)
      return next
    })
  }

  /**
   * pending -> delivered by `deliveredBy` (the wake `turn.start` or `turn.steer` effect carrying the
   * rows), so a failed or cut-off delivery can return them to pending. Rows already past `pending`
   * are left alone.
   */
  markDelivered(ids: readonly string[], deliveredBy: string | null = null): InboxRecord[] {
    return this.move(ids, 'delivered', ['pending'], deliveredBy)
  }

  /** Delivered rows that name the effect that delivered them, oldest first. */
  listDeliveredWithEffect(): InboxRecord[] {
    return this.db
      .statement(
        `SELECT * FROM inbox WHERE status = 'delivered' AND delivered_by IS NOT NULL ORDER BY created_at, rowid`
      )
      .all()
      .map(toInbox)
  }

  /** How many times the row has been `pending` (its first write included). */
  pendingCount(inboxId: string, threadId: string): number {
    const row = this.db
      .statement(
        `SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ? AND type = 'inbox.status'
           AND json_extract(payload, '$.inboxId') = ? AND json_extract(payload, '$.status') = 'pending'`
      )
      .get(threadId, inboxId)
    // Releases (a withdrawn delivery) are not attempts.
    return Number(row?.n ?? 0) - Number((this.get(inboxId)?.payload as { releases?: unknown } | null)?.releases ?? 0)
  }

  /** pending|delivered -> acknowledged. */
  markAcknowledged(ids: readonly string[]): InboxRecord[] {
    return this.move(ids, 'acknowledged', ['pending', 'delivered'])
  }

  /** delivered -> pending: a delivery that failed or was cut off before it ran. */
  markPendingAgain(ids: readonly string[]): InboxRecord[] {
    return this.move(ids, 'pending', ['delivered'], null)
  }

  /** `deliveredBy`: the delivering effect to store; undefined keeps the stored one. */
  private move(ids: readonly string[], to: InboxStatus, from: InboxStatus[], deliveredBy?: string | null): InboxRecord[] {
    return this.db.transaction(() => {
      const moved: InboxRecord[] = []
      for (const id of ids) {
        const current = this.get(id)
        if (!current) fail('bad_request', `Unknown inbox row ${id}.`)
        if (!from.includes(current.status) || !TRANSITIONS[current.status].has(to)) continue
        const by = deliveredBy === undefined ? current.deliveredBy : deliveredBy
        const result = this.db
          .statement('UPDATE inbox SET status = ?, delivered_by = ? WHERE inbox_id = ? AND status = ?')
          .run(to, by, id, current.status)
        if (Number(result.changes) !== 1)
          fail('stale_write', `Inbox row ${id} changed while it was being updated.`)
        const next = { ...current, status: to, deliveredBy: by }
        this.recorded(next)
        moved.push(next)
      }
      // Any move can change what keeps the thread busy (an acknowledged row stops holding its tasks).
      for (const threadId of new Set(moved.map((row) => row.threadId))) this.store.settleHold(threadId)
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
    runId: str(row.run_id),
    kind: row.kind as InboxKind,
    payload: JSON.parse(String(row.payload)) as unknown,
    status: row.status as InboxStatus,
    createdAt: String(row.created_at),
    deliveredBy: str(row.delivered_by)
  }
}
