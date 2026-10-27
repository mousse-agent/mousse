import { AppError, createErrorProvider, normalizeAppError, serializeAppError } from '../../shared/errors'

export const providerErrors = createErrorProvider({
  provider_effort_invalid: { category: 'invalid', retryable: false, message: 'Unknown reasoning effort. Check the model and effort settings.' },
  provider_effort_conflict: { category: 'invalid', retryable: false, message: 'Specify reasoning effort either in the model id or as effort, not both.' },
  provider_effort_unsupported: { category: 'invalid', retryable: false, message: 'The selected model does not support reasoning effort with these settings.' },
  provider_model_unknown: { category: 'invalid', retryable: false, message: 'Unknown model. Choose a configured model in Settings.' },
  provider_not_connected: { category: 'denied', retryable: false, message: 'The provider is not connected. Add or re-authenticate it in Settings.' },
  provider_auth_invalid: { category: 'denied', retryable: false, message: 'Provider authentication failed. Check your provider connection.' },
  provider_permission_denied: { category: 'denied', retryable: false, message: 'The provider denied this request. Check access to the selected model.' },
  provider_context_overflow: { category: 'invalid', retryable: false, message: 'The provider context window is full. Compact the conversation or start a new thread.' },
  provider_request_invalid: { category: 'invalid', retryable: false, message: 'The provider could not accept this request. Check the model and request settings.' },
  provider_quota_exceeded: { category: 'denied', retryable: false, message: 'The provider quota is exhausted. Check your billing or usage limits.' },
  provider_rate_limited: { category: 'unavailable', retryable: true, message: 'The provider is rate limiting requests. Please try again shortly.' },
  provider_usage_limit: { category: 'unavailable', retryable: false, message: 'The provider usage limit was reached.' },
  provider_unavailable: { category: 'unavailable', retryable: true, message: 'The provider is temporarily unavailable. Please try again.' },
  provider_timeout: { category: 'timeout', retryable: true, message: 'The provider response timed out. Please try again.' },
  provider_cancelled: { category: 'cancelled', retryable: false, message: 'The provider request was cancelled.' },
  provider_retry_exhausted: { category: 'unavailable', retryable: false, message: 'The provider is still unavailable after five retries. Please try again later.' },
  provider_unknown: { category: 'internal', retryable: false, message: 'The provider request failed. Please try again or check your provider connection.' }
})

export interface ProviderFailureResponse { status: number; retryAfter?: string }

/** A plan usage limit: which window was hit and when it resets (the provider's time, or an estimate). */
export interface UsageLimit {
  provider?: string
  /** ISO time the limit resets. */
  resetsAt?: string
  /** `resetsAt` is Mousse's estimate, not the provider's. */
  estimated: boolean
  /** The provider's name for the window, e.g. `five_hour`. */
  limitKind?: string
}

/** What a limit with no reported reset is assumed to last. */
export const USAGE_LIMIT_DEFAULT_ESTIMATE_MS = 5 * 60 * 60 * 1000
/** A reset further ahead than this is not believed. */
const USAGE_LIMIT_MAX_RESET_MS = 8 * 24 * 60 * 60 * 1000

export function estimatedReset(nowMs: number): string {
  return new Date(nowMs + USAGE_LIMIT_DEFAULT_ESTIMATE_MS).toISOString()
}

/** A reset this far past is a skewed clock or a reset that just happened, not a stale answer. */
const USAGE_LIMIT_RESET_TOLERANCE_MS = 5 * 60 * 1000
/** What a reset inside the tolerance becomes: shortly from now, so the continue turn is not sent before the provider has switched over. */
const USAGE_LIMIT_RESET_GRACE_MS = 30 * 1000

/**
 * A provider reset time (epoch seconds or ISO text) as ISO; undefined when unparseable, more than
 * 8 days ahead, or past by more than five minutes. A reset that passed within five minutes (the
 * limit just reset, or the local clock runs fast) becomes 30 seconds from now.
 */
