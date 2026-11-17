import { AppError, knownAppError } from '../../../shared/errors'
import { providerReportedError } from '../../orchestrator/providerErrors'

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

/** JSON-RPC's reserved error codes: an agent's answer that a request failed carries one of them. */
const RPC_ERROR_CODES = { min: -32768, max: -32000 }

/**
 * A request the agent answered with an error (a provider's refusal it passes on, `Internal error: API Error: 400 …`), as
 * the provider's status and message for the transcript. The text comes from the `data` the agent attached when the
 * message is only the SDK's label. Undefined for anything that is not the agent's answer (a closed connection, a stop).
 */
export function acpAgentError(error: unknown): AppError | undefined {
  if (!error || typeof error !== 'object' || error instanceof AppError) return undefined
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof code !== 'number' || code < RPC_ERROR_CODES.min || code > RPC_ERROR_CODES.max) return undefined
  const label = typeof message === 'string' ? message.trim() : ''
  const attached = typeof data === 'string' ? data : data && typeof data === 'object' ? ['message', 'details', 'error'].map((key) => (data as Record<string, unknown>)[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '') : undefined
  // The SDK's label alone (`Internal error`) says nothing: the agent's own text is in `data`.
  const text = attached && (!label || /^internal error\.?$/i.test(label)) ? attached : label || attached
  if (!text) return undefined
  const status = data && typeof data === 'object' ? [(data as { status?: unknown }).status, (data as { statusCode?: unknown }).statusCode].find((value): value is number => typeof value === 'number') : undefined
  return providerReportedError(text, { ...(status !== undefined ? { status } : {}), cause: error })
}
