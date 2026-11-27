/**
 * How Mousse goes on with a turn whose provider request failed (`turnRetryPlan`): which failures are the provider's and
 * retried, how (sent again before anything happened, continued on the runtime's kept session after), within one count
 * of ten per turn and a deadline on a run of failures; the wait doubles to its cap and is spread over its upper half.
 *
 * Inputs: the failure (a provider status of any kind, the #1999 opaque 400 as Codex reports it, a dropped connection, a
 * timeout, a runtime protocol error; a usage limit, a sign-in failure, a full context, a Stop, a silent agent, the
 * runtime's own retries ran out, Mousse's own refusals, a plain error); what the turn did (nothing, progressed with or
 * without a kept session); the runtime retried itself; a bot; the count; the deadline.
 */
import { describe, expect, it } from 'vitest'
import { codexHarnessError } from '../src/mms/harness/drivers/codex/adapter'
import { CodexTurnFailure } from '../src/mms/harness/vendors/codex/CodexProviderService'
import { appLimitError, providerErrors, providerStatusError, usageLimitError } from '../src/mms/orchestrator/providerErrors'
import { TURN_RETRY, turnRetryCause, turnRetryPlan, withRetries, type TurnRetryFacts } from '../src/mms/orchestrator/turnRetry'
import { AppError } from '../src/shared/errors'
import { harnessAppError } from '../src/shared/harness/types'

const facts = (over: Partial<TurnRetryFacts> = {}): TurnRetryFacts => ({
  retries: 0, failingMs: 0, progressed: false, sessionKept: false, runtimeRetried: false, bot: false, ...over
})
const unreachable = providerStatusError(undefined, 'Connection refused (ECONNREFUSED)', { code: 'provider_unavailable', errorInfo: { category: 'unavailable', retryable: true } })
const timedOut = new AppError({ code: 'provider_timeout', message: 'timed out', errorInfo: { category: 'timeout', retryable: true } })
/** Issue #1999: OpenAI's envelope with a bare "Bad Request", as Codex 0.162.1 reports it, mapped as a managed Codex maps it. */
const envelope400 = JSON.stringify({ error: { message: 'Bad Request', type: null, code: null, param: null }, status: 400 }, null, 2)
const opaque400 = codexHarnessError(new CodexTurnFailure(envelope400, { message: envelope400, codexErrorInfo: 'other' }), 'codex-2')
/** OpenAI's app limit as Codex 0.162.1 sent it: a dropped stream with no kind (`other`). */
const SHARING_LIMIT = 'stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.'
const sharingFailure = new CodexTurnFailure(SHARING_LIMIT, { message: SHARING_LIMIT, codexErrorInfo: 'other' })
/** As the Codex service reports it (`provider_app_limit`), and as a runtime's protocol error that carries the wording. */
const appLimit = codexHarnessError(appLimitError('codex', sharingFailure), 'codex-2')
const appLimitAsProtocol = harnessAppError({ code: 'protocol', message: `Codex ended the turn with an error: ${SHARING_LIMIT}` })
const half = () => 0.5
const how = (error: unknown, over: Partial<TurnRetryFacts> = {}) => turnRetryPlan(error, facts(over), half)?.how

