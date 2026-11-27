/**
 * A turn's failed provider requests and their retries, shown as one row of the turn's work: it counts the retries
 * while they run, then says the provider recovered, or becomes the turn's error when they ran out.
 */

/** How many retries a failed turn's request had (`AppError.details.retries`): `max` when the runtime gave one. */
export interface ProviderRetries {
  attempt: number
  max?: number
}

/** A `provider_retry` row's state (`ChatMessage.providerRetry`). */
export interface ProviderRetryState {
  status: 'retrying' | 'recovered' | 'stopped'
  /** Retries so far, the one running included. */
  attempt: number
  /** The most the runtime tries, when it said. */
  maxAttempts?: number
  /** What failed, in a few words ("connection error", "server error 529"). */
  cause?: string
}

/** `3/10`, or `3` when the most is unknown. */
function count(attempt: number, max?: number): string {
  return max ? `${attempt}/${max}` : String(attempt)
}

/** The row's line for its state. */
export function providerRetryText(state: ProviderRetryState): string {
  const retries = `${state.attempt} ${state.attempt === 1 ? 'retry' : 'retries'}`
  if (state.status === 'recovered') return `Provider recovered after ${retries}`
  if (state.status === 'stopped') return `Stopped retrying the provider after ${retries}`
  return `Retrying provider… (${count(state.attempt, state.maxAttempts)})`
}

/** The retries an error's details carry, when they are well formed. */
export function retriesOf(details: unknown): ProviderRetries | undefined {
  const raw = details && typeof details === 'object' ? (details as { retries?: unknown }).retries : undefined
  if (!raw || typeof raw !== 'object') return undefined
  const { attempt, max } = raw as { attempt?: unknown; max?: unknown }
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) return undefined
  return { attempt, ...(typeof max === 'number' && Number.isInteger(max) && max >= attempt ? { max } : {}) }
}

/** `after 10/10 retries`, for an error's title or its one-line text. */
export function retriesPhrase(retries: ProviderRetries): string {
  return `after ${count(retries.attempt, retries.max)} ${retries.max === 1 || (!retries.max && retries.attempt === 1) ? 'retry' : 'retries'}`
}

/**
 * What a provider's failed request was, in a few words, from its HTTP status (none: the request got no answer) and the
 * runtime's own name for the error, when it gave one.
 */
export function retryCause(status: number | null | undefined, kind?: string): string {
  if (status === null || status === undefined) return kind === 'rate_limit' ? 'rate limited' : 'connection error'
  if (status === 429) return 'rate limited'
  if (status === 529 || kind === 'overloaded') return `overloaded (${status})`
  if (status >= 500) return `server error ${status}`
  return `error ${status}`
}
