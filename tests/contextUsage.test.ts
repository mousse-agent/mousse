import { describe, expect, it } from 'vitest'
import { computeContextUsage, contextBaseTokens, estimateTokens } from '../src/mms/orchestrator/contextUsage'
import { estimateMessage } from '../src/mms/orchestrator/contextEstimate'
import type { Message } from '../src/shared/transcript'

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
  it('keeps an unknown window at 0 instead of guessing a capacity', () => {
    const usage = computeContextUsage({ ...base, contextLimit: 0, lastMeasuredInput: 1_000, lastMeasuredCacheRead: 50_000 })
    expect(usage.used).toBe(51_000)
    expect(usage.limit).toBe(0)
    expect(usage.percent).toBe(0)
  })

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

describe('the size of the last request', () => {
  const reply = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'claude', model: 'opus',
    stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 })
  const messages: Message[] = [{ role: 'user', content: 'Hello, please reply briefly.', timestamp: 1 }, reply('A short reply.')]

  it('counts a cached request whole: read from the cache, written to it, and sent uncached', () => {
    // Claude's usage: input_tokens is only the uncached tail after the last cache breakpoint.
    const usage = computeContextUsage({ ...base, contextLimit: 1_000_000, messages, lastMeasuredInput: 864, lastMeasuredCacheRead: 41_000, lastMeasuredCacheWrite: 2_000, measuredAtMessageLength: 1 })
    expect(usage.source).toBe('measured')
    expect(usage.request).toEqual({ cached: 41_000, uncached: 2_864 })
    expect(usage.categories.slice(0, 3)).toEqual([
      expect.objectContaining({ label: 'Read from cache', tokens: 41_000 }),
      expect.objectContaining({ label: 'Written to cache', tokens: 2_000 }),
      expect.objectContaining({ label: 'Sent uncached', tokens: 864 })
    ])
    // The reply the next request carries comes on top, estimated.
    expect(usage.used).toBe(43_864 + estimateMessage(messages[1]!)[0])
  })

  it('does not count Codex\'s cached input twice', () => {
    // Codex reports input with the cached part inside it (1,200 with 800 cached); the runtime hands Mousse the split.
    const usage = computeContextUsage({ ...base, contextLimit: 272_000, lastMeasuredInput: 400, lastMeasuredCacheRead: 800, lastMeasuredCacheWrite: 0 })
    expect(usage.used).toBe(1_200)
    expect(usage.request).toEqual({ cached: 800, uncached: 400 })
  })

  it('takes a measurement that names the whole context (Pi) as it is', () => {
    const usage = computeContextUsage({ ...base, contextLimit: 200_000, lastMeasuredInput: 30_000, lastMeasuredCacheRead: 0, lastMeasuredCacheWrite: 0 })
    expect(usage.used).toBe(30_000)
    expect(usage.request).toEqual({ cached: 0, uncached: 30_000 })
  })

  it('keeps the system prompt, tools and instructions of the last request once the history moved on', () => {
    const measuredBase = contextBaseTokens(43_864, messages.slice(0, 1).map((message) => estimateMessage(message)))
    expect(measuredBase).toBe(43_864 - estimateMessage(messages[0]!)[1])
    const grown = [...messages, { role: 'user', content: 'Another question while the turn runs.', timestamp: 3 } as Message]
    const usage = computeContextUsage({ ...base, contextLimit: 1_000_000, messages: grown, baseTokens: measuredBase })
    expect(usage.source).toBe('estimated')
    expect(usage.request).toBeUndefined()
    expect(usage.categories[0]).toMatchObject({ label: 'System, tools & instructions', tokens: measuredBase })
    const messagesEstimate = grown.reduce((sum, message) => { const [, a, b, c, d] = estimateMessage(message); return sum + a + b + c + d }, 0)
    expect(usage.used).toBe(measuredBase + messagesEstimate)
    // Right after the measurement, base plus its messages is the measured size again.
    expect(computeContextUsage({ ...base, contextLimit: 1_000_000, messages: messages.slice(0, 1), baseTokens: measuredBase }).used).toBe(43_864)
  })

  it('ignores the base while a measurement fits the history', () => {
    const usage = computeContextUsage({ ...base, contextLimit: 1_000_000, messages, lastMeasuredInput: 864, lastMeasuredCacheRead: 41_000, lastMeasuredCacheWrite: 2_000, measuredAtMessageLength: 1, baseTokens: 40_000 })
    expect(usage.categories.some((category) => category.label === 'System, tools & instructions')).toBe(false)
  })

  it('never makes the base negative when the estimate overshoots a small request', () => {
    expect(contextBaseTokens(10, [[500, 500, 0, 0, 0]])).toBe(0)
  })
})
