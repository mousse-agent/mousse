/**
 * When Mousse sends a failed turn again itself (`turnRetryDelay`): only a passing failure the runtime did not retry,
 * before anything of the turn happened, within the attempts and the deadline; the wait doubles to its cap and is
 * spread over its upper half.
 */
import { describe, expect, it } from 'vitest'
import { providerStatusError, usageLimitError } from '../src/mms/orchestrator/providerErrors'
import { TURN_RETRY, turnRetryDelay, withRetries, type TurnRetryFacts } from '../src/mms/orchestrator/turnRetry'
import { AppError } from '../src/shared/errors'
import { harnessAppError } from '../src/shared/harness/types'

const facts = (over: Partial<TurnRetryFacts> = {}): TurnRetryFacts => ({
  retries: 0, elapsedMs: 0, answered: false, toolStarted: false, steered: false, runtimeRetried: false, bot: false, ...over
})
const unreachable = providerStatusError(undefined, 'Connection refused (ECONNREFUSED)', { code: 'provider_unavailable', errorInfo: { category: 'unavailable', retryable: true } })
const timedOut = new AppError({ code: 'provider_timeout', message: 'timed out', errorInfo: { category: 'timeout', retryable: true } })
const half = () => 0.5

describe('when a failed turn is sent again', () => {
  it.each<[string, unknown, Partial<TurnRetryFacts>, boolean]>([
    ['an unreachable provider, before anything happened', unreachable, {}, true],
    ['a timeout, before anything happened', timedOut, {}, true],
    ['an agent that took the prompt and went silent', harnessAppError({ code: 'timeout', message: 'did not answer', promptTaken: true }), {}, false],
    ['after the provider answered', unreachable, { answered: true }, false],
    ['after a tool started', unreachable, { toolStarted: true }, false],
    ['after a steer went in', unreachable, { steered: true }, false],
    ['after the runtime retried itself', unreachable, { runtimeRetried: true }, false],
    ["a bot's turn", unreachable, { bot: true }, false],
    ['a refusal (400)', providerStatusError(400, 'bad request'), {}, false],
    ['a usage limit', usageLimitError({ provider: 'claude', estimated: true }), {}, false],
    ['an error Mousse made', new Error('internal'), {}, false],
    ['once the retries ran out', unreachable, { retries: TURN_RETRY.attempts }, false],
    ['once the wait would pass the deadline', unreachable, { elapsedMs: TURN_RETRY.deadlineMs - 500 }, false]
  ])('%s', (_name, error, over, retried) => {
    expect(turnRetryDelay(error, facts(over), half) !== undefined).toBe(retried)
  })

  it('doubles the wait up to its cap and spreads it over the upper half', () => {
    const waits = [0, 1, 2, 3].map((retries) => [turnRetryDelay(unreachable, facts({ retries }), () => 0), turnRetryDelay(unreachable, facts({ retries }), () => 1)])
    expect(waits).toEqual([[1_000, 2_000], [2_000, 4_000], [4_000, 8_000], [8_000, 16_000]])
    const capped = turnRetryDelay(unreachable, facts({ retries: 3 }), () => 1)!
    expect(capped).toBeLessThanOrEqual(TURN_RETRY.capMs)
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
