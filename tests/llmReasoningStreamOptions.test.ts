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
