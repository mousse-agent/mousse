/**
 * SPEC §12.6: `LlmClient` writes the tool ledger around every tool it executes — `start` before
 * dispatch, then `commit` for a result or `failed` for a throw or an error result.
 */
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { LlmClient } from '../../src/mms/orchestrator/LlmClient'
import { userMessage } from '../../src/mms/orchestrator/nativeContext'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { getDefaultSettings } from '../../src/shared/settings'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function response(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'anthropic-model',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: emptyCost }
  } as AssistantMessage
}

async function runOneTool(executeTool: (call: ToolCall) => Promise<unknown>): Promise<string[]> {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
  const outputs = [
    response(
      [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
      'toolUse'
    ),
    response([{ type: 'text', text: 'done' }], 'stop')
  ]
  const models = {
    getModel: (provider: string, id: string) => ({
      id,
      name: id,
      api: 'anthropic-messages',
      provider,
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: emptyCost,
      contextWindow: 128_000,
      maxTokens: 8_000
    }),
    getAuth: async () => ({ apiKey: 'test' }),
    streamSimple: () => {
      const message = outputs.shift()!
      return { async *[Symbol.asyncIterator]() {}, result: async () => message }
    }
  }
  const client = new LlmClient(
    { get: () => settings } as never,
    { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
    { getEnabledTools: () => [] } as never
  )
  const calls: string[] = []
  const result = await client.chat([userMessage('run a tool')], undefined, {
    runtimeContext: {
      systemPrompt: 'test',
      tools: [
        {
          name: 'bash',
          description: 'shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } } as never
        }
      ],
      executeTool: async (call) => {
        calls.push(`execute:${call.name}`)
        return (await executeTool(call)) as never
      }
    },
    toolLedger: {
      start: (call) => {
        calls.push(`start:${call.name}:${JSON.stringify(call.arguments)}`)
        return 'inv-1'
      },
      commit: (id) => calls.push(`commit:${id}`),
      failed: (id) => calls.push(`failed:${id}`)
    }
  })
  expect(result.text).toBe('done')
  return calls
}

describe('LlmClient tool ledger', () => {
  it('starts the invocation before the tool runs and commits it after', async () => {
    const calls = await runOneTool(async (call) => ({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: Date.now()
    }))
    expect(calls).toEqual(['start:bash:{"command":"ls"}', 'execute:bash', 'commit:inv-1'])
  })

  it('marks a throwing tool failed', async () => {
    const calls = await runOneTool(async () => {
      throw new Error('boom')
    })
    expect(calls).toEqual(['start:bash:{"command":"ls"}', 'execute:bash', 'failed:inv-1'])
  })

  it('marks a tool that returns an error result failed, not committed', async () => {
    const calls = await runOneTool(async (call) => ({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: 'exit 1' }],
      isError: true,
      timestamp: Date.now()
    }))
    expect(calls).toEqual(['start:bash:{"command":"ls"}', 'execute:bash', 'failed:inv-1'])
  })

  it('writes one start and one commit per app tool call, and start + failed for an app tool error result', async () => {
    const settings = getDefaultSettings()
    settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
    const outputs = [
      response(
        [
          { type: 'toolCall', id: 'call-1', name: 'create_task', arguments: { description: 'one' } },
          { type: 'toolCall', id: 'call-2', name: 'create_task', arguments: { description: 'two' } },
          { type: 'toolCall', id: 'call-3', name: 'update_task', arguments: { id: '' } }
        ],
        'toolUse'
      ),
      response([{ type: 'text', text: 'done' }], 'stop')
    ]
    const models = {
      getModel: (provider: string, id: string) => ({
        id,
        name: id,
        api: 'anthropic-messages',
        provider,
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: emptyCost,
        contextWindow: 128_000,
        maxTokens: 8_000
      }),
      getAuth: async () => ({ apiKey: 'test' }),
      streamSimple: () => {
        const message = outputs.shift()!
        return { async *[Symbol.asyncIterator]() {}, result: async () => message }
      }
    }
    const tasks = new TaskQueue()
    const client = new LlmClient(
      { get: () => settings } as never,
      { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
      { getEnabledTools: async () => [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tasks
    )
    const calls: string[] = []
    let next = 0
    const result = await client.chat([userMessage('track tasks')], undefined, {
      mode: 'agent',
      threadId: 'thread-1',
      toolLedger: {
        start: (call) => {
          next += 1
          calls.push(`start:${call.name}:${call.id}`)
          return `inv-${next}`
        },
        commit: (id) => calls.push(`commit:${id}`),
        failed: (id) => calls.push(`failed:${id}`)
      }
    })
    expect(result.text).toBe('done')
    expect(tasks.list().map((task) => task.description)).toEqual(['one', 'two'])
    expect(calls).toEqual([
      'start:create_task:call-1',
      'commit:inv-1',
      'start:create_task:call-2',
      'commit:inv-2',
      'start:update_task:call-3',
      'failed:inv-3'
    ])
  })
})
