import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import { getDefaultSettings } from '../src/shared/settings'
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { accumulateProviderUsage, applySafeBoundaryCompaction, emptyAccumulatedUsage } from '../src/mms/orchestrator/toolLoopSafety'
import { userMessage } from '../src/mms/orchestrator/nativeContext'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], totalTokens = 120): AssistantMessage {
  return {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'test', content,
    stopReason, timestamp: Date.now(),
    usage: { input: Math.max(0, totalTokens - 10), output: 10, cacheRead: 0, cacheWrite: 0, totalTokens, cost: emptyCost }
  } as AssistantMessage
}
function toolCall(id: string, tokens = 100): AssistantMessage {
  return response([{ type: 'toolCall', id, name: 'mcp_read', arguments: { path: 'x' } }], 'toolUse', tokens)
}
function streamOf(message: AssistantMessage) {
  return { async *[Symbol.asyncIterator]() {}, result: async () => message }
}
function makeClient(outputs: AssistantMessage[]) {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'test' }
  settings.integrations.skills.enabled = false
  const captured: Context[] = []
  const models = {
    getModel: (provider: string, id: string) => ({ id, name: id, api: 'anthropic-messages', provider, baseUrl: '', reasoning: true, input: ['text'], cost: emptyCost, contextWindow: 2_000_000, maxTokens: 8_000 }),
    getAuth: async () => ({ apiKey: 'test' }),
    streamSimple: (_model: unknown, context: Context) => {
      captured.push(structuredClone(context))
      const next = outputs.shift()
      if (!next) throw new Error('unexpected model call')
      return streamOf(next)
    }
  }
  const providerAuth = { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models }
  const mcp = {
    getEnabledTools: async () => [{ id: 'mcp', serverId: 'server', serverName: 'server', toolName: 'read', providerName: 'mcp_read', inputSchema: { type: 'object' } }],
    callTool: async () => ({ text: 'tool-body', isError: false })
  }
  return { client: new LlmClient({ get: () => settings } as never, providerAuth as never, mcp as never), captured }
}

describe('long-running tool loops', () => {
  it('tracks aggregate usage without treating it as a lifetime budget', () => {
    const usage = { input: 500_000, output: 20_000, cacheRead: 0, cacheWrite: 0, totalTokens: 520_000, cost: emptyCost }
    expect(accumulateProviderUsage(emptyAccumulatedUsage(), usage).processedTokens).toBe(520_000)
  })

  it('counts provider-reported cache reads once as part of total usage', () => {
    const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: emptyCost }
    const accumulated = accumulateProviderUsage(emptyAccumulatedUsage(), usage)
    expect(accumulated).toMatchObject({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40, processedTokens: 460 })
  })

  it('continues beyond the former model-call and processed-token limits', async () => {
    const outputs = Array.from({ length: 25 }, (_, index) => toolCall(`c${index}`, 25_000))
    outputs.push(response([{ type: 'text', text: 'finished' }], 'stop', 25_000))
    const { client } = makeClient(outputs)
    const result = await client.chat([userMessage('keep going')])
    expect(result.text).toBe('finished')
    expect(result.totalTokensUsed).toBe(650_000)
    expect(result.nativeMessages.filter((message) => message.role === 'assistant')).toHaveLength(26)
  })

  it('still obeys explicit cancellation', async () => {
    const controller = new AbortController()
    const { client } = makeClient([toolCall('c1')])
    controller.abort()
    const result = await client.chat([userMessage('stop')], undefined, { signal: controller.signal })
    expect(result.aborted).toBe(true)
  })
})

describe('safe-boundary context compaction', () => {
  it('never mutates the source transcript when compaction fails', async () => {
    const messages: Message[] = [userMessage('keep me')]
    const original = structuredClone(messages)
    const result = await applySafeBoundaryCompaction(messages, {
      compactionThresholdTokens: 1,
      compactNativeMessages: async () => { throw new Error('failed') }
    }, 100)
    expect(result).toBe(messages)
    expect(messages).toEqual(original)
  })

  it('compacts between complete tool batches and waits another interval', async () => {
    const compact = vi.fn(async (messages: Message[]) => [userMessage('[Compacted conversation summary]'), ...messages.slice(-2)])
    const { client, captured } = makeClient([
      toolCall('c1', 80),
      toolCall('c2', 10),
      response([{ type: 'text', text: 'done' }], 'stop', 10)
    ])
    const result = await client.chat([userMessage('compact')], undefined, {
      toolLoopSafety: { compactionThresholdTokens: 50, compactNativeMessages: compact }
    })
    expect(result.text).toBe('done')
    expect(compact).toHaveBeenCalledTimes(1)
    expect(captured[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult'])
  })
})
