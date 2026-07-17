import { describe, expect, it } from 'vitest'
import { getReasoningStreamOptions } from '../src/mms/orchestrator/LlmClient'

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
})
