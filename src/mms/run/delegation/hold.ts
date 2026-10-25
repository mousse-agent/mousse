import { Delegations, DELEGATION_RESULT_MAX_CHARS, childResult } from '../Delegations'
import { Inbox } from '../Inbox'
import type { RunStore } from '../RunStore'
import {
  TERMINAL_RUN_STATUSES,
  type DelegationRecord,
  type DelegationResult,
  type InboxRecord,
  type RunRecord
} from '../types'
import { FOLLOW_UP_SOURCES } from './sources'

/**
 * A subagent's result waits for its own work (issue #142). A delegation P -> C stays `running`
 * after C's run ended for as long as C is busy, and publishes once, from C's latest conversational
 * run, when C is not. This module is that rule: the predicate (`childBusy`) and the one function
 * that publishes (`settleWaitingDelegations`). Everything here is synchronous and reads only the
 * run database and an in-memory callback, because it runs inside the transactions that change what
 * it reads.
 */

/** What keeps a child busy after its own runs ended. */
export interface ChildBusyInputs {
  /** The child has a delegation of its own that is still `running`. */
  runningOutboundDelegation: boolean
  /** The child has an inbox row that is still actionable: not acknowledged, exhausted or disposed (`isActionableRow`). */
  unconsumedInbox: boolean
  /** A wake or steer effect for the child is pending or running. */
  inFlightEffects?: boolean
  /** The provider reports background work for the child that a run does not cover. */
  providerBackgroundWork?: boolean
}

/** A child is busy while a run is live, or any `ChildBusyInputs` holds. */
export function isChildBusy(runs: readonly Pick<RunRecord, 'status'>[], inputs: ChildBusyInputs): boolean {
  return (
    runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ||
    inputs.runningOutboundDelegation ||
    inputs.unconsumedInbox ||
    inputs.inFlightEffects === true ||
    inputs.providerBackgroundWork === true
  )
}

const TERMINAL_LIST = [...TERMINAL_RUN_STATUSES]
const TERMINAL_PLACEHOLDERS = TERMINAL_LIST.map(() => '?').join(',')

/** The thread has a run that is queued, starting, running or finalizing. */
export function hasLiveRun(store: RunStore, threadId: string): boolean {
  return Boolean(
    store.db
      .statement(`SELECT 1 FROM runs WHERE thread_id = ? AND status NOT IN (${TERMINAL_PLACEHOLDERS}) LIMIT 1`)
      .get(threadId, ...TERMINAL_LIST)
  )
}

/**
 * Whether an inbox row of a child still has to be consumed before the child's task may publish.
 * `pending` and `delivered` rows count, with two exceptions that would otherwise hold a task for
 * ever: a row whose delivery gave up (`payload.deliveryFailed`, exhausted; the owner has its Retry
 * notice) and a delivered row whose delivery the user stopped (the run that carried it was stopped,
 * so nothing will deliver or acknowledge it).
 */
export function isActionableRow(store: RunStore, row: InboxRecord): boolean {
  if (row.status === 'acknowledged') return false
  if (isExhaustedRow(row)) return false
  if (row.status !== 'delivered') return true
  return !deliveryStoppedByUser(store, row) && !isLegacySteerRow(store, row)
}

/**
 * A row from before the delivery rules of this version: delivered by a `turn.steer` that succeeded
 * on a run that has completed, with neither `steerHeldBy` nor `steerTakenBy`. Only code that holds a
 * steer writes those markers, so such a row is a native steer of an older version, which acknowledged
 * its rows when the run ended. The delivery rules never restore it, on purpose (`deliveryFailure` in
 * `wake.ts` requires `steerHeldBy`, so a row that predates it is not mistaken for an unread steer).
 * Nothing will ever consume it, so it must not hold a task that was running at upgrade time. A row
 * carrying a marker is a steer this version held: it counts until it is read or restored.
 */
function isLegacySteerRow(store: RunStore, row: InboxRecord): boolean {
  if (!row.deliveredBy) return false
  const payload = row.payload as { steerHeldBy?: unknown; steerTakenBy?: unknown } | null
  if (payload?.steerHeldBy !== undefined || payload?.steerTakenBy !== undefined) return false
  const effect = store.db.statement('SELECT kind, status, run_id FROM effects WHERE effect_id = ?').get(row.deliveredBy)
  if (!effect || effect.kind !== 'turn.steer' || effect.status !== 'succeeded') return false
  const run = typeof effect.run_id === 'string' ? store.getRun(effect.run_id) : null
  return run?.status === 'completed'
}

