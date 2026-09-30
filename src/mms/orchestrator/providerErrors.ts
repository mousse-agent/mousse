import { AppError, createErrorProvider, normalizeAppError, serializeAppError } from '../../shared/errors'

export const providerErrors = createErrorProvider({
  provider_not_connected: { category: 'denied', retryable: false, message: 'The provider is not connected. Add or re-authenticate it in Settings.' },
  provider_auth_invalid: { category: 'denied', retryable: false, message: 'Provider authentication failed. Check your provider connection.' },
  provider_permission_denied: { category: 'denied', retryable: false, message: 'The provider denied this request. Check access to the selected model.' },
  provider_context_overflow: { category: 'invalid', retryable: false, message: 'The provider context window is full. Compact the conversation or start a new thread.' },
  provider_request_invalid: { category: 'invalid', retryable: false, message: 'The provider could not accept this request. Check the model and request settings.' },
  provider_quota_exceeded: { category: 'denied', retryable: false, message: 'The provider quota is exhausted. Check your billing or usage limits.' },
  provider_rate_limited: { category: 'unavailable', retryable: true, message: 'The provider is rate limiting requests. Please try again shortly.' },
  provider_unavailable: { category: 'unavailable', retryable: true, message: 'The provider is temporarily unavailable. Please try again.' },
  provider_timeout: { category: 'timeout', retryable: true, message: 'The provider response timed out. Please try again.' },
  provider_cancelled: { category: 'cancelled', retryable: false, message: 'The provider request was cancelled.' },
  provider_retry_exhausted: { category: 'unavailable', retryable: false, message: 'The provider is still unavailable after five retries. Please try again later.' },
  provider_unknown: { category: 'internal', retryable: false, message: 'The provider request failed. Please try again or check your provider connection.' }
})

export interface ProviderFailureResponse { status: number; retryAfter?: string }

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
  if (status === 401 || /authentication_error|invalid_api_key/.test(code) || /invalid (?:api key|auth|credential)|authentication (?:failed|required|error)|unauthorized|incorrect api key|401\b/i.test(text)) return providerErrors.create('provider_auth_invalid', error, details)
  if (status === 403 || /permission_denied/.test(code) || /permission denied|forbidden|access denied|denied by policy|refused by policy|403\b/i.test(text)) return providerErrors.create('provider_permission_denied', error, details)
  if (/insufficient_quota|quota_exceeded|billing/.test(code) || /insufficient[_ ]quota|quota (?:exceeded|exhausted)|billing (?:limit|error)|credit balance|GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|out of budget|hit your ChatGPT usage limit/i.test(text)) return providerErrors.create('provider_quota_exceeded', error, details)
  if (/context(?:_|\s|-)*(?:window|length|limit)|maximum context|too many tokens|prompt is too long/i.test(text)) return providerErrors.create('provider_context_overflow', error, details)
  if ((status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) || /invalid_request|model_not_found/.test(code) || /invalid request|unknown model|model (?:not found|does not exist)|\b(?:400|404|422)\b/i.test(text)) return providerErrors.create('provider_request_invalid', error, details)
  if (status === 429 || /rate_limit/.test(code) || /rate limit|too many requests|\b429\b/i.test(text)) {
    return withRetryDelay(providerErrors.create('provider_rate_limited', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  }
  if (status === 408 || /etimedout|timeout/.test(code) || /timed?\s*out|timeout/i.test(text)) return withRetryDelay(providerErrors.create('provider_timeout', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  if (shape?.name === 'APIConnectionError' || (status !== undefined && [500, 502, 503, 504, 529].includes(status)) || /^(?:econnreset|econnrefused|econnaborted|enotfound|eai_again)$/.test(code) || /^connection (?:error|refused|lost)[.!]?(?:$|\s)|fetch failed|network error|websocket error|econn(?:reset|refused|aborted)|enotfound|eai_again|socket hang up|unable to connect|internal server error|temporarily unavailable|provider (?:is )?overloaded|upstream (?:service )?error|codex error:.*retry your request/i.test(text)) return withRetryDelay(providerErrors.create('provider_unavailable', error, details), shape?.headers?.get?.('retry-after') ?? response?.retryAfter, error)
  const fallback = normalizeAppError(error, 'provider_unknown')
  return new AppError({ ...fallback, message: `${providerErrors.create('provider_unknown').message} Reference: ${(fallback.details as { supportId: string }).supportId}`, errorInfo: { category: 'internal', retryable: false } }, error)
}

/** Honor server delay for every recognized transient HTTP failure. */
function withRetryDelay(result: AppError, raw: string | null | undefined, cause: unknown): AppError {
  const seconds = raw ? (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Math.max(0, (Date.parse(raw) - Date.now()) / 1000)) : undefined
  if (seconds === undefined || !Number.isFinite(seconds)) return result
  const errorInfo = seconds > 10
    ? { ...result.errorInfo, retryable: false }
    : { ...result.errorInfo, retryAfterMs: seconds * 1000 }
  return new AppError({ ...serializeAppError(result), errorInfo }, cause)
}
