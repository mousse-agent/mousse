import { Delegations } from './Delegations'
import { Inbox } from './Inbox'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { AttemptStatus, ChildResultPayload, RunOutcome, RunRecord } from './types'

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
 * Publication gate (SPEC §14.1): when the run is a delegated child run, its result (`resultText`
 * or the failure) and the parent's `child_result` inbox row are written in this transaction.
 */
export function writeTerminalRun(
  store: RunStore,
  run: RunRecord,
  expectedEpoch: number,
  status: RunTerminalStatus,
  outcome: RunOutcome | undefined,
  completedAt: string,
  options: { resultText?: string } = {}
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
    new Delegations(store).publishResult(next, options.resultText)
    acknowledgeDeliveredRows(store, next)
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
  const rows = inbox.listDeliveredByRun(run.runId)
  if (rows.length === 0) return
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