/** A row whose redelivery gave up (`restoreUndeliveredRows` flags it `deliveryFailed`). */
export function isExhaustedRow(row: InboxRecord): boolean {
  return (row.payload as { deliveryFailed?: unknown } | null)?.deliveryFailed === true
}

/** The run that carried a delivered row ended because the user stopped it. */
function deliveryStoppedByUser(store: RunStore, row: InboxRecord): boolean {
  if (!row.deliveredBy) return false
  const effect = store.db.statement('SELECT run_id FROM effects WHERE effect_id = ?').get(row.deliveredBy)
  const runId = typeof effect?.run_id === 'string' ? effect.run_id : null
  const run = runId ? store.getRun(runId) : null
  return Boolean(run && TERMINAL_RUN_STATUSES.has(run.status) && run.outcome?.interruptedBy === 'user')
}

function actionableInbox(store: RunStore, threadId: string): boolean {
  const inbox = new Inbox(store)
  return [...inbox.listByStatus(threadId, 'pending'), ...inbox.listByStatus(threadId, 'delivered')].some((row) =>
    isActionableRow(store, row)
  )
}

/** A wake or steer effect for the thread is waiting or running. */
function hasInFlightDeliveryEffect(store: RunStore, threadId: string): boolean {
  return Boolean(
    store.db
      .statement(
        `SELECT 1 FROM effects WHERE thread_id = ? AND status IN ('pending', 'running')
           AND (kind = 'turn.steer' OR (kind = 'turn.start' AND json_extract(payload, '$.kind') = 'wake')) LIMIT 1`
      )
      .get(threadId)
  )
}

/** The cheap inputs first; the provider's callback last. Each is a read of the current state. */
export function childBusyInputs(store: RunStore, threadId: string): ChildBusyInputs {
  const runningOutboundDelegation = Boolean(
    store.db.statement(`SELECT 1 FROM delegations WHERE parent_thread_id = ? AND status = 'running' LIMIT 1`).get(threadId)
  )
  const unconsumedInbox = actionableInbox(store, threadId)
  const inFlightEffects = hasInFlightDeliveryEffect(store, threadId)
  const providerBackgroundWork =
    runningOutboundDelegation || unconsumedInbox || inFlightEffects ? false : store.providerBackgroundWork(threadId)
  return { runningOutboundDelegation, unconsumedInbox, inFlightEffects, providerBackgroundWork }
}

/** Whether `threadId` is busy now: the hold of every delegation that waits on it. */
export function childBusy(store: RunStore, threadId: string): boolean {
  if (hasLiveRun(store, threadId)) return true
  return isChildBusy([], childBusyInputs(store, threadId))
}

/** Sources of the runs a subagent's result may come from: its tasks, the notices it was woken for, and a person's turns. */
const RESULT_SOURCES: ReadonlySet<string> = new Set([
  'delegation',
  'wake',
  'provider-continuation',
  // A steer that missed its turn runs as the next turn: it is how the subagent answers a notice.
  'steer-late',
  'steer-followup',
  ...FOLLOW_UP_SOURCES
])

/**
 * Whether a run of a subagent may be the source of a task's result: a terminal run with a
 * conversational source (integration runs and local actions never are), whether or not it produced
 * text. A run that never started said nothing (a wake cancelled before it ran, a queued message the
 * user removed), so it counts only for the task it belongs to (`ownRunId`), whose outcome it is.
 */
export function isResultRun(run: RunRecord, ownRunId: string): boolean {
  if (!TERMINAL_RUN_STATUSES.has(run.status) || !RESULT_SOURCES.has(run.source)) return false
  return run.startedAt !== null || run.runId === ownRunId
}

/** The latest run of the thread whose result `delegation` publishes, or null. */
export function latestResultRun(store: RunStore, delegation: Pick<DelegationRecord, 'childThreadId' | 'childRunId'>): RunRecord | null {
  return store.listRuns(delegation.childThreadId).find((run) => isResultRun(run, delegation.childRunId)) ?? null
}

/**
 * Keeps the final text of a subagent's run next to its terminal status, so a task that publishes
 * later (once the subagent stops waiting) still has it. Written in the run's terminal transaction;
 * only for runs that may become a result.
 */
