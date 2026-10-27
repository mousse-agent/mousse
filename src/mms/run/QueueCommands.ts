import type { AgentOrigin, QueuedMessage } from '../../shared/types'
import type { PermissionMode } from '../../shared/permissionMode'
import type { ProfileDatabase } from './db/ProfileDatabase'
import { stableStringify } from './json'
import type { AgentActor } from './types'

/**
 * The journal of an agent's changes to queued messages (issue #184). A change is written here, in full, before
 * the queue file changes, so it can be finished from the entry alone after a crash and so a retry of the same
 * request returns the first result whatever the queue looks like by then. Same pattern as the Stop fence
 * (`stopGeneration.ts`): small functions over the run database.
 */

export type QueueOp = 'enqueue' | 'edit' | 'remove' | 'reorder' | 'promote'

export type QueueCommandStatus = 'pending' | 'effects_pending' | 'applied' | 'failed'

/** An entry that cannot be finished is tried this many times, and then left alone (`failed`). */
export const QUEUE_COMMAND_MAX_ATTEMPTS = 5

/** Finished entries are kept this long (a retry of a request this old is not a retry), then pruned. */
export const QUEUE_COMMAND_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** The complete change, including the side effects the item implies, captured before anything is stripped from it. */
export interface QueueIntent {
  op: QueueOp
  /** The thread whose queue changes. */
  threadId: string
  /** The item the change concerns (the new item for an enqueue). */
  itemId: string
  /** enqueue: the item as it is queued. */
  item?: QueuedMessage
  /** edit: the new text, mode, origin and ceiling. */
  patch?: { content?: string; mode?: QueuedMessage['mode']; origin?: AgentOrigin; permissionMode?: PermissionMode; dropRun?: boolean }
  /** reorder: the new order of the pending items. */
  orderedIds?: string[]
  expectedRevision?: string
  expectedRunId?: string
  /** promote: the run the promotion was checked against, and the mode the item keeps. */
  steerRunId?: string
  permissionMode?: PermissionMode
  /** Who made the change; none for a person's. */
  actor?: AgentActor | null
  /** Queued runs that end `cancelled` with the item (promote, remove). */
  cancelRunIds: string[]
  /** Notice rows the item holds, given back when it is removed. */
  releaseInboxIds: string[]
  abandonWorkflowInvocationId?: string
  /** The agent-supplied fields of the command (not the revision it read): a request id reused for other fields is not a retry. */
  fingerprint?: string
}

export interface QueueCommandRow {
  commandKey: string
  threadId: string
  intent: QueueIntent
  status: QueueCommandStatus
  result: Record<string, unknown> | null
  attempts: number
  createdAt: string
  appliedAt: string | null
}

function toRow(row: Record<string, unknown>): QueueCommandRow {
  return {
    commandKey: String(row.command_key),
    threadId: String(row.thread_id),
    intent: JSON.parse(String(row.intent)) as QueueIntent,
    status: String(row.status) as QueueCommandStatus,
    attempts: Number(row.attempts ?? 0),
    result: typeof row.result === 'string' ? (JSON.parse(row.result) as Record<string, unknown>) : null,
    createdAt: String(row.created_at),
    appliedAt: typeof row.applied_at === 'string' ? row.applied_at : null
  }
}

/** What is kept of a change once it is applied: enough to tell a retry from a reused request id, no text. */
function compact(intent: QueueIntent): Pick<QueueIntent, 'op' | 'threadId' | 'itemId' | 'cancelRunIds' | 'releaseInboxIds' | 'fingerprint'> {
  return { op: intent.op, threadId: intent.threadId, itemId: intent.itemId, cancelRunIds: [], releaseInboxIds: [], ...(intent.fingerprint ? { fingerprint: intent.fingerprint } : {}) }
}

export class QueueCommands {
  constructor(readonly db: ProfileDatabase) {}

  get(commandKey: string): QueueCommandRow | null {
    const row = this.db.statement('SELECT * FROM queue_commands WHERE command_key = ?').get(commandKey)
    return row ? toRow(row) : null
  }

  /** Joins the caller's transaction (the intent and the `agent.action` event commit together). */
  insertPending(commandKey: string, intent: QueueIntent): void {
    this.db
      .statement("INSERT INTO queue_commands(command_key, thread_id, intent, status, created_at) VALUES(?, ?, ?, 'pending', ?)")
      .run(commandKey, intent.threadId, stableStringify(intent), new Date(this.db.clock()).toISOString())
  }

  /** The entries of a thread whose change or effects are not finished, oldest first: one indexed query. */
  listUnfinished(threadId: string): QueueCommandRow[] {
    return this.db
      .statement("SELECT * FROM queue_commands WHERE thread_id = ? AND status IN ('pending','effects_pending') ORDER BY created_at, rowid")
      .all(threadId)
      .map(toRow)
  }

  /** Every thread with an unfinished entry (boot repair). */
  unfinishedThreadIds(): string[] {
    return this.db
      .statement("SELECT DISTINCT thread_id FROM queue_commands WHERE status IN ('pending','effects_pending')")
      .all()
      .map((row) => String(row.thread_id))
  }

  markApplied(row: QueueCommandRow, result: Record<string, unknown>): void {
    this.db
      .statement("UPDATE queue_commands SET status = 'applied', result = ?, intent = ?, applied_at = ? WHERE command_key = ?")
      .run(stableStringify(result), stableStringify(compact(row.intent)), new Date(this.db.clock()).toISOString(), row.commandKey)
  }

  /** The change is in the queue file but an effect did not commit; the result is fixed and the effects are retried. */
  markEffectsPending(row: QueueCommandRow, result: Record<string, unknown>): void {
    this.db.statement("UPDATE queue_commands SET status = 'effects_pending', result = ? WHERE command_key = ?").run(stableStringify(result), row.commandKey)
  }

  /**
   * An attempt to finish the entry failed. After `QUEUE_COMMAND_MAX_ATTEMPTS` the entry is `failed`: no later change
   * to the thread's queue retries it, and a retry of its key is told so. Returns whether it is now failed.
   */
  recordFailure(commandKey: string, message: string): boolean {
    this.db
      .statement(
        `UPDATE queue_commands SET attempts = attempts + 1, last_error = ?,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
         WHERE command_key = ? AND status IN ('pending','effects_pending')`
      )
      .run(message.slice(0, 500), QUEUE_COMMAND_MAX_ATTEMPTS, commandKey)
    return this.get(commandKey)?.status === 'failed'
  }

  /** Removes finished and failed entries older than the retention. Returns how many. */
  prune(now: number = this.db.clock()): number {
    const before = new Date(now - QUEUE_COMMAND_RETENTION_MS).toISOString()
    return Number(this.db.statement("DELETE FROM queue_commands WHERE status IN ('applied','failed') AND COALESCE(applied_at, created_at) < ?").run(before).changes)
  }

  /** Removes every entry of a thread that no longer exists. Returns how many. */
  deleteForThread(threadId: string): number {
    return Number(this.db.statement('DELETE FROM queue_commands WHERE thread_id = ?').run(threadId).changes)
  }
}
