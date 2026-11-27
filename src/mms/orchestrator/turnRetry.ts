import { AppError, type AppErrorShape } from '../../shared/errors'
import { isPromptTaken, isRetriesExhausted } from '../../shared/harness/types'
import { retriesOf, retryCause, type ProviderRetries } from '../../shared/providerRetry'
import { usageLimitOf } from '../run/pausePolicy'

/**
 * Mousse's own retries of a turn whose provider request failed and that its runtime did not retry itself. One count per
 * turn covers both ways a turn goes on: sending the request again (nothing of it happened yet), or continuing the
 * runtime's own session where the failed request stopped (`TurnRetryPlan`). A failure after the runtime's own retries
 * is final.
 */
export const TURN_RETRY = {
  /** The most retries one turn makes. */
  attempts: 10,
  /** The first wait; each next one doubles, up to `capMs`. */
  baseMs: 2_000,
  capMs: 30_000,
  /**
   * No retry starts once the provider has been failing this long without answering: from the first failure after it
   * last answered. Ten waits at their longest take 3.5 minutes; the rest is room for the failed requests themselves.
   */
  deadlineMs: 10 * 60_000
} as const

/** What the turn did before its request failed, and what its runtime kept. */
export interface TurnRetryFacts {
  /** Retries Mousse made of this turn so far. */
  retries: number
  /** Since the first failure after the provider last answered (0 for that first failure). */
  failingMs: number
  /**
   * The turn got past its first request: the provider answered, a tool ran or may have run, a steer went in, or the
   * history was compacted. Sending the request again could repeat what it did.
   */
  progressed: boolean
  /**
   * The runtime kept its own session as the failure left it (`TurnSink.sessionKept`): a short turn on it continues
   * where the failed request stopped, with every tool result it had.
   */
  sessionKept: boolean
  /** The runtime retried a request itself (Claude Code's `api_retry`): its failure is already the last word. */
  runtimeRetried: boolean
  /** A bot's turn: its activation decides what happens after a failure (it picks the next model). */
  bot: boolean
}

/** How a turn goes on after a failed request, and after how long. */
export interface TurnRetryPlan {
  /** `resend`: the same request again. `continue`: a short continuation turn on the runtime's kept session. */
  how: 'resend' | 'continue'
  delayMs: number
}

/**
 * The provider's own failures: what it answered (any status but a sign-in's), a connection it dropped or refused, a
 * request that timed out, a runtime's protocol error about it. Everything else is not a provider failure and is never
 * retried here: a usage or plan limit (it pauses), a sign-in failure, a full context window (its own recovery runs), a
 * Stop, an agent that took the prompt and went silent, and Mousse's own refusals and setup failures.
 */
const PROVIDER_FAILURES: ReadonlySet<string> = new Set([
  'provider_api_error',
  'provider_unavailable',
  'provider_timeout',
  'provider_rate_limited',
  'provider_request_invalid',
  'provider_permission_denied',
  'provider_unknown',
  // A runtime's own words for the same (`harnessAppError`).
  'service_unavailable',
  'timeout',
  'protocol'
])

/** A failure of the provider's that may pass if the turn goes on (see `PROVIDER_FAILURES`). */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  if (!PROVIDER_FAILURES.has(error.code)) return false
  if (error.errorInfo.category === 'cancelled') return false
  if (isRetriesExhausted(error) || isPromptTaken(error) || usageLimitOf(error)) return false
  // A sign-in the provider refused stays a sign-in failure, whatever code carried it.
  if ((error.details as { status?: unknown } | undefined)?.status === 401) return false
  return true
}

/**
 * How the turn goes on after its request failed, or undefined when it ends with the failure: the failure is not the
 * provider's, the runtime retried already, it is a bot's turn, the turn got past its first request and its runtime kept
 * no session to continue, or the retries or the time ran out. The wait doubles each time up to its cap, and is spread by
 * `random` (0..1) over its upper half.
 */
export function turnRetryPlan(error: unknown, facts: TurnRetryFacts, random: () => number = Math.random): TurnRetryPlan | undefined {
  if (facts.bot || facts.runtimeRetried) return undefined
  if (!isProviderFailure(error)) return undefined
  if (facts.progressed && !facts.sessionKept) return undefined
  if (facts.retries >= TURN_RETRY.attempts) return undefined
  const ceiling = Math.min(TURN_RETRY.capMs, TURN_RETRY.baseMs * 2 ** facts.retries)
  const delayMs = Math.round(ceiling / 2 + (ceiling / 2) * Math.min(1, Math.max(0, random())))
  if (facts.failingMs + delayMs > TURN_RETRY.deadlineMs) return undefined
  return { how: facts.progressed ? 'continue' : 'resend', delayMs }
}

/**
 * The prompt of a continuation turn: the runtime's session holds the turn up to the failed request, and the model picks
 * up from there. `cause` is what failed, in a few words.
 */
export function continuationPrompt(cause: string): string {
  return `The previous request to the model provider failed (${cause}) before you finished. Continue the task from where you stopped. Tool calls that already returned a result are done: do not run them again.`
}

/** What failed, in a few words, for the retry row. */
export function turnRetryCause(error: unknown): string {
  const status = error instanceof AppError ? (error.details as { status?: unknown } | undefined)?.status : undefined
  if (typeof status === 'number') return retryCause(status)
  if (!(error instanceof AppError)) return 'connection error'
  if (error.errorInfo.category === 'timeout') return 'timed out'
  return error.errorInfo.category === 'unavailable' ? 'connection error' : 'provider error'
}

/** Waits `ms`, or rejects with an `AbortError` as soon as `signal` aborts. */
export function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A turn's error with the retries its request had (`details.retries`), when the runtime's error does not say already:
 * the retries since the provider last answered, as the turn's retry row counted them.
 */
export function withRetries(error: AppErrorShape, retries: ProviderRetries | undefined): AppErrorShape {
  if (!retries || retriesOf(error.details)) return error
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {}
  return { ...error, details: { ...details, retries } }
}
