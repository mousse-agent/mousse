import { knownAppError, type AppError } from '../../../shared/errors'

/**
 * How a prompt that the agent answered counts for the turn (ACP `stopReason`). `end_turn`, an
 * answer with no reason and a reason Mousse does not know are a finished turn: an agent that
 * names its ending in its own words is not failed for it.
 */
export function promptStopOutcome(label: string, outcome: unknown): AppError | 'cancelled' | undefined {
  const reason = outcome && typeof outcome === 'object' ? (outcome as { stopReason?: unknown }).stopReason : undefined
  if (reason === 'cancelled') return 'cancelled'
  if (reason === 'refusal') return knownAppError({ code: 'acp_refusal', message: `${label} refused this request.` }, { category: 'denied', retryable: false })
  if (reason === 'max_tokens') return incomplete(label, 'it reached its token limit')
  if (reason === 'max_turn_requests') return incomplete(label, 'it reached its limit of model requests')
  return undefined
}

function incomplete(label: string, why: string): AppError {
  return knownAppError({ code: 'acp_incomplete_reply', message: `${label} stopped before it finished (${why}).` }, { category: 'unavailable', retryable: false })
}

/** The error a turn ends with when the agent cancelled the prompt itself; it reads as a stop, not a failure. */
export function agentCancelledError(label: string): Error {
  return Object.assign(new Error(`${label} cancelled the request.`), { name: 'AbortError' })
}
