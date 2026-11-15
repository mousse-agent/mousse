import { randomUUID } from 'node:crypto'
import { int, str, type Row } from '../db/rows'
import type { RunStore } from '../RunStore'

/**
 * The watches of the settle notice (SPEC §15.1, table `thread_watches`, migration 20): one per message an agent sent
 * with `notify`. A watch is keyed on the message (`messageKey`, the send's request key), not on a run: `runId` is the
 * run that carries the message now and moves with it. What a watch is about (`targetThreadId`, and `targetNode` for a
 * thread on another computer) is kept apart from how it learns about that thread, which is the follower's.
 */

export type ThreadWatchState = 'active' | 'ended' | 'expired'
export type NoticeDelivery = 'due' | 'sent'

export interface ThreadWatchRecord {
  watchId: string
  messageKey: string
  watcherThreadId: string
  watcherRunId: string
  /** The sender's stop generation when it subscribed: a Stop of the sender after it means no notice starts a turn there. */
  watcherStopGeneration: number
  /** Null for a thread on this computer. */
  targetNode: string | null
  targetThreadId: string
  /** The run that carries the message now; null only while a re-queued message waits for its run. */
  runId: string | null
  /** The queue item that carried the message, when it was queued (it keeps its id through an edit, a steer and a hand-back). */
  queueItemId: string | null
  state: ThreadWatchState
  needsInput: NoticeDelivery | null
  endNotice: NoticeDelivery | null
  /** How the work ended: a run status, `removed` when the message left the queue before it ran, or `deleted`. */
  endStatus: string | null
  createdAt: string
  expiresAt: string
  updatedAt: string
}

export interface NewThreadWatch {
  messageKey: string
  watcherThreadId: string
  watcherRunId: string
  watcherStopGeneration: number
  targetNode?: string | null
  targetThreadId: string
  runId: string
  queueItemId?: string | null
  ttlMs: number
}

function toWatch(row: Row): ThreadWatchRecord {
  return {
    watchId: String(row.watch_id),
    messageKey: String(row.message_key),
    watcherThreadId: String(row.watcher_thread_id),
    watcherRunId: String(row.watcher_run_id),
    watcherStopGeneration: int(row.watcher_stop_generation) ?? 0,
    targetNode: str(row.target_node),
    targetThreadId: String(row.target_thread_id),
    runId: str(row.run_id),
    queueItemId: str(row.queue_item_id),
    state: String(row.state) as ThreadWatchState,
    needsInput: str(row.needs_input) as NoticeDelivery | null,
    endNotice: str(row.end_notice) as NoticeDelivery | null,
    endStatus: str(row.end_status),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    updatedAt: String(row.updated_at)
  }
}

export class ThreadWatches {
  constructor(private readonly store: RunStore, private readonly now: () => Date = () => new Date()) {}

