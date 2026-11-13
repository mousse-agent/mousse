import { describe, expect, it } from 'vitest'
import { harnessAppError } from '../src/shared/harness/types'
import { CodexTurnFailure } from '../src/mms/harness/vendors/codex/CodexProviderService'
import type { TurnError } from '../src/mms/harness/vendors/codex/protocol'
import { codexHarnessError, codexProviderError } from '../src/mms/harness/drivers/codex/adapter'

const failure = (error: Partial<TurnError>) => new CodexTurnFailure(error.message ?? 'failed', { message: 'failed', ...error })
/** How Codex 0.162.1 reports an HTTP failure (recorded by `codexManagedWire.test.ts`). */
const http = (httpStatusCode: number) => ({ httpConnectionFailed: { httpStatusCode } })

describe('codexHarnessError (managed Codex)', () => {
  it.each([
    ['usage limit kind', { codexErrorInfo: 'usageLimitExceeded' }, 'rate_limited'],
    ['HTTP 429', { codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } }, 'rate_limited'],
    ['unauthorized kind', { codexErrorInfo: 'unauthorized' }, 'auth_expired'],
    ['HTTP 401', { codexErrorInfo: { other: { httpStatusCode: 401 } } }, 'auth_expired'],
    ['HTTP 401 as Codex reports it', { codexErrorInfo: http(401) }, 'auth_expired'],
    ['overloaded kind', { codexErrorInfo: 'serverOverloaded' }, 'service_unavailable'],
    ['HTTP 503', { codexErrorInfo: { responseStreamFailed: { httpStatusCode: 503 } } }, 'provider_api_error'],
    ['HTTP 503 as Codex reports it', { codexErrorInfo: http(503) }, 'provider_api_error'],
    ['HTTP 403 (not eligible, unsupported capability)', { codexErrorInfo: http(403) }, 'provider_api_error'],
    ['bad request kind', { codexErrorInfo: 'badRequest' }, 'unsupported'],
    ['HTTP 400', { codexErrorInfo: http(400) }, 'provider_api_error'],
    ['a stream that failed after deltas', { codexErrorInfo: 'other' }, 'protocol'],
    ['the token helper failed', { codexErrorInfo: 'other', message: 'provider auth command `node` exited with status exit code: 1: Sign in again.' }, 'auth_expired'],
    ['anything else', { codexErrorInfo: 'internalServerError' }, 'protocol']
  ] as const)('%s', (_name, error, code) => {
    expect(codexHarnessError(failure(error as Partial<TurnError>), 'codex-2')).toMatchObject({ code })
  })

  it('marks service_unavailable retryable and not_eligible as denied', () => {
    expect(harnessAppError({ code: 'service_unavailable', message: 'x' }).errorInfo).toMatchObject({ category: 'unavailable', retryable: true })
    expect(harnessAppError({ code: 'not_eligible', message: 'x' }).errorInfo).toMatchObject({ category: 'denied', retryable: false })
  })

  it('never reads an upstream code from text', () => {
    const inText = failure({ additionalDetails: JSON.stringify({ error: { code: 'subscription_sharing_not_eligible' } }) })
    expect(codexHarnessError(inText)).toMatchObject({ code: 'protocol' })
  })

  it('shows the provider\'s status and message for a refusal, as Codex reports it', () => {
    const forbidden = failure({ message: 'unexpected status 403 Forbidden: This plan cannot use ChatGPT sign-in for this app., url: https://chatgpt.com/backend-api/codex/responses', codexErrorInfo: http(403) })
    expect(codexHarnessError(forbidden, 'codex-2')).toMatchObject({ code: 'provider_api_error', message: '403 · This plan cannot use ChatGPT sign-in for this app.', errorInfo: { category: 'denied', retryable: false } })
    const busy = failure({ message: 'unexpected status 503 Service Unavailable: The service is overloaded., url: https://chatgpt.com/backend-api/codex/responses', codexErrorInfo: http(503) })
    // A busy server stays one to try again.
    expect(codexHarnessError(busy)).toMatchObject({ message: '503 · The service is overloaded.', errorInfo: { category: 'unavailable', retryable: true } })
  })

  it('leaves a context overflow and other errors unchanged', () => {
    const overflow = failure({ codexErrorInfo: 'contextWindowExceeded', message: 'context window exceeded' })
    expect(codexHarnessError(overflow)).toBe(overflow)
    const plain = new Error('Codex app-server exited')
    expect(codexHarnessError(plain)).toBe(plain)
  })
})

describe('codexProviderError (any Codex)', () => {
  it('a provider 400 with a JSON body shows its status and message', () => {
    const error = codexProviderError(failure({ message: 'unexpected status 400 Bad Request: {"error":{"message":"Unsupported parameter: \'reasoning.summary\'","type":"invalid_request_error"}}, url: http://127.0.0.1:9841/v1/responses, request id: req_9', codexErrorInfo: http(400) }))
    expect(error).toMatchObject({ code: 'provider_api_error', message: "400 · Unsupported parameter: 'reasoning.summary'", errorInfo: { category: 'invalid', retryable: false }, details: { provider: 'codex', status: 400 } })
  })

  it('reads the status from the text when codexErrorInfo names none', () => {
    expect(codexProviderError(failure({ message: 'unexpected status 404 Not Found: model gpt-x does not exist', codexErrorInfo: null }))).toMatchObject({ message: '404 · model gpt-x does not exist' })
  })

  it('removes credentials and cuts a long message', () => {
    const error = codexProviderError(failure({ message: `unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-abcdefghijklmnop1234. ${'x'.repeat(900)}`, codexErrorInfo: http(401) }))!
    expect(error.message.startsWith('401 · Incorrect API key provided: [redacted]. x')).toBe(true)
    expect(error.message).not.toContain('sk-proj')
    expect(error.message.length).toBeLessThanOrEqual(506)
  })

  it('is undefined without an error status, and for a context overflow', () => {
    expect(codexProviderError(failure({ message: 'Upstream overloaded', codexErrorInfo: null }))).toBeUndefined()
    expect(codexProviderError(failure({ message: 'unexpected status 400 Bad Request: context window exceeded', codexErrorInfo: 'contextWindowExceeded' }))).toBeUndefined()
  })
})
