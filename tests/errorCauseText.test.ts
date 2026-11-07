import { describe, expect, it } from 'vitest'
import { AppError, errorCauseText, errorDiagnostic } from '../src/shared/errors'
import { normalizeProviderError } from '../src/mms/orchestrator/providerErrors'

describe('errorCauseText', () => {
  const key = `xai-${'Ab3'.repeat(20)}`

  it('keeps what the provider said behind a provider_unknown failure, which errorDiagnostic drops', () => {
    // As the Pi engine raises a failed request (`requestError`): the provider's text is the cause.
    const failure = normalizeProviderError(new Error('stream ended unexpectedly: upstream said no'), 'xai')
    expect(failure.code).toBe('provider_unknown')
    expect(JSON.stringify(errorDiagnostic(failure, 'orchestrator.chat'))).not.toContain('upstream said no')
    expect(errorCauseText(failure)).toBe('Error: stream ended unexpectedly: upstream said no')
  })

  it('walks the cause chain, bounded, and never repeats the public message', () => {
    const root = new Error('ECONNRESET at api.x.ai')
    const middle = new TypeError('terminated', { cause: root })
    const outer = new AppError({ code: 'provider_unknown', message: 'The provider request failed.', errorInfo: { category: 'internal', retryable: false } }, middle)
    expect(errorCauseText(outer)).toBe('TypeError: terminated <- Error: ECONNRESET at api.x.ai')
    const long = new AppError({ code: 'x', message: 'x', errorInfo: { category: 'internal', retryable: false } }, new Error('y'.repeat(5_000)))
    expect(errorCauseText(long)!.length).toBeLessThanOrEqual(420)
  })

  it('redacts keys and tokens', () => {
    const outer = new AppError({ code: 'provider_unknown', message: 'failed', errorInfo: { category: 'internal', retryable: false } },
      new Error(`Request failed for key ${key} with Authorization: Bearer abc.def and sk-live_123`))
    const text = errorCauseText(outer)!
    for (const secret of [key, 'abc.def', 'sk-live_123']) expect(text).not.toContain(secret)
    expect(text).toContain('Request failed for key')
  })

  it('is undefined without a cause, and survives cycles and odd causes', () => {
    expect(errorCauseText(new Error('alone'))).toBeUndefined()
    expect(errorCauseText('text')).toBeUndefined()
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(errorCauseText(new Error('top', { cause: a }))).toBe('Error: a <- Error: b')
    expect(errorCauseText(new Error('top', { cause: { message: 'plain object' } }))).toBe('Cause: plain object')
  })
})
