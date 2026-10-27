import { AppError } from '../../shared/errors'
import { boundedResetIso, estimatedReset, readUsageLimit, type UsageLimit } from '../orchestrator/providerErrors'
import type { RunPause, RunRecord } from './types'

/** Automatic resumes in a row on one thread before the next usage limit fails the run. */
export const DEFAULT_USAGE_LIMIT_PAUSE_CAP = 3

/**
 * The usage limit a failed turn stands for, or undefined when it is anything else.
 *
 * Two shapes reach the pause. A run on a Mousse-run provider (Claude, a Codex the user installed, the
 * pi loop) throws the typed `provider_usage_limit` itself. A run on a managed Codex throws the
 * harness gateway's `rate_limited` error, because the gateway acts on that code, with the typed
 * limit as its cause (`CodexAdapter`). A `rate_limited` error without that cause is a short rate
 * limit or a gateway wait, not a plan limit, and does not pause.
 */
export function usageLimitOf(error: unknown): UsageLimit | undefined {
  const direct = readUsageLimit(error)
  if (direct) return direct
  if (error instanceof AppError && error.code === 'rate_limited') return readUsageLimit(error.cause)
  return undefined
}

/**
 * The position of the pause a run is about to enter in its chain of automatic resumes: one more than
 * the pause the run continues when that continue turn was sent by the timer, else 1. A Resume now
 * press (`resumedFromPause: 'user'`) and a person's message start a new chain.
 */
export function pauseCount(run: Pick<RunRecord, 'outcome'>, lookup: (runId: string) => RunRecord | null): number {
  const outcome = run.outcome
  if (outcome?.resumedFromPause !== 'auto' || !outcome.continuationOf) return 1
  return (lookup(outcome.continuationOf)?.outcome?.pause?.count ?? 0) + 1
}

export type UsageLimitDecision =
  | { action: 'pause'; pause: RunPause }
  | { action: 'fail'; message: string }

/**
 * What a turn that ended on `error` does to its run. `undefined`: this is not a usage limit, or the
 * run is being stopped (the Stop wins), so the ordinary failure and abort paths apply. `fail`: the
 * limit was hit again after `cap` automatic resumes in a row. `pause`: the run pauses until `until`,
 * the provider's reset time when it gave one that can be believed, else an estimate. `autoResume`
 * is the user's setting; without it the pause waits for Resume now.
 */
export function decideUsageLimit(input: {
  error: unknown
  run: Pick<RunRecord, 'outcome'>
  lookup: (runId: string) => RunRecord | null
  cap: number
  autoResume: boolean
  nowMs: number
}): UsageLimitDecision | undefined {
  const limit = usageLimitOf(input.error)
  if (!limit || input.run.outcome?.stopRequested) return undefined
  const count = pauseCount(input.run, input.lookup)
  if (count > input.cap)
    return {
      action: 'fail',
      message: `Usage limit reached ${count} times in a row; the run stopped. Send a message to try again.`
    }
  const reported = limit.estimated ? undefined : boundedResetIso(limit.resetsAt, input.nowMs)
  return {
    action: 'pause',
    pause: {
      reason: 'usage_limit',
      until: reported ?? estimatedReset(input.nowMs),
      estimated: reported === undefined,
      ...(limit.provider ? { provider: limit.provider } : {}),
      ...(limit.limitKind ? { limitKind: limit.limitKind } : {}),
      count,
      autoResume: input.autoResume
    }
  }
}
