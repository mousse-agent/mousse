import { AppError, type AppErrorShape } from '../../shared/errors'
import { isRetriesExhausted } from '../../shared/harness/types'
import { retriesOf, retryCause, type ProviderRetries } from '../../shared/providerRetry'
import { usageLimitOf } from '../run/pausePolicy'

/**
 * Mousse's own retries of a turn whose provider request failed for a passing reason its runtime did not retry (a
 * runtime that crashed while starting, a connection that reset before the request was sent). The runtime's own
 * retries come first: a failure after them is final.
 */
export const TURN_RETRY = {
  /** The most retries one turn makes. */
  attempts: 4,
  /** The first wait; each next one doubles, up to `capMs`. */
  baseMs: 2_000,
  capMs: 30_000,
  /** No retry starts once the turn has been failing this long. */
  deadlineMs: 120_000
} as const

/** What the turn did before its request failed: any of it makes a retry unsafe or pointless. */
export interface TurnRetryFacts {
  /** Retries Mousse made of this turn so far. */
  retries: number
  /** Since the turn's first request was sent. */
  elapsedMs: number
  /** The provider sent something (text, a thought, a tool call, a compaction): the request reached it. */
  answered: boolean
  /** A tool ran or may have run: running the turn again could repeat what it did. */
  toolStarted: boolean
  /** A steer went into the turn: the request is no longer the one sent. */
  steered: boolean
  /** The runtime retried a request itself (Claude Code's `api_retry`): its failure is already the last word. */
  runtimeRetried: boolean
  /** A bot's turn: its activation decides what happens after a failure. */
  bot: boolean
}

/** A failure that may pass on its own: the provider was unreachable or busy, and said so as retryable. */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  if (!error.errorInfo.retryable) return false
  if (error.errorInfo.category !== 'unavailable' && error.errorInfo.category !== 'timeout') return false
  if (isRetriesExhausted(error) || usageLimitOf(error)) return false
  return true
}

/**
 * How long to wait before running the turn again, or undefined when it must not run again: the failure is not
 * transient, the turn got past its first request, the runtime retried already, or the retries or the time ran out.
 * The wait doubles each time up to its cap, and is spread by `random` (0..1) over its upper half.
 */
export function turnRetryDelay(error: unknown, facts: TurnRetryFacts, random: () => number = Math.random): number | undefined {
  if (facts.bot || facts.answered || facts.toolStarted || facts.steered || facts.runtimeRetried) return undefined
  if (!isTransientFailure(error)) return undefined
  if (facts.retries >= TURN_RETRY.attempts) return undefined
  const ceiling = Math.min(TURN_RETRY.capMs, TURN_RETRY.baseMs * 2 ** facts.retries)
  const delay = Math.round(ceiling / 2 + (ceiling / 2) * Math.min(1, Math.max(0, random())))
  if (facts.elapsedMs + delay > TURN_RETRY.deadlineMs) return undefined
  return delay
}

/** What failed, in a few words, for the retry row. */
export function turnRetryCause(error: unknown): string {
  const status = error instanceof AppError ? (error.details as { status?: unknown } | undefined)?.status : undefined
  if (typeof status === 'number') return retryCause(status)
  return error instanceof AppError && error.errorInfo.category === 'timeout' ? 'timed out' : 'connection error'
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
