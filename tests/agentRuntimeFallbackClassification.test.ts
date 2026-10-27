import { describe, expect, it } from 'vitest'
import { classifyProviderFailure } from '../src/mms/agentDefinitions/runtimeFallback'
import { normalizeProviderError, usageLimitError } from '../src/mms/orchestrator/providerErrors'

describe('fallback classification of usage limits', () => {
  it('reads a usage limit as a rate limit by its code, not its message', () => {
    expect(classifyProviderFailure(usageLimitError({ provider: 'codex', estimated: true }))).toBe('rate_limit')
    // The message names the window and the reset and contains neither "rate limit" nor "429".
    expect(usageLimitError({ provider: 'claude', limitKind: 'five_hour', estimated: true }).message).not.toMatch(/rate.?limit|429/i)
  })

  it('still reads a short rate limit and a quota failure as before', () => {
    expect(classifyProviderFailure(normalizeProviderError(Object.assign(new Error('429 too many requests'), { status: 429 }), 'anthropic'))).toBe('rate_limit')
    expect(classifyProviderFailure(normalizeProviderError(new Error('insufficient_quota: billing limit'), 'openai'))).toBe('unavailable')
  })

  it('reads the usage limits normalizeProviderError produces as rate limits', () => {
    expect(classifyProviderFailure(normalizeProviderError(new Error('You hit your ChatGPT usage limit'), 'openai-codex'))).toBe('rate_limit')
    const slow = Object.assign(new Error('429'), { status: 429, headers: new Headers({ 'retry-after': '3600' }) })
    expect(classifyProviderFailure(normalizeProviderError(slow, 'anthropic'))).toBe('rate_limit')
  })
})
