import { AppError, knownAppError } from '../../../shared/errors'
import { providerReportedError, usageLimitError } from '../../orchestrator/providerErrors'

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
export function acpAgentError(error: unknown, provider?: string): AppError | undefined {
  if (!error || typeof error !== 'object' || error instanceof AppError) return undefined
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof code !== 'number' || code < RPC_ERROR_CODES.min || code > RPC_ERROR_CODES.max) return undefined
  const label = typeof message === 'string' ? message.trim() : ''
  const attached = typeof data === 'string' ? data : data && typeof data === 'object' ? ['message', 'details', 'error'].map((key) => (data as Record<string, unknown>)[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '') : undefined
  // The SDK's label alone (`Internal error`) says nothing: the agent's own text is in `data`.
  const text = attached && (!label || /^internal error\.?$/i.test(label)) ? attached : label || attached
  if (!text) return undefined
  const status = data && typeof data === 'object' ? [(data as { status?: unknown }).status, (data as { statusCode?: unknown }).statusCode].find((value): value is number => typeof value === 'number') : undefined
  return acpQuotaLimit(text, provider, error) ?? providerReportedError(text, { ...(status !== undefined ? { status } : {}), cause: error })
}

/** A wait this short is a rate limit the next attempt may clear, not a plan limit to pause for. */
const QUOTA_MIN_RESET_MS = 10_000

/** `Resets in 4h29m13s` (also days, and spaces between the parts) in milliseconds; undefined without one. */
function resetsInMs(text: string): number | undefined {
  const match = /\bresets? in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(text)
  if (!match) return undefined
  const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }
  let total = 0
  for (const [, amount, part] of match[1]!.matchAll(/(\d+)\s*([dhms])/gi)) total += Number(amount) * unit[part!.toLowerCase()]!
  return total
}

/**
 * A plan quota an agent reports as its error, as Antigravity does (`RESOURCE_EXHAUSTED (code 429): Individual quota
 * reached. Please upgrade your subscription to increase your limits. Resets in 4h29m13s.`): a usage limit, so the run
 * pauses until the time it names, or an estimate when it names none. A reset only seconds away is left as the rate
 * limit it is. Undefined for any other text.
 */
export function acpQuotaLimit(text: string, provider: string | undefined, cause?: unknown, nowMs: number = Date.now()): AppError | undefined {
  if (!/\bRESOURCE_EXHAUSTED\b|\b429\b/.test(text)) return undefined
  return quotaLimit(text, provider, cause, nowMs)
}

/** The notice agy writes as its reply, or as the reply's last line, when the quota is used up (agy 1.5.13). */
const QUOTA_NOTICE = /(?:^|\n)[^\S\n]*(?:⚠\s*)?(Individual quota reached\b[^\n]*)\s*$/i

/** The quota notice that ends `reply` ("Individual quota reached. … Resets in 3h45m30s."), without its ⚠; undefined when none. */
export function quotaNotice(reply: string): string | undefined {
  return QUOTA_NOTICE.exec(reply)?.[1]?.trim()
}

/**
 * A prompt agy ended normally whose reply ends with its quota notice: never an answer. A usage limit as `acpQuotaLimit`
 * reads it; a reset only seconds away is a rate limit the next attempt may clear. Undefined for any other reply.
 */
export function acpQuotaReply(reply: string, provider: string | undefined, nowMs: number = Date.now()): AppError | undefined {
  const notice = quotaNotice(reply)
  if (!notice) return undefined
  return quotaLimit(notice, provider, undefined, nowMs) ?? providerReportedError(notice, { status: 429, ...(provider ? { provider } : {}) })
}

function quotaLimit(text: string, provider: string | undefined, cause: unknown, nowMs: number): AppError | undefined {
  const resetIn = resetsInMs(text)
  if (resetIn === undefined && !/\bquota (?:was )?reached\b|\busage limit\b/i.test(text)) return undefined
  if (resetIn !== undefined && resetIn <= QUOTA_MIN_RESET_MS) return undefined
  return usageLimitError({
    ...(provider ? { provider } : {}),
    ...(resetIn !== undefined ? { resetsAt: new Date(nowMs + resetIn).toISOString() } : {}),
    estimated: resetIn === undefined
  }, cause, { status: 429 })
}
