import { createHash } from 'node:crypto'
import { json, str, type Row } from '../db/rows'
import { stableStringify } from '../json'
import type { RunStore } from '../RunStore'
import type { DelegationRecord, DelegationResult, DelegationStatus } from '../types'

/**
 * A personal bot's work in the thread tree (docs/plans/tool-api.md §2.8, issue #1454 slice S4). `bots.db` is the source
 * of truth for the work; the run database keeps a projection of it as a delegation from the bot's chat (its home thread)
 * into the work's thread, so the tree lists the work beside a thread's subagents and the work's own subagents nest
 * under it. The projection is a read model only:
 *
 * - Its id names the work (`delegation:bot-work:<activation>`), so writing it again changes nothing, and the bots
 *   rebuild it from `bots.db` at startup: a crash between a work's transition and its projection leaves nothing behind.
 * - It has no lineage, no inbox rows, no bot columns and no real runs (`parent_run_id` and `child_run_id` name the work,
 *   not a run). Nothing publishes it, holds its parent, delivers or cancels it, and the generic delegation lists leave it
 *   out (`Delegations.list*`, the hold's running-delegation input). Only `projectBotWork` writes it.
 * - A Stop or a message for it goes to the bots through the bot port (`BotExecutionPort.stopWork`, `noteWork`), never to
 *   the projection or the work thread's inbox.
 */

/** Prefix of a bot work projection's delegation id; the activation id follows. */
export const BOT_WORK_DELEGATION_PREFIX = 'delegation:bot-work:'

/** SQL that is true for a bot work projection row of `delegations`. */
export const BOT_WORK_ROW_SQL = `substr(delegation_id, 1, ${BOT_WORK_DELEGATION_PREFIX.length}) = '${BOT_WORK_DELEGATION_PREFIX}'`

/** A bot work activation as `bots.db` has it now: what the projection is written from. */
export interface BotWorkState {
  activationId: string
  /** The bot's chat (home thread): the work's parent in the tree. */
  homeThreadId: string
  /** The thread the work runs on. */
  threadId: string
  /** `running` covers every status the work goes on from (queued, waiting for a grant, paused, blocked). */
  status: 'running' | 'done' | 'failed' | 'cancelled'
  createdAt: string
  endedAt: string | null
  /** Why it failed (`end_reason`), when it did. */
  error?: string | null
}

export function botWorkDelegationId(activationId: string): string {
  return `${BOT_WORK_DELEGATION_PREFIX}${activationId}`
}

/** The work a projection row stands for, or undefined for any other delegation. */
export function botWorkActivationOf(delegation: Pick<DelegationRecord, 'delegationId'>): string | undefined {
  return delegation.delegationId.startsWith(BOT_WORK_DELEGATION_PREFIX) ? delegation.delegationId.slice(BOT_WORK_DELEGATION_PREFIX.length) : undefined
}

/** The run ids a projection row carries in place of runs: never a run of the run database. */
function workRunId(activationId: string): string {
  return `bot-work:${activationId}`
}

const STATUS: Record<BotWorkState['status'], DelegationStatus> = { running: 'running', done: 'acknowledged', failed: 'failed', cancelled: 'cancelled' }
const RUN_STATUS = { done: 'completed', failed: 'failed', cancelled: 'cancelled' } as const

/**
 * Writes the work's projection, idempotently: a row that already says the same is left alone, and an ended projection
 * never moves again. Returns whether it changed, and appends `delegation.status` on the home thread when it did, so the
 * tree is read again. Reads and writes the run database only.
 */
