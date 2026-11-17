import { describe, expect, it, vi } from 'vitest'
import { boundedResetIso, estimatedReset, normalizeProviderError, providerApiError, providerReportedError, PROVIDER_MESSAGE_CHARS, readProviderStatus, readUsageLimit, usageLimitError } from '../src/mms/orchestrator/providerErrors'
import { assertAssistantResponseSucceeded } from '../src/mms/harness/drivers/pi/stream'
import { classifyProviderFailure } from '../src/mms/agentDefinitions/runtimeFallback'
import { serializeAppError } from '../src/shared/errors'
import { APIConnectionError, InternalServerError } from '@anthropic-ai/sdk'

describe('provider error classification', () => {
  it.each([
    [401, 'network timeout connecting to provider', 'provider_auth_invalid'],
    [403, 'connection reset refused by policy', 'provider_permission_denied'],
    [400, 'invalid request timeout parameter', 'provider_request_invalid'],
    [404, 'unknown model network failure', 'provider_request_invalid'],
    [422, 'invalid connection request', 'provider_request_invalid']
  ])('fails fast for permanent status %i despite transient words', (status, message, code) => {
    expect(normalizeProviderError({ status, message }, 'anthropic')).toMatchObject({ code, errorInfo: { retryable: false } })
  })

  it('never retries exhausted quota even when the SDK gives 429', () => {
    expect(normalizeProviderError({ status: 429, code: 'insufficient_quota', message: 'retry connection' }))
      .toMatchObject({ code: 'provider_quota_exceeded', errorInfo: { retryable: false } })
  })

  it.each([
    [{ status: 503, message: 'provider down' }, 'provider_unavailable'],
    [{ code: 'ECONNRESET', message: 'read reset' }, 'provider_unavailable'],
    [new Error('WebSocket error'), 'provider_unavailable'],
    [new Error('fetch failed'), 'provider_unavailable'],
    [new Error('Codex error: An error occurred while processing your request. You can retry your request. Please include the request ID be0fccad-64fb-411a-885b-d79ba7239230.'), 'provider_unavailable'],
    [{ statusCode: 408, message: 'request elapsed' }, 'provider_timeout'],
    [{ code: 'ETIMEDOUT', message: 'request elapsed' }, 'provider_timeout']
  ])('recognizes supported transient evidence %j', (error, code) => {
    expect(normalizeProviderError(error)).toMatchObject({ code, errorInfo: { retryable: true } })
  })

  it('honors cancellation before permanent status and timeout wording', () => {
    expect(normalizeProviderError({ name: 'AbortError', status: 401, message: 'timeout' }))
      .toMatchObject({ code: 'provider_cancelled', errorInfo: { category: 'cancelled', retryable: false } })
  })

  it.each([[2, true, 2000], [10, true, 10000]])(
    'honors bounded retry-after %i seconds', (seconds, retryable, retryAfterMs) => {
      const error = normalizeProviderError({ status: 429, headers: new Headers({ 'Retry-After': String(seconds) }) })
      expect(error.code).toBe('provider_rate_limited')
      expect(error.errorInfo.retryable).toBe(retryable)
      expect(error.errorInfo.retryAfterMs).toBe(retryAfterMs)
    })

  describe('usage limits', () => {
    const at = new Date('2026-10-01T00:00:00Z')
    const withClock = (run: () => void) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(at)
        run()
      } finally { vi.useRealTimers() }
    }

    it('a 429 that asks to wait over 10 seconds is a usage limit with the server time', () => withClock(() => {
      const error = normalizeProviderError({ status: 429, headers: new Headers({ 'Retry-After': '3600' }) }, 'openai-codex')
      expect(error).toMatchObject({ code: 'provider_usage_limit', errorInfo: { category: 'unavailable', retryable: false } })
      expect(error.errorInfo.retryAfterMs).toBeUndefined()
      expect(error.details).toEqual({ provider: 'openai-codex', status: 429, resetsAt: '2026-10-01T01:00:00.000Z', estimated: false })
      expect(readUsageLimit(error)).toEqual({ provider: 'openai-codex', resetsAt: '2026-10-01T01:00:00.000Z', estimated: false })
    }))

    it('a wait of exactly 11 seconds already pauses, and captured response metadata counts', () => withClock(() => {
      expect(normalizeProviderError('429: slow down', 'pi', { status: 429, retryAfter: '11' })).toMatchObject({
        code: 'provider_usage_limit',
        details: { resetsAt: '2026-10-01T00:00:11.000Z', estimated: false }
      })
    }))

    it('the ChatGPT usage-limit message is a usage limit with an estimated reset', () => withClock(() => {
      const error = normalizeProviderError(new Error('You hit your ChatGPT usage limit. Try again at 2:01 PM.'), 'openai-codex')
      expect(error.code).toBe('provider_usage_limit')
      expect(readUsageLimit(error)).toEqual({ provider: 'openai-codex', resetsAt: '2026-10-01T05:00:00.000Z', estimated: true })
    }))

    it('quota exhaustion stays a failure, not a usage limit', () => {
      expect(normalizeProviderError({ status: 429, code: 'insufficient_quota', headers: new Headers({ 'Retry-After': '3600' }) }).code).toBe('provider_quota_exceeded')
      expect(readUsageLimit(normalizeProviderError({ status: 429, message: 'Monthly usage limit reached' }))).toBeUndefined()
    })

    it('a reset in the past or more than 8 days ahead is replaced by the estimate', () => withClock(() => {
      for (const resetsAt of ['2026-09-30T00:00:00Z', '2026-10-20T00:00:00Z', 'not a date']) {
        expect(readUsageLimit(usageLimitError({ resetsAt, estimated: false, limitKind: 'five_hour' }))).toEqual({
          resetsAt: '2026-10-01T05:00:00.000Z',
          estimated: true,
          limitKind: 'five_hour'
        })
      }
    }))

    it('boundedResetIso accepts epoch seconds and ISO text inside the window only', () => {
      const now = at.getTime()
      expect(boundedResetIso(now / 1000 + 60, now)).toBe('2026-10-01T00:01:00.000Z')
      expect(boundedResetIso('2026-10-01T00:01:00Z', now)).toBe('2026-10-01T00:01:00.000Z')
      // A reset that just passed (or a fast local clock) is not an estimate: shortly from now.
      expect(boundedResetIso(now / 1000 - 1, now)).toBe('2026-10-01T00:00:30.000Z')
      expect(boundedResetIso(now / 1000 - 299, now)).toBe('2026-10-01T00:00:30.000Z')
      expect(boundedResetIso(now / 1000 - 301, now)).toBeUndefined()
      expect(boundedResetIso(now / 1000 + 8 * 86_400 + 1, now)).toBeUndefined()
      expect(boundedResetIso(undefined, now)).toBeUndefined()
      expect(boundedResetIso(Number.NaN, now)).toBeUndefined()
      expect(estimatedReset(now)).toBe('2026-10-01T05:00:00.000Z')
    })

    it('names the window and says whether the reset is estimated', () => withClock(() => {
      const reported = usageLimitError({ provider: 'claude', resetsAt: '2026-10-01T03:00:00Z', estimated: false, limitKind: 'seven_day_opus' })
      expect(reported.message).toMatch(/^Claude's weekly Opus usage limit was reached\. It resets at /)
      expect(reported.message).not.toMatch(/estimated/)
      const guessed = usageLimitError({ provider: 'codex', estimated: true, limitKind: 'five_hour' })
      expect(guessed.message).toMatch(/^Codex's 5-hour usage limit was reached\. It resets at .+ \(estimated\)\.$/)
    }))

    it('keeps the reset details through serialization and ignores other errors', () => {
      const error = usageLimitError({ provider: 'claude', resetsAt: new Date(Date.now() + 3_600_000).toISOString(), estimated: false, limitKind: 'five_hour' })
      expect(serializeAppError(error).details).toMatchObject({ provider: 'claude', estimated: false, limitKind: 'five_hour' })
      expect(readUsageLimit(new Error('usage limit'))).toBeUndefined()
      expect(readUsageLimit(normalizeProviderError({ status: 503 }))).toBeUndefined()
    })
  })

  it('keeps unfamiliar provider errors fail-fast with safe public text and local cause', () => {
    const original = new Error('unrecognized provider failure sk-privateFixture /Users/private/path')
    const error = normalizeProviderError(original)
    expect(error.cause).toBe(original)
    expect(error).toMatchObject({ code: 'provider_unknown', errorInfo: { category: 'internal', retryable: false } })
    expect(JSON.stringify(serializeAppError(error))).not.toMatch(/privateFixture|private\/path|unrecognized provider failure/)
  })

  it("reads the status after pi-ai's Responses label (`xai API error (400): …`), as Pi's xAI and OpenAI entries report it", () => {
    // pi-ai's `formatProviderError(…, '<provider> API error')` (openai-responses.js, azure-openai-responses.js).
    expect(normalizeProviderError(new Error('xai API error (400): 400 Unsupported schema for tool escalate'), 'xai')).toMatchObject({ code: 'provider_request_invalid', details: { provider: 'xai', status: 400 } })
    expect(normalizeProviderError(new Error('xai API error (401): Incorrect API key provided'), 'xai').code).toBe('provider_auth_invalid')
    expect(normalizeProviderError(new Error('OpenAI API error (403): {"error":"no"}'), 'openai').code).toBe('provider_permission_denied')
    expect(normalizeProviderError(new Error('Azure OpenAI API error (503): busy'), 'azure')).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
    // A status further in the text is not one.
    expect(normalizeProviderError(new Error('the tool said: request error (400): no'), 'xai').code).toBe('provider_unknown')
  })

  it('honors short Retry-After for 503 from structured errors and captured HTTP metadata', () => {
    const structured = normalizeProviderError({ status: 503, headers: new Headers({ 'Retry-After': '2' }) }, 'anthropic')
    const captured = normalizeProviderError('503: Service is busy', 'anthropic', { status: 503, retryAfter: '2' })
    for (const error of [structured, captured]) {
      expect(error).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true, retryAfterMs: 2000 } })
      expect(error.details).toEqual({ provider: 'anthropic', status: 503 })
    }
  })

  it('honors HTTP-date retry-after without retrying before a long server delay', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
      const short = normalizeProviderError({ status: 429, headers: new Headers({ 'Retry-After': 'Thu, 01 Oct 2026 00:00:04 GMT' }) })
      expect(short.errorInfo).toMatchObject({ retryable: true, retryAfterMs: 4000 })
      const long = normalizeProviderError({ status: 429, headers: new Headers({ 'Retry-After': 'Thu, 01 Oct 2026 00:01:00 GMT' }) })
      expect(long.errorInfo.retryable).toBe(false)
      expect(long.errorInfo.retryAfterMs).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('classifies the actual Anthropic SDK connection error and its pi string-only form', () => {
    const sdkError = new APIConnectionError({})
    expect(sdkError.message).toBe('Connection error.')
    expect(normalizeProviderError(sdkError)).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
    expect(normalizeProviderError(sdkError.message)).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
  })

  it('recognizes status lost into the actual Anthropic SDK formatted error string', () => {
    const sdkError = new InternalServerError(503, { error: { type: 'overloaded_error', message: 'Service is busy' } }, 'Service is busy', new Headers())
    expect(sdkError.message).toContain('503')
    expect(normalizeProviderError(sdkError.message)).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
  })

  it.each(['GoUsageLimitError', 'FreeUsageLimitError', 'Monthly usage limit reached', 'available balance', 'out of budget'])(
    'preserves pi SDK permanent quota classification for %s', (message) => {
      // These markers come from installed pi-ai utils/retry.js and
      // api/openai-codex-responses.js permanent-quota handling.
      expect(normalizeProviderError({ status: 429, message })).toMatchObject({ code: 'provider_quota_exceeded', errorInfo: { retryable: false } })
      expect(normalizeProviderError(message)).toMatchObject({ code: 'provider_quota_exceeded', errorInfo: { retryable: false } })
    })
})