export function recordRunResultText(store: RunStore, run: RunRecord, text: string | undefined): void {
  if (!text?.trim() || !RESULT_SOURCES.has(run.source)) return
  const lineage = store.db
    .statement(`SELECT 1 FROM thread_lineage WHERE thread_id = ? AND relationship = 'subagent'`)
    .get(run.threadId)
  if (!lineage) return
  store.appendEvent({
    threadId: run.threadId,
    runId: run.runId,
    type: 'run.result',
    payload: { runId: run.runId, text: text.slice(0, DELEGATION_RESULT_MAX_CHARS) }
  })
}

/** The final text `recordRunResultText` kept for a run, when it has one. */
export function readRunResultText(store: RunStore, threadId: string, runId: string): string | undefined {
  const row = store.db
    .statement(`SELECT payload FROM thread_events WHERE thread_id = ? AND run_id = ? AND type = 'run.result' ORDER BY seq DESC LIMIT 1`)
    .get(threadId, runId)
  if (!row) return undefined
  const text = (JSON.parse(String(row.payload)) as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** Shown as the result of a task whose subagent ended its turn without saying anything. */
export const NO_FINAL_MESSAGE = 'Subagent finished without a final message.'

function resultOf(store: RunStore, run: RunRecord): DelegationResult {
  const text = readRunResultText(store, run.threadId, run.runId)
  const result = childResult(run, text)
  return {
    ...(run.status === 'completed' && !text?.trim() ? { ...result, text: NO_FINAL_MESSAGE } : result),
    runId: run.runId
  }
}

/** The failure a task publishes when the notice it was waiting on could not be delivered. */
function deliveryFailureResult(row: InboxRecord, run: RunRecord | null): DelegationResult {
  const detail = row.payload as { attempts?: unknown; lastError?: unknown } | null
  const attempts = typeof detail?.attempts === 'number' ? ` after ${detail.attempts} attempts` : ''
  const cause = typeof detail?.lastError === 'string' && detail.lastError ? `: ${detail.lastError}` : ''
  return {
    runStatus: 'failed',
    error: `A subagent result could not be delivered${attempts}${cause}`,
    ...(run ? { runId: run.runId } : {})
  }
}

/**
 * Publishes the `running` delegations into `childThreadId` once the child is no longer busy, and
 * returns them. Every one publishes together, with the result of the child's latest conversational
 * run (`isResultRun`): its text, else its error, else `NO_FINAL_MESSAGE`, with the outcome of that
 * run. If a notice the child was waiting on could not be delivered (an exhausted row newer than the
 * task), the task publishes `failed` with that error instead, so the parent hears. A cancelled
 * delegation is never published.
 *
 * This replaces the immediate publication in a run's terminal write. It runs on every change of
 * what the predicate reads (`RunStore.settleHold`): a run of the child ending, an inbox row of it
 * changing, a wake or steer effect for it changing status (`EffectOutbox`, so lease reclaim and boot
 * included), a delegation of its own leaving `running`, a queue entry that carried notices being
 * removed, the provider's background work changing, and boot. Joins the caller's transaction, never
 * throws for state it can read, and publishes each delegation at most once.
 */
export function settleWaitingDelegations(store: RunStore, childThreadId: string): DelegationRecord[] {
  const waiting = store.db
    .statement(`SELECT 1 FROM delegations WHERE child_thread_id = ? AND status = 'running' LIMIT 1`)
    .get(childThreadId)
  if (!waiting) return []
  return store.db.transaction(() => {
    const delegations = new Delegations(store)
    const lineage = delegations.getLineage(childThreadId)
    if (!lineage || lineage.relationship !== 'subagent') return []
    if (childBusy(store, childThreadId)) return []
    const exhausted = new Inbox(store).listByStatus(childThreadId, 'delivered').filter(isExhaustedRow)
    const published: DelegationRecord[] = []
    for (const candidate of delegations.listForChildThread(childThreadId)) {
      const delegation = delegations.get(candidate.delegationId)
      if (!delegation || delegation.status !== 'running') continue
      const undelivered = exhausted.find((row) => row.createdAt >= delegation.createdAt)
      const source = latestResultRun(store, delegation)
      const result = undelivered
        ? deliveryFailureResult(undelivered, source)
        : source
          ? resultOf(store, source)
          : ({ runStatus: 'failed', error: 'The subagent has no finished run.' } satisfies DelegationResult)
      published.push(delegations.publish(delegation, result))
    }
    return published
  })
}
