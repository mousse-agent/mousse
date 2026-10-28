import { describe, expect, it } from 'vitest'
import { harnessAppError } from '../src/shared/harness/types'
import { CodexTurnFailure } from '../src/mms/harness/vendors/codex/CodexProviderService'
import type { TurnError } from '../src/mms/harness/vendors/codex/protocol'
import { codexHarnessError } from '../src/mms/harness/drivers/codex/adapter'

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
    ['HTTP 503', { codexErrorInfo: { responseStreamFailed: { httpStatusCode: 503 } } }, 'service_unavailable'],
    ['HTTP 503 as Codex reports it', { codexErrorInfo: http(503) }, 'service_unavailable'],
    ['HTTP 403 (not eligible, unsupported capability)', { codexErrorInfo: http(403) }, 'not_eligible'],
    ['bad request kind', { codexErrorInfo: 'badRequest' }, 'unsupported'],
    ['HTTP 400', { codexErrorInfo: http(400) }, 'unsupported'],
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

  it('leaves a context overflow and other errors unchanged', () => {
    const overflow = failure({ codexErrorInfo: 'contextWindowExceeded', message: 'context window exceeded' })
    expect(codexHarnessError(overflow)).toBe(overflow)
    const plain = new Error('Codex app-server exited')
    expect(codexHarnessError(plain)).toBe(plain)
  })
})