describe('a provider refusal a runtime reports as text', () => {
  it('keeps the provider\'s status and message, not a generic line', () => {
    const error = providerApiError('API Error: 400 messages.3.content.0: tool_use ids were found without tool_result blocks', 'claude')!
    expect(error).toMatchObject({ code: 'provider_api_error', message: '400 · messages.3.content.0: tool_use ids were found without tool_result blocks', errorInfo: { category: 'invalid', retryable: false } })
    expect(serializeAppError(error).details).toMatchObject({ provider: 'claude', status: 400, supportId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  })

  it('reads the message of a JSON body', () => {
    const error = providerApiError('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_1"}')!
    expect(error.message).toBe('500 · Internal server error')
    expect(error.errorInfo).toEqual({ category: 'unavailable', retryable: false })
  })

  it('trims the text, removes credentials and cuts a long message', () => {
    const error = providerApiError(`API Error: 401   Invalid  key sk-ant-api03-abcdefghijklmnop\n${'x'.repeat(900)}`)!
    expect(error.message.startsWith('401 · Invalid key [redacted] x')).toBe(true)
    expect(error.message.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_CHARS + 6)
    expect(error.message.endsWith('…')).toBe(true)
    expect(error.errorInfo.category).toBe('denied')
  })

  it('is undefined for any other text', () => {
    expect(providerApiError('API Error: Connection error.')).toBeUndefined()
    expect(providerApiError('Claude Code turn failed')).toBeUndefined()
  })

  it('keeps a rate limit classified as one for fallbacks', () => {
    expect(classifyProviderFailure(providerApiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many tokens per minute"}}'))).toBe('rate_limit')
  })
})

describe('a provider refusal on the Pi runtime and its API routes', () => {
  it('a 400 with a JSON body shows the provider\'s status and message, keeping its classification', () => {
    const error = normalizeProviderError('400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 99999999 > 64000, which is the maximum allowed"}}', 'anthropic')
    expect(error).toMatchObject({ code: 'provider_request_invalid', message: '400 · max_tokens: 99999999 > 64000, which is the maximum allowed', errorInfo: { category: 'invalid', retryable: false } })
    expect(serializeAppError(error).details).toMatchObject({ provider: 'anthropic', status: 400, supportId: expect.any(String) })
  })

  it('reads pi-ai\'s labelled form and the status the host captured', () => {
    expect(normalizeProviderError('xai API error (400): Model grok-x does not support images', 'xai').message).toBe('400 · Model grok-x does not support images')
    const assistant = { role: 'assistant', stopReason: 'error', errorMessage: '{"error":{"message":"The model `gpt-x` does not exist or you do not have access to it."}}', provider: 'openai' } as never
    expect(() => assertAssistantResponseSucceeded(assistant, { status: 404 })).toThrow(expect.objectContaining({ code: 'provider_request_invalid', message: '404 · The model `gpt-x` does not exist or you do not have access to it.' }))
  })

  it('a 403 keeps its kind and shows the provider\'s message', () => {
    expect(normalizeProviderError({ status: 403, message: '403 Your organization is not allowed to use this model.' }, 'openai'))
      .toMatchObject({ code: 'provider_permission_denied', message: '403 · Your organization is not allowed to use this model.', errorInfo: { category: 'denied' } })
  })

  it('removes credentials and cuts a long message', () => {
    const error = normalizeProviderError(`400 Bad key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 ${'y'.repeat(900)}\nAuthorization: Bearer abc.def.ghi`, 'openrouter')
    expect(error.message).not.toMatch(/sk-or|abc\.def/)
    expect(error.message.length).toBeLessThanOrEqual(PROVIDER_MESSAGE_CHARS + 6)
    expect(error.message.endsWith('…')).toBe(true)
  })

  it('keeps sign-in, usage-limit, retry and overflow paths', () => {
    expect(normalizeProviderError({ status: 401, message: '401 invalid x-api-key' })).toMatchObject({ code: 'provider_auth_invalid', message: 'Provider authentication failed. Check your provider connection.' })
    const limit = normalizeProviderError({ status: 429, message: '429 rate limited', headers: { get: () => '3600' } }, 'openai')
    expect(readUsageLimit(limit)).toMatchObject({ provider: 'openai', estimated: false })
    expect(normalizeProviderError({ status: 503, message: '503 upstream' })).toMatchObject({ code: 'provider_unavailable', errorInfo: { retryable: true } })
    expect(normalizeProviderError({ status: 400, message: '400 prompt is too long: 250000 tokens' })).toMatchObject({ code: 'provider_context_overflow' })
  })
})

describe('the status forms runtimes report a refusal in', () => {
  it.each([
    ['API Error: 400 bad', 400, 'bad'],
    ['unexpected status 400 Bad Request: bad, url: http://x/v1/responses, request id: r1', 400, 'bad'],
    ['[API Error: got status: 429 Too Many Requests. {"error":{"message":"Resource exhausted"}}]', 429, '{"error":{"message":"Resource exhausted"}}'],
    ['openai API error (404): no such model', 404, 'no such model'],
    ['HTTP 502: Bad gateway', 502, 'Bad gateway']
  ])('%s', (text, status, body) => {
    expect(readProviderStatus(text)).toEqual({ status, body })
  })

  it('a reported failure without a status shows its message alone; an ACP label is dropped', () => {
    expect(providerReportedError('Internal error: API Error: 400 {"error":{"message":"tool_use ids were found without tool_result blocks"}}')).toMatchObject({ code: 'provider_api_error', message: '400 · tool_use ids were found without tool_result blocks' })
    expect(providerReportedError('  rate limit   reached ', { provider: 'grok' })).toMatchObject({ message: 'rate limit reached', errorInfo: { category: 'unavailable', retryable: false } })
    expect(providerReportedError('Model not available', { status: 400 })).toMatchObject({ message: '400 · Model not available' })
  })
})
