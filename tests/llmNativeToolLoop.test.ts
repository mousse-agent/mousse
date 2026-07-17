import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import { getDefaultSettings } from '../src/shared/settings'
import { LlmClient } from '../src/mms/orchestrator/LlmClient'
import { userMessage } from '../src/mms/orchestrator/nativeContext'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], provider = 'anthropic'): AssistantMessage {
  return {
    role: 'assistant', api: provider === 'openai' ? 'openai-completions' : 'anthropic-messages',
    provider, model: `${provider}-model`, content, stopReason, timestamp: Date.now(),
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: emptyCost }
  } as AssistantMessage
}

function streamOf(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message
  }
}

describe('LlmClient Pi-native tool replay', () => {
  it('replays complete assistant/tool results in continuation and later cross-provider turns', async () => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
    settings.integrations.skills.enabled = false
    const captured: Context[] = []
    const outputs = [
      response([
        { type: 'thinking', thinking: 'inspect first', thinkingSignature: 'sig-thinking' },
        { type: 'toolCall', id: 'call-1', name: 'mcp_read', arguments: { path: 'x' }, thoughtSignature: 'sig-call' }
      ], 'toolUse'),
      response([{ type: 'text', text: 'first answer' }], 'stop'),
      response([{ type: 'text', text: 'second answer' }], 'stop', 'openai')
    ]
    const models = {
      getModel: (provider: string, id: string) => ({
        id, name: id, api: provider === 'openai' ? 'openai-completions' : 'anthropic-messages',
        provider, baseUrl: '', reasoning: true, input: ['text'], cost: emptyCost,
        contextWindow: 128_000, maxTokens: 8_000
      }),
      getAuth: async () => ({ apiKey: 'test' }),
      streamSimple: (_model: unknown, context: Context) => {
        captured.push(structuredClone(context))
        const next = outputs.shift()
        if (!next) throw new Error('unexpected model call')
        return streamOf(next)
      }
    }
    const providerAuth = {
      has: () => true,
      credentials: { listProviderIds: () => ['anthropic', 'openai'] },
      models
    }
    const mcp = {
      getEnabledTools: async () => [{
        id: 'mcp', serverId: 'server', serverName: 'server', toolName: 'read',
        providerName: 'mcp_read', inputSchema: { type: 'object' }
      }],
      callTool: async () => ({ text: 'native tool result', isError: false })
    }
    const client = new LlmClient(
      { get: () => settings } as never,
      providerAuth as never,
      mcp as never
    )

    const first = await client.chat([userMessage('first turn')])
    expect(captured[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult'])
    expect((captured[1]?.messages[1] as AssistantMessage).content[0]).toMatchObject({
      type: 'thinking', thinkingSignature: 'sig-thinking'
    })
    expect(captured[1]?.messages[2]).toMatchObject({
      role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'native tool result' }]
    })

    const later: Message[] = [...first.nativeMessages, userMessage('second turn')]
    await client.chat(later, undefined, { llmProvider: 'openai', model: 'gpt-test' })
    expect(captured[2]?.messages).toEqual(later)
    expect((captured[2]?.messages[1] as AssistantMessage).provider).toBe('anthropic')
  })
})