export function projectBotWork(store: RunStore, work: BotWorkState): boolean {
  return store.db.transaction(() => {
    const delegationId = botWorkDelegationId(work.activationId)
    const before = store.db.statement('SELECT * FROM delegations WHERE delegation_id = ?').get(delegationId)
    const status = STATUS[work.status]
    const result: DelegationResult | null = work.status === 'running' ? null : {
      runStatus: RUN_STATUS[work.status],
      ...(work.status === 'failed' && work.error ? { error: work.error } : {})
    }
    if (before && (before.status !== 'running' || (before.status === status && str(before.child_thread_id) === work.threadId))) return false
    const record: DelegationRecord = {
      delegationId,
      parentRunId: workRunId(work.activationId),
      parentThreadId: before ? String(before.parent_thread_id) : work.homeThreadId,
      childThreadId: work.threadId,
      childRunId: workRunId(work.activationId),
      provider: null,
      model: null,
      promptDigest: createHash('sha256').update(work.activationId).digest('hex'),
      wake: 'settled_only',
      status,
      result,
      createdAt: before ? String(before.created_at) : work.createdAt,
      completedAt: work.status === 'running' ? null : work.endedAt ?? new Date(store.db.clock()).toISOString(),
      modeCeiling: null,
      accessLevel: null,
      workspace: null,
      role: null
    }
    store.db
      .statement(
        `INSERT INTO delegations(delegation_id, parent_run_id, parent_thread_id, child_thread_id, child_run_id, prompt_digest, wake, status, result, created_at, completed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delegation_id) DO UPDATE SET child_thread_id = excluded.child_thread_id, status = excluded.status, result = excluded.result, completed_at = excluded.completed_at`
      )
      .run(record.delegationId, record.parentRunId, record.parentThreadId, record.childThreadId, record.childRunId, record.promptDigest, record.wake,
        record.status, result ? stableStringify(result) : null, record.createdAt, record.completedAt)
    store.appendEvent({ threadId: record.parentThreadId, type: 'delegation.status', payload: record })
    return true
  })
}

/** A projection whose work `bots.db` no longer has ends `cancelled`. */
export function endMissingBotWork(store: RunStore, activationId: string): boolean {
  const before = store.db.statement('SELECT parent_thread_id, child_thread_id, created_at FROM delegations WHERE delegation_id = ?').get(botWorkDelegationId(activationId))
  if (!before) return false
  return projectBotWork(store, { activationId, homeThreadId: String(before.parent_thread_id), threadId: String(before.child_thread_id), status: 'cancelled', createdAt: String(before.created_at), endedAt: null })
}

/**
 * Every projected work activation and its projection's status: the bots' startup pass checks the running ones against
 * `bots.db`, and writes the work that has none.
 */
export function botWorkProjections(store: RunStore): Map<string, DelegationStatus> {
  return new Map(store.db
    .statement(`SELECT delegation_id, status FROM delegations WHERE ${BOT_WORK_ROW_SQL} ORDER BY rowid`)
    .all()
    .map((row) => [String(row.delegation_id).slice(BOT_WORK_DELEGATION_PREFIX.length), row.status as DelegationStatus]))
}

/** The projected work a bot's chat started, oldest first (the generic delegation lists leave it out). */
export function listBotWork(store: RunStore, parentThreadId: string): DelegationRecord[] {
  return store.db
    .statement(`SELECT * FROM delegations WHERE parent_thread_id = ? AND ${BOT_WORK_ROW_SQL} ORDER BY created_at, rowid`)
    .all(parentThreadId)
    .map(toWorkRecord)
}

/** The projected work that runs on `threadId`, or null when the thread is not a bot work's. Reads the run database only. */
export function botWorkInto(store: RunStore, threadId: string): DelegationRecord | null {
  const row = store.db.statement(`SELECT * FROM delegations WHERE child_thread_id = ? AND ${BOT_WORK_ROW_SQL} ORDER BY rowid DESC LIMIT 1`).get(threadId)
  return row ? toWorkRecord(row) : null
}

function toWorkRecord(row: Row): DelegationRecord {
  return {
    delegationId: String(row.delegation_id),
    parentRunId: String(row.parent_run_id),
    parentThreadId: String(row.parent_thread_id),
    childThreadId: String(row.child_thread_id),
    childRunId: String(row.child_run_id),
    provider: null,
    model: null,
    promptDigest: String(row.prompt_digest),
    wake: 'settled_only',
    status: row.status as DelegationStatus,
    result: json<DelegationResult>(row.result),
    createdAt: String(row.created_at),
    completedAt: str(row.completed_at),
    modeCeiling: null,
    accessLevel: null,
    workspace: null,
    role: null
  }
}
