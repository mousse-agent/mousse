import { describe, expect, it, vi } from 'vitest'
import { normalizeProviderError } from '../src/mms/orchestrator/providerErrors'
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
    [{ statusCode: 408, message: 'request elapsed' }, 'provider_timeout'],
    [{ code: 'ETIMEDOUT', message: 'request elapsed' }, 'provider_timeout']
  ])('recognizes supported transient evidence %j', (error, code) => {
    expect(normalizeProviderError(error)).toMatchObject({ code, errorInfo: { retryable: true } })
  })

  it('honors cancellation before permanent status and timeout wording', () => {
    expect(normalizeProviderError({ name: 'AbortError', status: 401, message: 'timeout' }))
      .toMatchObject({ code: 'provider_cancelled', errorInfo: { category: 'cancelled', retryable: false } })
  })

  it.each([[2, true, 2000], [10, true, 10000], [11, false, undefined]])(
    'honors bounded retry-after %i seconds without shortening long waits', (seconds, retryable, retryAfterMs) => {
      const error = normalizeProviderError({ status: 429, headers: new Headers({ 'Retry-After': String(seconds) }) })
      expect(error.code).toBe('provider_rate_limited')
      expect(error.errorInfo.retryable).toBe(retryable)
      expect(error.errorInfo.retryAfterMs).toBe(retryAfterMs)
    })

  it('keeps unfamiliar provider errors fail-fast with safe public text and local cause', () => {
    const original = new Error('unrecognized provider failure sk-privateFixture /Users/private/path')
    const error = normalizeProviderError(original)
    expect(error.cause).toBe(original)
    expect(error).toMatchObject({ code: 'provider_unknown', errorInfo: { category: 'internal', retryable: false } })
    expect(JSON.stringify(serializeAppError(error))).not.toMatch(/privateFixture|private\/path|unrecognized provider failure/)
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
