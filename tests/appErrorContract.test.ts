import { describe, expect, it } from 'vitest'
import { AppError, createErrorProvider, normalizeAppError, parseErrorInfo, serializeAppError } from '../src/shared/errors'
import { parseEnvelope } from '../src/mms/protocol/validators'

describe('shared error public contract', () => {
  it('retains stable domain codes and catalog messages while keeping causes local', () => {
    const provider = createErrorProvider({ fixture_denied: { category: 'denied', retryable: false, message: 'Fixture access denied.' } })
    const cause = new Error('Bearer fixture-secret https://example.invalid/?api_key=private')
    const error = provider.create('fixture_denied', cause, { operationId: 'op-1', token: 'private' })
    expect(error).toBeInstanceOf(AppError)
    expect(error.cause).toBe(cause)
    expect(normalizeAppError(error)).toBe(error)
    expect(JSON.parse(JSON.stringify(serializeAppError(error)))).toEqual({
      code: 'fixture_denied', message: 'Fixture access denied.', details: { operationId: 'op-1' },
      errorInfo: { category: 'denied', retryable: false }
    })
  })

  it('replaces unknown SDK text and untrusted coded messages with a support reference', () => {
    for (const input of [new Error('sk-privateFixture /Users/private/path'), { code: 'invalid_request', message: 'private response body', errorInfo: { category: 'unavailable', retryable: true } }]) {
      const error = normalizeAppError(input)
      const dto = serializeAppError(error)
      expect(dto).toMatchObject({ code: 'internal_error', errorInfo: { category: 'internal', retryable: false } })
      expect(dto.message).toContain('Reference:')
      expect(dto.details).toMatchObject({ supportId: expect.any(String) })
      expect(JSON.stringify(dto)).not.toMatch(/privateFixture|private\/path|private response body/)
    }
  })

  it('gives cancellation precedence over timeout words', () => {
    expect(normalizeAppError(new DOMException('network timeout', 'AbortError'))).toMatchObject({
      code: 'cancelled', errorInfo: { category: 'cancelled', retryable: false }
    })
  })

  it('accepts legacy code/message/details without requiring classification', () => {
    expect(serializeAppError({ code: 'profile_not_found', message: 'Profile was not found.', details: { profileId: 'profile-1' } }))
      .toEqual({ code: 'profile_not_found', message: 'Profile was not found.', details: { profileId: 'profile-1' } })
  })

  it('round-trips additive classification through the actual response envelope parser', () => {
    const error = { code: 'provider_rate_limited', message: 'Please try later.', details: { status: 429 },
      errorInfo: { category: 'unavailable' as const, retryable: true, retryAfterMs: 2000 } }
    const response = { kind: 'res', id: 'fixture-request', ok: false, error }
    expect(parseEnvelope(JSON.parse(JSON.stringify(response)))).toEqual(response)
    const { errorInfo: _, ...legacy } = error
    const legacyResponse = { ...response, error: legacy }
    expect(parseEnvelope(legacyResponse)).toEqual(legacyResponse)
  })

  it('drops invalid additive classification without discarding a valid legacy error', () => {
    const error = { code: 'legacy_failure', message: 'Known failure.', errorInfo: { category: 'denied', retryable: 'yes' } }
    expect(parseEnvelope({ kind: 'res', id: 'fixture-request', ok: false, error })).toEqual({
      kind: 'res', id: 'fixture-request', ok: false, error: { code: 'legacy_failure', message: 'Known failure.' }
    })
  })

  it.each([undefined, null, [], {}, { category: 'unknown', retryable: true }, { category: 'internal', retryable: 'true' },
    { category: 'timeout', retryable: true, retryAfterMs: -1 }, { category: 'timeout', retryable: true, retryAfterMs: 10_001 },
    { category: 'timeout', retryable: true, retryAfterMs: Infinity }, { category: 'timeout', retryable: true, retryAfterMs: NaN }
  ])('rejects invalid error classification %j', (input) => {
    expect(parseErrorInfo(input)).toBeUndefined()
  })

  it('bounds valid retry-after and strips unrecognized metadata', () => {
    expect(parseErrorInfo({ category: 'unavailable', retryable: true, retryAfterMs: 10_000, bearer: 'private' }))
      .toEqual({ category: 'unavailable', retryable: true, retryAfterMs: 10_000 })
  })

  it('serializes cyclic and hostile details without invoking getters or carrying unsafe objects', () => {
    const details: Record<string, unknown> = { operation: 'fixture', headers: { Authorization: 'private' }, cause: new Error('private'), bad: Infinity }
    details.cycle = details
    Object.defineProperty(details, 'getter', { enumerable: true, get: () => { throw new Error('getter must not run') } })
    const dto = serializeAppError({ code: 'fixture', message: 'Safe message', details })
    expect(dto.details).toEqual({ operation: 'fixture' })
    expect(() => JSON.stringify(dto)).not.toThrow()
  })
})