describe('which failures go on, and how', () => {
  it.each<[string, unknown, Partial<TurnRetryFacts>, 'resend' | 'continue' | undefined]>([
    // The provider's failures, before anything happened: sent again.
    ['an opaque 400 (#1999), before anything happened', opaque400, {}, 'resend'],
    ['an unreachable provider', unreachable, {}, 'resend'],
    ['a timeout', timedOut, {}, 'resend'],
    ['a 503 the provider answered', providerStatusError(503, 'busy', { errorInfo: { category: 'unavailable', retryable: true } }), {}, 'resend'],
    ['a 403 (a block at the provider\'s edge)', providerStatusError(403, 'Attention Required'), {}, 'resend'],
    ['a refused request (provider_request_invalid)', providerStatusError(400, 'bad', { code: 'provider_request_invalid' }), {}, 'resend'],
    ['a provider rate limit that is not a plan limit', providerErrors.create('provider_rate_limited'), {}, 'resend'],
    ['a runtime\'s protocol error', harnessAppError({ code: 'protocol', message: 'Codex ended the turn with an error' }), {}, 'resend'],
    ['a busy service', harnessAppError({ code: 'service_unavailable', message: 'busy' }), {}, 'resend'],
    // After the turn got going: continued on a kept session, else final.
    ['the #1999 400 after a tool ran, session kept', opaque400, { progressed: true, sessionKept: true }, 'continue'],
    ['the #1999 400 after a tool ran, no session kept', opaque400, { progressed: true }, undefined],
    // Never retried here.
    ['a usage limit', usageLimitError({ provider: 'claude', estimated: true }), {}, undefined],
    ['a usage limit after a tool ran, session kept', usageLimitError({ provider: 'codex', estimated: true }), { progressed: true, sessionKept: true }, undefined],
    ['a managed Codex usage limit (rate_limited)', harnessAppError({ code: 'rate_limited', message: 'limit' }), {}, undefined],
    ['an app limit (provider_app_limit), before anything happened', appLimit, {}, undefined],
    ['an app limit, mid-turn with a kept session', appLimit, { progressed: true, sessionKept: true }, undefined],
    ['an app limit under a protocol error, before anything happened', appLimitAsProtocol, {}, undefined],
    ['an app limit under a protocol error, mid-turn with a kept session', appLimitAsProtocol, { progressed: true, sessionKept: true }, undefined],
    ['a quota or billing limit', providerErrors.create('provider_quota_exceeded'), {}, undefined],
    ['a sign-in the provider refused (401)', providerStatusError(401, 'unauthorized'), {}, undefined],
    ['an expired sign-in', harnessAppError({ code: 'auth_expired', message: 'sign in again' }), {}, undefined],
    ['a signed-out runtime', harnessAppError({ code: 'signed_out', message: 'signed out' }), {}, undefined],
    ['invalid credentials', providerErrors.create('provider_auth_invalid'), {}, undefined],
    ['a full context window', providerErrors.create('provider_context_overflow'), {}, undefined],
    ['a runtime\'s full context window', harnessAppError({ code: 'context_overflow', message: 'full' }), {}, undefined],
    ['a Stop', harnessAppError({ code: 'cancelled', message: 'stopped' }), {}, undefined],
    ['an agent that took the prompt and went silent', harnessAppError({ code: 'timeout', message: 'did not answer', promptTaken: true }), {}, undefined],
    ['a failure after the runtime\'s own retries ran out', harnessAppError({ code: 'service_unavailable', message: 'down', retriesExhausted: true }), {}, undefined],
    ['a policy Mousse cannot enforce', harnessAppError({ code: 'policy_unenforceable', message: 'no' }), {}, undefined],
    ['a permission mode the instance cannot enforce', harnessAppError({ code: 'permission_mode_unenforceable', message: 'no' }), {}, undefined],
    ['a runtime that is not installed', harnessAppError({ code: 'not_installed', message: 'missing' }), {}, undefined],
    ['an error Mousse made', new Error('internal'), {}, undefined],
    // What the runtime or the turn says.
    ['after the runtime retried itself', unreachable, { runtimeRetried: true }, undefined],
    ["a bot's turn", unreachable, { bot: true }, undefined],
    ['the tenth retry', unreachable, { retries: TURN_RETRY.attempts - 1 }, 'resend'],
    ['once the ten retries ran out', unreachable, { retries: TURN_RETRY.attempts }, undefined],
    ['once the ten retries ran out, mid-turn', opaque400, { retries: TURN_RETRY.attempts, progressed: true, sessionKept: true }, undefined],
    ['once the wait would pass the deadline', unreachable, { failingMs: TURN_RETRY.deadlineMs - 500 }, undefined]
  ])('%s', (_name, error, over, expected) => {
    expect(how(error, over)).toBe(expected)
  })

  it("reads the #1999 failure as the provider's 400, and the app limit as its own failure", () => {
    expect(opaque400).toMatchObject({ code: 'provider_api_error', details: { status: 400 } })
    expect(appLimit).toMatchObject({ code: 'provider_app_limit' })
  })

  it('doubles the wait up to its cap and spreads it over the upper half', () => {
    const waits = [0, 1, 2, 3, 4, 9].map((retries) => [0, 1].map((r) => turnRetryPlan(unreachable, facts({ retries }), () => r)!.delayMs))
    expect(waits).toEqual([[1_000, 2_000], [2_000, 4_000], [4_000, 8_000], [8_000, 16_000], [15_000, 30_000], [15_000, 30_000]])
  })

  it('fits ten retries at their longest waits within the deadline', () => {
    let failingMs = 0
    for (let retries = 0; retries < TURN_RETRY.attempts; retries += 1) {
      const plan = turnRetryPlan(opaque400, facts({ retries, failingMs, progressed: true, sessionKept: true }), () => 1)
      expect(plan).toMatchObject({ how: 'continue' })
      // Each failed request itself takes a while too.
      failingMs += plan!.delayMs + 20_000
    }
  })
})

describe('what the retry row says failed', () => {
  it.each([
    ['the #1999 400', opaque400, 'error 400'],
    ['a dropped connection', unreachable, 'connection error'],
    ['a timeout', timedOut, 'timed out'],
    ['a protocol error', harnessAppError({ code: 'protocol', message: 'x' }), 'provider error']
  ])('%s', (_name, error, cause) => {
    expect(turnRetryCause(error)).toBe(cause)
  })
})

describe("a turn's error with its retries", () => {
  it('adds the retries the row counted, and keeps the ones the runtime reported', () => {
    expect(withRetries({ code: 'provider_unavailable', message: 'x' }, { attempt: 3, max: 10 }).details).toEqual({ retries: { attempt: 3, max: 10 } })
    const reported = { code: 'provider_unavailable', message: 'x', details: { retries: { attempt: 5, max: 5 } } }
    expect(withRetries(reported, { attempt: 3, max: 10 })).toBe(reported)
    expect(withRetries(reported, undefined)).toBe(reported)
  })
})
