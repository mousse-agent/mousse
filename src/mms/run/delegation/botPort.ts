import { Delegations } from '../Delegations'
import { Inbox } from '../Inbox'
import type { RunStore } from '../RunStore'
import type { ChildResultPayload, DelegationResult, InboxRecord } from '../types'

/** A bot subagent's settled delegation, as its work hears it. */
export interface BotSubagentOutcome {
  delegationId: string
  childRunId: string
  result: DelegationResult
}

/**
 * The narrow seam through which the run engine asks a personal bot about a bot subagent (docs/plans/tool-api.md §2.8,
 * "bot port"). The run engine owns the subagent's lifecycle and lineage (`delegations`, `runs`); the bots own its
 * authority, its live counts and spend (`bots.db`), and what its work hears. Without a port nothing of a bot subagent
 * starts, runs or is delivered: a missing port fails closed.
 */
export interface BotExecutionPort {
  /**
   * Whether the work whose turn runs `parentRunId` may start or message a subagent now: its activation is running, on
   * its main turn, which may split its job. Never throws.
   */
  authorizeSubagent(input: { botId: string; rootActivationId: string; parentRunId: string }): { ok: true } | { ok: false; code: string; message: string }
  /**
   * The subagent's place on its work's counts and spend, keyed by (root activation, child run). Written right after the
   * delegation commits, before its turn is dispatched; a crash in between is reconciled at startup. Idempotent.
   */
  reserveSubagent(input: { rootActivationId: string; delegationId: string; childRunId: string; childThreadId: string; subagent: unknown }): void
  /**
   * A subagent settled: its work is told (a live turn at its next step, an idle one when it goes on). True once `bots.db`
   * records the delivery; only then is the inbox row acknowledged. Idempotent: a second call for the same child run is
   * recorded already.
   */
  onSubagentSettled(rootActivationId: string, childThreadId: string, outcome: BotSubagentOutcome): boolean
  /**
   * A Stop of a bot work's row in the thread tree (`delegation/botWork.ts`): the bots stop the work as `work_stop` does.
   * `ended`: it had ended already. A port without it stops nothing.
   */
  stopBotWork?(activationId: string): Promise<'stopped' | 'ended' | 'not_found'>
  /**
   * A message to a bot work's row: the bots pass it to the work as its owner's note (`work_note`), never through the
   * work thread's inbox. `from`: the bot turn that sent it, so a turn its owner did not start never speaks for them;
   * `requestKey`: a retry of the same request adds nothing. Returns what `work_note` returns (`noted`: the work takes it).
   */
  noteBotWork?(activationId: string, text: string, options?: { from?: string; requestKey?: string }): string
}

/**
 * A subagent result for a bot's work: only the bot port delivers it. Rule 4 (`wakeThreads`), boundary delivery and a
 * wake turn leave it alone, so it never becomes a plain turn, a steer of the bot's thread, or an acknowledgement the work
 * never heard. Reads the run database only.
 */
export function isBotParentRow(row: InboxRecord, delegations: Delegations): boolean {
  const delegationId = delegationOfRow(row)
  return delegationId !== undefined && Boolean(delegations.get(delegationId)?.bot)
}

/**
 * The delegation a row reports the end of: a published result, or the notice a Stop of the child's thread leaves its
 * parent (`delegation_stopped`: the delegation was cancelled and publishes nothing).
 */
function delegationOfRow(row: InboxRecord): string | undefined {
  const payload = row.payload as { delegationId?: unknown; kind?: unknown } | null
  if (row.kind !== 'child_result' && !(row.kind === 'reconcile_notice' && payload?.kind === 'delegation_stopped')) return undefined
  return typeof payload?.delegationId === 'string' ? payload.delegationId : undefined
}

/** The rows a thread's delivery may take: every row but a bot subagent's end (`isBotParentRow`). */
export function withoutBotParentRows(store: RunStore, rows: InboxRecord[]): InboxRecord[] {
  if (!rows.some((row) => delegationOfRow(row) !== undefined)) return rows
  const delegations = new Delegations(store)
  return rows.filter((row) => !isBotParentRow(row, delegations))
}

/**
 * Hands every pending bot subagent end to the bot port, oldest first: a result, or the notice of a Stop of its thread.
 * A row is acknowledged (a result with its delegation) only after the port recorded the delivery; a row the port could not record (bots.db unreadable, a throw) stays
 * pending for the next pass, and no other row waits on it. Without a port nothing is delivered and nothing is consumed.
 * Returns the delivered inbox ids.
 */
export function deliverBotResults(store: RunStore, port: BotExecutionPort | null, acknowledge: (delegationId: string) => void): string[] {
  if (!port) return []
  const ids = store.db
    .statement(
      `SELECT i.inbox_id FROM inbox i JOIN delegations d ON d.delegation_id = json_extract(i.payload, '$.delegationId')
       WHERE i.status = 'pending' AND d.bot_id IS NOT NULL
         AND (i.kind = 'child_result' OR (i.kind = 'reconcile_notice' AND json_extract(i.payload, '$.kind') = 'delegation_stopped'))
       ORDER BY i.created_at, i.rowid`
    )
    .all()
    .map((row) => String(row.inbox_id))
  const inbox = new Inbox(store)
  const delegations = new Delegations(store, inbox)
  const delivered: string[] = []
  for (const id of ids) {
    const row = inbox.get(id)
    if (row?.status !== 'pending') continue
    const delegationId = delegationOfRow(row)
    const delegation = delegationId ? delegations.get(delegationId) : null
    if (!delegation?.bot) continue
    // A Stop's notice: the delegation was cancelled, so its end is its run's, with nothing returned.
    const result: DelegationResult = row.kind === 'child_result'
      ? (row.payload as ChildResultPayload).result
      : delegation.result ?? { runStatus: store.getRun(delegation.childRunId)?.status ?? 'cancelled', runId: delegation.childRunId }
    let recorded = false
    try {
      recorded = port.onSubagentSettled(delegation.bot.rootActivationId, delegation.childThreadId, {
        delegationId: delegation.delegationId,
        childRunId: delegation.childRunId,
        result
      })
    } catch (error) {
      console.warn('[run-engine] a bot subagent result could not be delivered; it is tried again', {
        delegationId: delegation.delegationId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    if (!recorded) continue
    try {
      if (row.kind === 'child_result') acknowledge(delegation.delegationId)
      else inbox.markAcknowledged([row.inboxId])
      delivered.push(row.inboxId)
    } catch (error) {
      console.warn('[run-engine] a delivered bot subagent result could not be acknowledged; it is delivered again', {
        delegationId: delegation.delegationId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return delivered
}
