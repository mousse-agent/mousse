import { Delegations } from './Delegations'
import { recordRunResultText } from './delegation/hold'
import { Inbox } from './Inbox'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { AttemptStatus, ChildResultPayload, InboxKind, InboxRecord, RunOutcome, RunRecord } from './types'

/**
 * An inbox row the run owes its own thread, written in the run's terminal transaction before the
 * subagent's waiting tasks are judged (an integration run's outcome). The row is what keeps the
 * thread busy until its model has read the outcome, so the tasks waiting on it cannot publish an
 * answer that predates it.
 */
export interface TerminalNotice {
  kind: InboxKind
  payload: unknown
}

export type RunTerminalStatus = 'completed' | 'interrupted' | 'failed' | 'cancelled' | 'uncertain'

const LIVE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set<AttemptStatus>([
  'pending',
  'running'
])

/**
 * One terminal CAS write shared by the engine's bridge hooks, boot recovery and the reconciler.
 * The outcome is merged into the stored one and a live active attempt mirrors the run status.
 * Attempts have no `uncertain` status: the attempt of an uncertain run was cut off, so it is
 * `interrupted`. Joins the caller's transaction or opens one.
 *
 * Publication gate (SPEC §14.1): when the run is a run of a subagent, its final text is kept
 * (`recordRunResultText`) and the tasks waiting on that subagent are re-evaluated
 * (`settleWaitingDelegations`): each publishes, with the parent's `child_result` inbox row, in this
 * transaction once the subagent is no longer busy, and otherwise stays `running` until it is.
 */
export function writeTerminalRun(
  store: RunStore,
  run: RunRecord,
  expectedEpoch: number,
  status: RunTerminalStatus,
  outcome: RunOutcome | undefined,
  completedAt: string,
  options: { resultText?: string; notice?: TerminalNotice } = {}
): RunRecord {
  return store.db.transaction(() => {
    const merged =
      outcome || run.outcome
        ? (JSON.parse(
            stableStringify({ ...(run.outcome ?? {}), ...(outcome ?? {}) })
          ) as RunOutcome)
        : undefined
    const next = store.casRunStatus({
      runId: run.runId,
      expectedEpoch,
      status,
      patch: { completedAt, ...(merged ? { outcome: merged } : {}) }
    })
    const attempt = next.activeAttemptId ? store.getAttempt(next.activeAttemptId) : null
    if (attempt && LIVE_ATTEMPT_STATUSES.has(attempt.status))
      store.setAttemptStatus({
        attemptId: attempt.attemptId,
        status: status === 'uncertain' ? 'interrupted' : status,
        completedAt
      })
    recordRunResultText(store, next, options.resultText)
    // Before anything is acknowledged or judged, so every evaluation below sees the row.
    if (options.notice) new Inbox(store).append({ threadId: next.threadId, runId: next.runId, kind: options.notice.kind, payload: options.notice.payload })
    // Rows this run delivered are acknowledged first (inside, the thread is evaluated as they move)...
    acknowledgeDeliveredRows(store, next)
    // ...then, whatever moved or not, once more with the run's own end.
    store.settleHold(next.threadId)
    return next
  })
}

/**
 * Acknowledge on delivery (issue #142): the notices a run delivered (a wake run's, a steer's, a
 * queued steer's) were read when that run completed, so their inbox rows are acknowledged in the
 * run's terminal transaction. A task whose result the notice showed whole is read too; one that was
 * cut stays unread until the model reads the rest with `task_status`. A run that did not complete
 * leaves its rows `delivered`: the reconciler returns them to `pending` (`restoreUndeliveredRows`),
 * except for a run the user stopped, which keeps them as before.
 */
export function acknowledgeDeliveredRows(store: RunStore, run: RunRecord): void {
  if (run.status !== 'completed') return
  const inbox = new Inbox(store)
  acknowledgeRows(store, inbox.listDeliveredByRun(run.runId))
}

/**
 * Acknowledges rows a delivery consumed, and the tasks whose notice recorded showing the whole
 * result. Joins the caller's transaction.
 */
export function acknowledgeRows(store: RunStore, rows: readonly InboxRecord[]): void {
  if (rows.length === 0) return
  const inbox = new Inbox(store)
  inbox.markAcknowledged(rows.map((row) => row.inboxId))
  const delegations = new Delegations(store, inbox)
  for (const row of rows) {
    if (row.kind !== 'child_result') continue
    const { delegationId } = row.payload as ChildResultPayload
    const delegation = delegations.get(delegationId)
    // What the notice showed was recorded when it was built (`noticeShown`); a row with no record showed nothing.
    const shown = (row.payload as { noticeShown?: unknown }).noticeShown === true
    if (shown && delegation && (delegation.status === 'result_available' || delegation.status === 'failed'))
      delegations.setStatus({ delegationId, from: delegation.status, to: 'acknowledged' })
  }
}
