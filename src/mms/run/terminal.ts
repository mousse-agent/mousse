import { Delegations } from './Delegations'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import type { AttemptStatus, RunOutcome, RunRecord } from './types'

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
    return next
  })
}
