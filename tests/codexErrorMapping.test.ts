import { describe, expect, it } from 'vitest'
import { harnessAppError } from '../src/shared/harness/types'
import { CodexTurnFailure } from '../src/mms/providers/codex/CodexProviderService'
import type { TurnError } from '../src/mms/providers/codex/protocol'
import { codexHarnessError } from '../src/mms/run/adapters/codex/CodexAdapter'

const failure = (error: Partial<TurnError>) => new CodexTurnFailure(error.message ?? 'failed', { message: 'failed', ...error })
const body = (code: string, param?: string) => JSON.stringify({ error: { code, message: 'x', ...(param ? { param } : {}) } })

describe('codexHarnessError (managed Codex)', () => {
  it.each([
    ['usage limit kind', { codexErrorInfo: 'usageLimitExceeded' }, 'rate_limited'],
    ['HTTP 429', { codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } }, 'rate_limited'],
    ['unauthorized kind', { codexErrorInfo: 'unauthorized' }, 'auth_expired'],
    ['HTTP 401', { codexErrorInfo: { other: { httpStatusCode: 401 } } }, 'auth_expired'],
    ['invalid user code', { additionalDetails: body('subscription_sharing_invalid_user') }, 'auth_expired'],
    ['overloaded kind', { codexErrorInfo: 'serverOverloaded' }, 'service_unavailable'],
    ['HTTP 503', { codexErrorInfo: { responseStreamFailed: { httpStatusCode: 503 } } }, 'service_unavailable'],
    ['not eligible code', { codexErrorInfo: { other: { httpStatusCode: 403 } }, additionalDetails: body('subscription_sharing_not_eligible') }, 'not_eligible'],
    ['client not enabled code', { additionalDetails: body('subscription_sharing_client_not_enabled') }, 'not_eligible'],
    ['unsupported capability code', { additionalDetails: body('subscription_sharing_unsupported_capability', 'tools[0].type') }, 'unsupported'],
    ['bad request kind', { codexErrorInfo: 'badRequest' }, 'unsupported'],
    ['anything else', { codexErrorInfo: 'internalServerError' }, 'protocol']
  ] as const)('%s', (_name, error, code) => {
    expect(codexHarnessError(failure(error as Partial<TurnError>), 'codex-2')).toMatchObject({ code })
  })

  it('marks service_unavailable retryable and not_eligible as denied', () => {
    expect(harnessAppError({ code: 'service_unavailable', message: 'x' }).errorInfo).toMatchObject({ category: 'unavailable', retryable: true })
    expect(harnessAppError({ code: 'not_eligible', message: 'x' }).errorInfo).toMatchObject({ category: 'denied', retryable: false })
  })

  it('reads an upstream code only as the exact error.code of a JSON body', () => {
    const inText = failure({ additionalDetails: 'upstream said subscription_sharing_not_eligible' })
    expect(codexHarnessError(inText)).toMatchObject({ code: 'protocol' })
    const unknownCode = failure({ additionalDetails: body('subscription_sharing_not_eligible_v2') })
    expect(codexHarnessError(unknownCode)).toMatchObject({ code: 'protocol' })
  })

  it('names a param only when it is a plain field path', () => {
    const named = codexHarnessError(failure({ additionalDetails: body('subscription_sharing_unsupported_capability', 'tools[0].type') })) as Error
    expect(named.message).toContain('(tools[0].type)')
    const odd = codexHarnessError(failure({ additionalDetails: body('subscription_sharing_unsupported_capability', 'x"; drop') })) as Error
    expect(odd.message).not.toContain('drop')
  })

  it('leaves a context overflow and other errors unchanged', () => {
    const overflow = failure({ codexErrorInfo: 'contextWindowExceeded', message: 'context window exceeded' })
    expect(codexHarnessError(overflow)).toBe(overflow)
    const plain = new Error('Codex app-server exited')
    expect(codexHarnessError(plain)).toBe(plain)
  })
})
