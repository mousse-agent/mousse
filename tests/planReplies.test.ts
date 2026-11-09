import { describe, expect, it } from 'vitest'
import { planReplyProblem, UsageProblemError, usageProblemOf } from '../src/mms/providers/planReplies'

/**
 * Why a provider's usage or plan reply has no numbers: no subscription only when the reply says so,
 * an expired or rejected sign-in or key when it says that, and nothing guessed otherwise.
 */

describe('planReplyProblem', () => {
  it('no subscription: a 402, or an error code that names it', () => {
    expect(planReplyProblem(402, undefined)).toBe('no_subscription')
    expect(planReplyProblem(403, { error: { code: 'no_subscription', type: 'permission_error' } })).toBe('no_subscription')
    expect(planReplyProblem(403, { error: 'subscription_required' })).toBe('no_subscription')
    expect(planReplyProblem(404, { code: 'plan_not_found' })).toBe('no_subscription')
    expect(planReplyProblem(403, { type: 'no_active_subscription' })).toBe('no_subscription')
  })

  it("an expired key, as OpenCode Go answers today (401, error.code api_key_expired)", () => {
    expect(planReplyProblem(401, { error: { type: 'authentication_error', code: 'api_key_expired', message: 'x' } })).toBe('key_expired')
  })

  it('a 401 is a sign-in that has to be redone: a key when the code says key, else the session', () => {
    expect(planReplyProblem(401, { error: { code: 'invalid_api_key' } })).toBe('key_rejected')
    expect(planReplyProblem(401, { error: 'invalid_token' })).toBe('session_expired')
    expect(planReplyProblem(401, undefined)).toBe('session_expired')
  })

  it('anything else is left undecided: a bare 403, a 500, insufficient quota, an odd body', () => {
    expect(planReplyProblem(403, undefined)).toBeUndefined()
    expect(planReplyProblem(500, { error: { code: 'internal' } })).toBeUndefined()
    expect(planReplyProblem(429, { error: { code: 'insufficient_quota' } })).toBeUndefined()
    expect(planReplyProblem(403, { error: { code: 'a very long sentence that is not a code' } })).toBeUndefined()
    expect(planReplyProblem(403, ['no_subscription'])).toBeUndefined()
  })
})

describe('usageProblemOf', () => {
  it("a reader's own failure keeps its kind; anything else is unavailable", () => {
    expect(usageProblemOf(new UsageProblemError('session_expired', 'Grok session expired.'))).toBe('session_expired')
    expect(usageProblemOf(new Error('fetch failed'))).toBe('unavailable')
    expect(usageProblemOf('nope')).toBe('unavailable')
  })
})