export function boundedResetIso(epochSecondsOrIso: number | string | undefined, nowMs: number): string | undefined {
  const at = typeof epochSecondsOrIso === 'number' ? epochSecondsOrIso * 1000 : typeof epochSecondsOrIso === 'string' ? Date.parse(epochSecondsOrIso) : NaN
  if (!Number.isFinite(at) || at - nowMs > USAGE_LIMIT_MAX_RESET_MS || nowMs - at > USAGE_LIMIT_RESET_TOLERANCE_MS) return undefined
  return new Date(at > nowMs ? at : nowMs + USAGE_LIMIT_RESET_GRACE_MS).toISOString()
}

/** How the failure text and the pause line name a provider whose limit was hit. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = { claude: 'Claude', 'claude-subscription': 'Claude', codex: 'Codex', anthropic: 'Anthropic', openai: 'OpenAI', 'openai-codex': 'ChatGPT' }
const LIMIT_KIND_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage'
}

function usageLimitMessage(limit: UsageLimit, nowMs: number): string {
  const who = limit.provider ? PROVIDER_LABELS[limit.provider] ?? limit.provider : 'The provider'
  const window = limit.limitKind ? LIMIT_KIND_LABELS[limit.limitKind] ?? limit.limitKind.replace(/_/g, ' ') : undefined
  const head = `${who}'s ${window ? `${window} ` : ''}usage limit was reached.`
  if (!limit.resetsAt) return head
  const reset = new Date(limit.resetsAt)
  const sameDay = reset.toDateString() === new Date(nowMs).toDateString()
  const at = reset.toLocaleString([], { ...(sameDay ? {} : { weekday: 'short' }), hour: 'numeric', minute: '2-digit' })
  return `${head} It resets at ${at}${limit.estimated ? ' (estimated)' : ''}.`
}

/**
 * The error for a usage limit. A missing, past or implausible reset becomes a 5-hour estimate.
 * `extra` carries the diagnostic details of the failure it came from (status, request id).
 */
export function usageLimitError(limit: UsageLimit, cause?: unknown, extra: Record<string, unknown> = {}): AppError {
  const nowMs = Date.now()
  const reported = limit.estimated ? undefined : boundedResetIso(limit.resetsAt, nowMs)
  const resolved: UsageLimit = { ...limit, resetsAt: reported ?? estimatedReset(nowMs), estimated: reported === undefined }
  const definition = providerErrors.create('provider_usage_limit')
  return new AppError({
    code: definition.code,
    message: usageLimitMessage(resolved, nowMs),
    errorInfo: definition.errorInfo,
    details: { ...extra, ...(resolved.provider ? { provider: resolved.provider } : {}), resetsAt: resolved.resetsAt, estimated: resolved.estimated, ...(resolved.limitKind ? { limitKind: resolved.limitKind } : {}) }
  }, cause)
}

