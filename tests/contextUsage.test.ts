import { describe, expect, it } from 'vitest'
import { computeContextUsage, estimateTokens } from '../src/mms/orchestrator/contextUsage'

const base = {
  history: [],
  draftInput: '',
  contextLimit: 128_000,
  modelName: 'test-model',
  lastMeasuredInput: null,
  lastMeasuredCacheRead: null,
  lastMeasuredCacheWrite: null,
  measuredAtHistoryLength: 0
}

describe('context usage dynamic inputs', () => {
  it('counts loaded skill instructions and MCP schemas in estimated context', () => {
    const systemPromptText = 'base prompt\n\n## Loaded Skill Instructions\n' + 'skill body '.repeat(80)
    const mcpToolsText = JSON.stringify([{ name: 'search', parameters: { query: 'string' } }])
    const usage = computeContextUsage({
      ...base,
      systemPromptText,
      mcpToolsText
    })

    expect(usage.used).toBe(estimateTokens(systemPromptText) + estimateTokens(mcpToolsText))
    expect(usage.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'System prompt & skills' }),
      expect.objectContaining({ label: 'MCP tools', tokens: estimateTokens(mcpToolsText) })
    ]))
  })

  it('does not double-count tool schemas already included in provider measurements', () => {
    const usage = computeContextUsage({
      ...base,
      lastMeasuredInput: 1_000,
      lastMeasuredCacheRead: 2_000,
      lastMeasuredCacheWrite: 0,
      mcpToolsText: 'x'.repeat(4_000)
    })

    expect(usage.used).toBe(3_000)
    expect(usage.categories.some((category) => category.label === 'MCP tools')).toBe(false)
  })

  it('partitions native thinking, tool data, summary, schemas, and draft', () => {
    const usage = computeContextUsage({
      ...base,
      history: undefined,
      messages: [
        { role: 'user', content: '[Compacted conversation summary]\nGoal: ship it', timestamp: 1 },
        { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'x', timestamp: 2,
          content: [
            { type: 'thinking', thinking: 'reason carefully', thinkingSignature: 'sig' },
            { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'x' } }
          ], stopReason: 'toolUse',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
        { role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 3 }
      ],
      draftInput: 'next',
      mcpToolsText: 'mcp schema',
      otherToolsText: 'other schema'
    })
    expect(usage.categories.map((category) => category.label)).toEqual(expect.arrayContaining([
      'MCP tools', 'Other tools', 'Thinking', 'Tool calls & results', 'Compaction summary', 'Draft message'
    ]))
  })

  it('labels migrated history as a legacy estimate', () => {
    const usage = computeContextUsage({ ...base, legacyEstimated: true })
    expect(usage.source).toBe('legacy-estimated')
  })
})