  /** The watch of `messageKey`, made once: a retry of the same send gets the watch it already has. */
  create(input: NewThreadWatch): { watch: ThreadWatchRecord; created: boolean } {
    return this.store.db.transaction(() => {
      const existing = this.byMessageKey(input.messageKey)
      if (existing) return { watch: existing, created: false }
      const now = this.now()
      const at = now.toISOString()
      this.store.db
        .statement(
          `INSERT INTO thread_watches(watch_id, message_key, watcher_thread_id, watcher_run_id, watcher_stop_generation,
             target_node, target_thread_id, run_id, queue_item_id, state, created_at, expires_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        )
        .run(
          `watch:${randomUUID()}`,
          input.messageKey,
          input.watcherThreadId,
          input.watcherRunId,
          input.watcherStopGeneration,
          input.targetNode ?? null,
          input.targetThreadId,
          input.runId,
          input.queueItemId ?? null,
          at,
          new Date(now.getTime() + input.ttlMs).toISOString(),
          at
        )
      return { watch: this.byMessageKey(input.messageKey)!, created: true }
    })
  }

  get(watchId: string): ThreadWatchRecord | null {
    const row = this.store.db.statement('SELECT * FROM thread_watches WHERE watch_id = ?').get(watchId)
    return row ? toWatch(row) : null
  }

  byMessageKey(messageKey: string): ThreadWatchRecord | null {
    const row = this.store.db.statement('SELECT * FROM thread_watches WHERE message_key = ?').get(messageKey)
    return row ? toWatch(row) : null
  }

  /** Active watches on this computer's threads, optionally of one target thread, oldest first. */
  listActive(targetThreadId?: string): ThreadWatchRecord[] {
    const rows = targetThreadId
      ? this.store.db.statement(`SELECT * FROM thread_watches WHERE state = 'active' AND target_node IS NULL AND target_thread_id = ? ORDER BY created_at, rowid`).all(targetThreadId)
      : this.store.db.statement(`SELECT * FROM thread_watches WHERE state = 'active' AND target_node IS NULL ORDER BY created_at, rowid`).all()
    return rows.map(toWatch)
  }

  /** Active watches on threads of other computers (followed there by `RemoteSettleFollower`), oldest first. */
  listActiveRemote(): ThreadWatchRecord[] {
    return this.store.db
      .statement(`SELECT * FROM thread_watches WHERE state = 'active' AND target_node IS NOT NULL ORDER BY created_at, rowid`)
      .all()
      .map(toWatch)
  }

  /** Watches with a notice decided but not yet in the sender's queue (a restart in between). */
  listDue(): ThreadWatchRecord[] {
    return this.store.db
      .statement(`SELECT * FROM thread_watches WHERE needs_input = 'due' OR end_notice = 'due' ORDER BY updated_at, rowid`)
      .all()
      .map(toWatch)
  }

  /** The earliest expiry of an active watch, or undefined. */
  nextExpiry(): string | undefined {
    const row = this.store.db.statement(`SELECT MIN(expires_at) AS at FROM thread_watches WHERE state = 'active'`).get()
    return str(row?.at) ?? undefined
  }

  /** The run (and queue item) that carries the message now. */
  follow(watchId: string, runId: string | null, queueItemId?: string | null): void {
    this.store.db
      .statement(`UPDATE thread_watches SET run_id = ?, queue_item_id = COALESCE(?, queue_item_id), updated_at = ? WHERE watch_id = ? AND state = 'active'`)
      .run(runId, queueItemId ?? null, this.now().toISOString(), watchId)
  }

  /** Decides the needs-input notice, once per watch: false when it was decided before or the watch is over. */
  markNeedsInput(watchId: string): boolean {
    const result = this.store.db
      .statement(`UPDATE thread_watches SET needs_input = 'due', updated_at = ? WHERE watch_id = ? AND state = 'active' AND needs_input IS NULL`)
      .run(this.now().toISOString(), watchId)
    return Number(result.changes) > 0
  }

  /** Ends the watch with its end notice due, once: false when it had ended or expired already. */
  markEnded(watchId: string, status: string, runId: string | null): boolean {
    const result = this.store.db
      .statement(`UPDATE thread_watches SET state = 'ended', end_status = ?, run_id = COALESCE(?, run_id), end_notice = 'due', updated_at = ? WHERE watch_id = ? AND state = 'active'`)
      .run(status, runId, this.now().toISOString(), watchId)
    return Number(result.changes) > 0
  }

  /** Ends the watch because 24 h passed, with its notice due, once. */
  markExpired(watchId: string): boolean {
    const result = this.store.db
      .statement(`UPDATE thread_watches SET state = 'expired', end_notice = 'due', updated_at = ? WHERE watch_id = ? AND state = 'active'`)
      .run(this.now().toISOString(), watchId)
    return Number(result.changes) > 0
  }

  /** The notice is in the sender's queue (or the sender is gone and nobody will read it). */
  markSent(watchId: string, which: 'needs_input' | 'end'): void {
    const column = which === 'needs_input' ? 'needs_input' : 'end_notice'
    this.store.db
      .statement(`UPDATE thread_watches SET ${column} = 'sent', updated_at = ? WHERE watch_id = ? AND ${column} = 'due'`)
      .run(this.now().toISOString(), watchId)
  }
}