/** The usage limit an error stands for, or undefined when it is anything else. */
export function readUsageLimit(error: unknown): UsageLimit | undefined {
  if (!(error instanceof AppError) || error.code !== 'provider_usage_limit') return undefined
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {}
  const resetsAt = typeof details.resetsAt === 'string' ? details.resetsAt : undefined
  return {
    ...(typeof details.provider === 'string' ? { provider: details.provider } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    estimated: details.estimated !== false || !resetsAt,
    ...(typeof details.limitKind === 'string' ? { limitKind: details.limitKind } : {})
  }
}

/** pi-ai AssistantMessage exposes only errorMessage; host captures allowlisted HTTP metadata. */
export function normalizeProviderError(error: unknown, provider?: string, response?: ProviderFailureResponse): AppError {
  if (error instanceof AppError) return error
  const shape = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; headers?: { get?: (key: string) => string | null } } : undefined
  const text = typeof shape?.message === 'string' ? shape.message : typeof error === 'string' ? error : ''
  const formattedStatus = /^\s*(?:HTTP\s+)?([45]\d{2})(?:\s*:|\s+)/.exec(text)
  const status = typeof shape?.status === 'number' ? shape.status : typeof shape?.statusCode === 'number' ? shape.statusCode : response && response.status >= 400 ? response.status : formattedStatus ? Number(formattedStatus[1]) : undefined
  const code = typeof shape?.code === 'string' ? shape.code.toLowerCase() : ''
  const details = { ...(provider ? { provider } : {}), ...(status !== undefined ? { status } : {}) }
  if (shape?.name === 'AbortError' || /^(?:request (?:was )?aborted|cursor request aborted)/i.test(text)) return providerErrors.create('provider_cancelled', error, details)
  if (shape?.name === 'ProviderStreamStallError') return withRetryDelay(providerErrors.create('provider_timeout', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  // Permanent classifications have precedence even if messages contain transport words.
  if (status === 401 || /authentication_error|invalid_api_key/.test(code) || /invalid (?:api key|auth|credential)|authentication (?:failed|required|error)|unauthorized|incorrect api key/i.test(text)) return providerErrors.create('provider_auth_invalid', error, details)
  if (status === 403 || /permission_denied/.test(code) || /permission denied|forbidden|access denied|denied by policy|refused by policy/i.test(text)) return providerErrors.create('provider_permission_denied', error, details)
  if (/hit your ChatGPT usage limit/i.test(text)) return usageLimitError({ provider, estimated: true }, error, details)
  if (/insufficient_quota|quota_exceeded|billing/.test(code) || /insufficient[_ ]quota|quota (?:exceeded|exhausted)|billing (?:limit|error)|credit balance|GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|out of budget/i.test(text)) return providerErrors.create('provider_quota_exceeded', error, details)
  if (/context(?:_|\s|-)*(?:window|length|limit)|maximum context|too many tokens|prompt is too long/i.test(text)) return providerErrors.create('provider_context_overflow', error, details)
  if ((status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) || /invalid_request|model_not_found/.test(code) || /invalid request|unknown model|model (?:not found|does not exist)/i.test(text)) return providerErrors.create('provider_request_invalid', error, details)
  if (status === 429 || /rate_limit/.test(code) || /rate[_ ]limit|too many requests/i.test(text)) {
    const retryAfter = shape?.headers?.get?.('retry-after') ?? response?.retryAfter
    // A wait too long to retry in-turn is a usage limit; the server's time says when it resets.
    const seconds = retryAfterSeconds(retryAfter)
    if (seconds !== undefined && seconds > 10) return usageLimitError({ provider, resetsAt: new Date(Date.now() + seconds * 1000).toISOString(), estimated: false }, error, details)
    return withRetryDelay(providerErrors.create('provider_rate_limited', error, details), retryAfter, error)
  }
  if (status === 408 || /etimedout|timeout/.test(code) || /timed?\s*out|timeout/i.test(text)) return withRetryDelay(providerErrors.create('provider_timeout', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  if (shape?.name === 'APIConnectionError' || (status !== undefined && [500, 502, 503, 504, 529].includes(status)) || /^(?:econnreset|econnrefused|econnaborted|enotfound|eai_again)$/.test(code) || /^connection (?:error|refused|lost)[.!]?(?:$|\s)|fetch failed|network error|websocket error|econn(?:reset|refused|aborted)|enotfound|eai_again|socket hang up|unable to connect|internal server error|temporarily unavailable|provider (?:is )?overloaded|\boverloaded(?:_error)?\b|\bapi_error\b|upstream (?:service )?error|codex error:.*retry your request/i.test(text)) return withRetryDelay(providerErrors.create('provider_unavailable', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  const fallback = normalizeAppError(error, 'provider_unknown')
  return new AppError({ ...fallback, message: `${providerErrors.create('provider_unknown').message} Reference: ${(fallback.details as { supportId: string }).supportId}`, errorInfo: { category: 'internal', retryable: false } }, error)
}

/** A `retry-after` header (seconds or an HTTP date) as seconds from now; undefined when absent or unreadable. */
function retryAfterSeconds(raw: string | null | undefined): number | undefined {
  const seconds = raw ? (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Math.max(0, (Date.parse(raw) - Date.now()) / 1000)) : undefined
  return seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined
}

/** Honor server delay for every recognized transient HTTP failure. */
function withRetryDelay(result: AppError, raw: string | null | undefined, cause: unknown): AppError {
  const seconds = retryAfterSeconds(raw)
  if (seconds === undefined) return result
  const errorInfo = seconds > 10
    ? { ...result.errorInfo, retryable: false }
    : { ...result.errorInfo, retryAfterMs: seconds * 1000 }
  return new AppError({ ...serializeAppError(result), errorInfo }, cause)
}
