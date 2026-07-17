import { describe, expect, it } from 'vitest'
import {
  canShowAssistantMessageActions,
  formatResponseTime,
  formatTokens,
  formatTokensPerSecond
} from '../src/renderer/utils/assistantMessageActions'

describe('assistant response actions', () => {
  it('only renders for completed ordinary assistant replies', () => {
    expect(canShowAssistantMessageActions({ role: 'assistant' })).toBe(true)
    expect(canShowAssistantMessageActions({ role: 'assistant', kind: 'plan_card' })).toBe(true)
    expect(canShowAssistantMessageActions({ role: 'assistant', streaming: true })).toBe(false)
    expect(canShowAssistantMessageActions({ role: 'assistant', incomplete: true })).toBe(false)
    expect(canShowAssistantMessageActions({ role: 'assistant', kind: 'thinking' })).toBe(false)
    expect(canShowAssistantMessageActions({ role: 'assistant', kind: 'tool_call' })).toBe(false)
    expect(canShowAssistantMessageActions({ role: 'system' })).toBe(false)
    expect(canShowAssistantMessageActions({ role: 'user' })).toBe(false)
  })

  it('formats present and missing persisted metadata safely', () => {
    expect(formatResponseTime(745)).toBe('745 ms')
    expect(formatResponseTime(2_400)).toBe('2.4 s')
    expect(formatResponseTime()).toBe('Unavailable')
    expect(formatTokens(12_345)).toBe('12,345')
    expect(formatTokens()).toBe('Unavailable')
    // TPS is measured by the LLM client from provider-reported output usage;
    // it must not be re-derived from total turn metadata in the renderer.
    expect(formatTokensPerSecond(617)).toBe('617')
    expect(formatTokensPerSecond(0.3)).toBe('0.3')
    expect(formatTokensPerSecond(Number.NaN)).toBe('Unavailable')
    expect(formatTokensPerSecond(-1)).toBe('Unavailable')
    expect(formatTokensPerSecond()).toBe('Unavailable')
  })
})
