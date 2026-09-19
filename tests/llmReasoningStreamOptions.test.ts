import { describe, expect, it } from 'vitest'
import { getCacheSessionId, getReasoningStreamOptions } from '../src/mms/orchestrator/LlmClient'

describe('getReasoningStreamOptions', () => {
  it('requests a visible reasoning summary for ChatGPT subscription models', () => {
    expect(getReasoningStreamOptions('openai-codex-responses', 'medium')).toMatchObject({
      reasoningEffort: 'medium',
      reasoningSummary: 'auto'
    })
  })

  it('keeps Claude requests on its native thinking stream', () => {
    expect(getReasoningStreamOptions('anthropic-messages', 'high')).toEqual({
      reasoning: 'high',
      signal: undefined
    })
  })

  it('includes the thread cache affinity in provider stream options', () => {
    expect(getReasoningStreamOptions('anthropic-messages', 'high', undefined, 'cache-key')).toEqual({
      reasoning: 'high',
      signal: undefined,
      sessionId: 'cache-key'
    })
  })

  it('identifies OpenCode Go requests with the required stable session header', async () => {
    const options = getReasoningStreamOptions(
      'openai-responses',
      'off',
      undefined,
      'cache-key',
      'opencode-go'
    )
    expect(options.sessionId).toBe('cache-key')
    expect(await options.transformHeaders?.({ authorization: 'Bearer secret' })).toEqual({
      authorization: 'Bearer secret',
      'user-agent': 'mousse/0.1.1',
      'x-opencode-session': 'cache-key'
    })
  })

  it('does not add OpenCode headers to other providers', () => {
    expect(
      getReasoningStreamOptions('openai-responses', 'off', undefined, 'cache-key', 'openai')
    ).not.toHaveProperty('transformHeaders')
  })
})

describe('getCacheSessionId', () => {
  it('is deterministic, opaque, and isolated by thread', () => {
    const first = getCacheSessionId('thread-a')
    expect(first).toMatch(/^mousse-[a-f0-9]{48}$/)
    expect(getCacheSessionId('thread-a')).toBe(first)
    expect(getCacheSessionId('thread-b')).not.toBe(first)
    expect(getCacheSessionId('')).toBeUndefined()
  })
})
