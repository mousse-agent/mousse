import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Context, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { getDefaultSettings } from '../src/shared/settings'
import {
  LlmClient,
  ToolLoopSafetyError,
  DEFAULT_MAX_MODEL_CALLS,
  DEFAULT_MAX_PROCESSED_TOKENS,
  isToolLoopSafetyError,
  resolveToolLoopSafetyLimits
} from '../src/mms/orchestrator/LlmClient'
import {
  accumulateProviderUsage,
  applySafeBoundaryCompaction,
  assertToolLoopFinished,
  assertWithinProcessedTokenBudget,
  crossedBudgetFractions,
  emptyAccumulatedUsage,
  emitToolLoopBudgetWarnings
} from '../src/mms/orchestrator/toolLoopSafety'
import {
  compactMessagesAtSafeBoundary,
  estimateMessagesTokens,
  userMessage
} from '../src/mms/orchestrator/nativeContext'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function usage(totalTokens: number, output = 10): AssistantMessage['usage'] {
  return {
    input: Math.max(0, totalTokens - output),
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: emptyCost
  }
}

function response(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  totalTokens = 120
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: usage(totalTokens)
  } as AssistantMessage
}

function streamOf(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message
  }
}

function makeClient(outputs: AssistantMessage[], options?: { contextWindow?: number }) {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
  settings.integrations.skills.enabled = false
  const captured: Context[] = []
  const models = {
    getModel: (provider: string, id: string) => ({
      id,
      name: id,
      api: 'anthropic-messages',
      provider,
      baseUrl: '',
      reasoning: true,
      input: ['text'],
      cost: emptyCost,
      contextWindow: options?.contextWindow ?? 2_000_000,
      maxTokens: 8_000
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
    credentials: { listProviderIds: () => ['anthropic'] },
    models
  }
  const mcp = {
    getEnabledTools: async () => [
      {
        id: 'mcp',
        serverId: 'server',
        serverName: 'server',
        toolName: 'read',
        providerName: 'mcp_read',
        inputSchema: { type: 'object' }
      }
    ],
    callTool: async () => ({ text: 'tool-body', isError: false })
  }
  const client = new LlmClient(
    { get: () => settings } as never,
    providerAuth as never,
    mcp as never
  )
  return { client, captured, outputs }
}

function toolCallAssistant(id: string, totalTokens = 100): AssistantMessage {
  return response(
    [{ type: 'toolCall', id, name: 'mcp_read', arguments: { path: 'x' } }],
    'toolUse',
    totalTokens
  )
}

describe('tool-loop safety helpers', () => {
  it('uses absolute processed-token defaults that do not scale with contextWindow', () => {
    const limits = resolveToolLoopSafetyLimits()
    expect(limits.maxModelCalls).toBe(DEFAULT_MAX_MODEL_CALLS)
    expect(limits.maxProcessedTokens).toBe(DEFAULT_MAX_PROCESSED_TOKENS)
    // Large-context models must not automatically receive multi-million budgets.
    expect(limits.maxProcessedTokens).toBeLessThan(1_000_000)
  })

  it('throws a typed token_budget error with structuredClone-safe partial transcript', () => {
    const partial: Message[] = [
      userMessage('go'),
      response([{ type: 'text', text: 'partial' }], 'stop', 100)
    ]
    const usageAcc = accumulateProviderUsage(emptyAccumulatedUsage(), usage(600_000))
    expect(() =>
      assertWithinProcessedTokenBudget({
        modelCalls: 2,
        limits: { maxModelCalls: 24, maxProcessedTokens: 512_000 },
        accumulatedUsage: usageAcc,
        partialNativeMessages: partial
      })
    ).toThrow(ToolLoopSafetyError)

    try {
      assertWithinProcessedTokenBudget({
        modelCalls: 2,
        limits: { maxModelCalls: 24, maxProcessedTokens: 512_000 },
        accumulatedUsage: usageAcc,
        partialNativeMessages: partial
      })
    } catch (error) {
      expect(isToolLoopSafetyError(error)).toBe(true)
      const safety = error as ToolLoopSafetyError
      expect(safety.reason).toBe('token_budget')
      expect(safety.modelCalls).toBe(2)
      expect(safety.accumulatedUsage.processedTokens).toBe(600_000)
      expect(safety.budget.maxProcessedTokens).toBe(512_000)
      expect(safety.partialNativeMessages).toEqual(partial)
      expect(safety.partialNativeMessages).not.toBe(partial)
      expect(() => structuredClone(safety.partialNativeMessages)).not.toThrow()
      expect(safety.message).toContain('processed tokens')
    }
  })

  it('does not turn an unfinished tool loop into a successful Done response', () => {
    const limits = resolveToolLoopSafetyLimits({ maxModelCalls: 3 })
    expect(() =>
      assertToolLoopFinished({
        stopReason: 'toolUse',
        modelCalls: 3,
        limits,
        accumulatedUsage: emptyAccumulatedUsage(),
        partialNativeMessages: [userMessage('x')]
      })
    ).toThrow(ToolLoopSafetyError)
    expect(() =>
      assertToolLoopFinished({
        stopReason: 'stop',
        modelCalls: 1,
        limits,
        accumulatedUsage: emptyAccumulatedUsage(),
        partialNativeMessages: []
      })
    ).not.toThrow()
  })

  it('emits 50%/75% budget warnings once per crossed fraction', () => {
    const warnings: Array<{ kind: string; fraction: number }> = []
    const warnedKeys = new Set<string>()
    const limits = { maxModelCalls: 10, maxProcessedTokens: 1000 }
    emitToolLoopBudgetWarnings({
      previousUsage: { processedTokens: 400, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      currentUsage: { processedTokens: 800, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      previousModelCalls: 4,
      modelCalls: 8,
      limits,
      thresholds: [0.5, 0.75],
      warnedKeys,
      onBudgetWarning: (warning) => warnings.push({ kind: warning.kind, fraction: warning.fraction })
    })
    expect(warnings).toEqual(
      expect.arrayContaining([
        { kind: 'processed_tokens', fraction: 0.5 },
        { kind: 'processed_tokens', fraction: 0.75 },
        { kind: 'model_calls', fraction: 0.5 },
        { kind: 'model_calls', fraction: 0.75 }
      ])
    )
    // Second emission with same progress must not re-fire.
    emitToolLoopBudgetWarnings({
      previousUsage: { processedTokens: 800, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      currentUsage: { processedTokens: 900, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      previousModelCalls: 8,
      modelCalls: 9,
      limits,
      thresholds: [0.5, 0.75],
      warnedKeys,
      onBudgetWarning: (warning) => warnings.push({ kind: warning.kind, fraction: warning.fraction })
    })
    expect(warnings.filter((w) => w.fraction === 0.5)).toHaveLength(2) // one per kind
  })

  it('detects crossed fractions exclusive of previous and inclusive of current', () => {
    expect(crossedBudgetFractions(499, 500, 1000, [0.5, 0.75])).toEqual([0.5])
    expect(crossedBudgetFractions(500, 500, 1000, [0.5])).toEqual([])
    expect(crossedBudgetFractions(749, 800, 1000, [0.5, 0.75])).toEqual([0.75])
  })

  it('never mutates the source transcript when compaction fails', async () => {
    const messages: Message[] = [userMessage('keep me')]
    const original = structuredClone(messages)
    const result = await applySafeBoundaryCompaction(
      messages,
      {
        compactionThresholdTokens: 1,
        compactNativeMessages: async () => {
          throw new Error('compact failed')
        }
      },
      100
    )
    expect(result).toBe(messages)
    expect(messages).toEqual(original)
  })

  it('runs compaction only when threshold is met and preserves tool batches natively', async () => {
    const toolAssistant = toolCallAssistant('call-1')
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'mcp_read',
      content: [{ type: 'text', text: 'old '.repeat(400) }],
      isError: false,
      timestamp: 3
    }
    const messages: Message[] = [
      userMessage('history '.repeat(400)),
      toolAssistant,
      toolResult,
      userMessage('recent tail')
    ]
    let hookCalls = 0
    const compacted = await applySafeBoundaryCompaction(
      messages,
      {
        compactionThresholdTokens: 50,
        compactNativeMessages: async (clone) => {
          hookCalls += 1
          // Mutating the clone must not affect the source.
          clone.pop()
          return compactMessagesAtSafeBoundary(messages, 200)
        }
      },
      100
    )
    expect(hookCalls).toBe(1)
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user' })
    expect(compacted[0]).toMatchObject({ role: 'user' })
    expect(String((compacted[0] as { content: string }).content)).toContain('Compacted conversation summary')
    // Retained suffix must not start on an orphan toolResult.
    const firstRetained = compacted.find(
      (message, index) => index > 0 && message.role !== 'user'
    )
    expect(firstRetained?.role).not.toBe('toolResult')
    // Assistant/tool-result pair stays intact when both are retained.
    const assistantIndex = compacted.findIndex(
      (message) => message.role === 'assistant' && message.stopReason === 'toolUse'
    )
    if (assistantIndex >= 0) {
      expect(compacted[assistantIndex + 1]).toMatchObject({
        role: 'toolResult',
        toolCallId: 'call-1'
      })
    }
    expect(estimateMessagesTokens(compacted)).toBeLessThan(estimateMessagesTokens(messages))

    const skipped = await applySafeBoundaryCompaction(
      messages,
      {
        compactionThresholdTokens: 10_000,
        compactNativeMessages: async () => {
          hookCalls += 1
          return messages
        }
      },
      100
    )
    expect(hookCalls).toBe(1)
    expect(skipped).toBe(messages)
  })
})

describe('LlmClient tool-loop safety integration', () => {
  it('stops on override maxModelCalls and preserves assistant/tool-result pairs', async () => {
    const { client } = makeClient([
      toolCallAssistant('c1', 50),
      toolCallAssistant('c2', 50),
      toolCallAssistant('c3', 50),
      response([{ type: 'text', text: 'should not reach' }], 'stop', 50)
    ])
    const checkpoints: Message[][] = []
    let caught: ToolLoopSafetyError | null = null

    try {
      await client.chat([userMessage('loop')], undefined, {
        toolLoopSafety: {
          maxModelCalls: 2,
          maxProcessedTokens: 100_000
        },
        onNativeMessages: (messages) => {
          checkpoints.push(structuredClone(messages))
        }
      })
    } catch (error) {
      caught = error as ToolLoopSafetyError
    }

    expect(caught).toBeInstanceOf(ToolLoopSafetyError)
    expect(caught?.reason).toBe('model_calls')
    expect(caught?.modelCalls).toBe(2)
    expect(caught?.budget.maxModelCalls).toBe(2)
    const roles = caught?.partialNativeMessages.map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult'])
    // Each assistant tool call is paired with its tool result in the partial transcript.
    for (let i = 0; i < (caught?.partialNativeMessages.length ?? 0); i += 1) {
      const message = caught!.partialNativeMessages[i]
      if (message.role === 'assistant' && message.stopReason === 'toolUse') {
        const toolCall = message.content.find((block) => block.type === 'toolCall')
        const next = caught!.partialNativeMessages[i + 1]
        expect(next).toMatchObject({
          role: 'toolResult',
          toolCallId: toolCall && 'id' in toolCall ? toolCall.id : undefined
        })
      }
    }
    expect(checkpoints.length).toBeGreaterThan(0)
    const lastCheckpoint = checkpoints[checkpoints.length - 1]
    expect(lastCheckpoint.map((message) => message.role)).toEqual(
      caught?.partialNativeMessages.map((message) => message.role)
    )
  })

  it('enforces absolute processed-token budget even for huge contextWindow models', async () => {
    const { client } = makeClient(
      [
        toolCallAssistant('c1', 200_000),
        response([{ type: 'text', text: 'more' }], 'stop', 200_000)
      ],
      { contextWindow: 2_000_000 }
    )

    let caught: ToolLoopSafetyError | null = null
    try {
      await client.chat([userMessage('burn')], undefined, {
        toolLoopSafety: {
          maxModelCalls: 24,
          // Explicit absolute budget — not contextWindow * N.
          maxProcessedTokens: 250_000
        }
      })
    } catch (error) {
      caught = error as ToolLoopSafetyError
    }

    expect(caught).toBeInstanceOf(ToolLoopSafetyError)
    expect(caught?.reason).toBe('token_budget')
    expect(caught?.accumulatedUsage.processedTokens).toBe(400_000)
    expect(caught?.budget.maxProcessedTokens).toBe(250_000)
    // Partial work retained: first assistant + tool result are present even after budget stop.
    // Budget is checked after the second assistant is checkpointed, so that message is kept.
    const roles = caught?.partialNativeMessages.map((message) => message.role)
    expect(roles?.[0]).toBe('user')
    expect(roles).toContain('assistant')
    expect(roles).toContain('toolResult')
    expect(caught?.partialNativeMessages.some((message) => message.role === 'assistant')).toBe(true)
  })

  it('fires warning callbacks at configured fractions during the live loop', async () => {
    const warnings: Array<{ kind: string; fraction: number; current: number }> = []
    const { client } = makeClient([
      toolCallAssistant('c1', 100),
      response([{ type: 'text', text: 'done' }], 'stop', 60)
    ])

    const result = await client.chat([userMessage('warn')], undefined, {
      toolLoopSafety: {
        maxModelCalls: 4,
        maxProcessedTokens: 200,
        warningThresholds: [0.5, 0.75],
        onBudgetWarning: (warning) => {
          warnings.push({
            kind: warning.kind,
            fraction: warning.fraction,
            current: warning.current
          })
        }
      }
    })

    expect(result.text).toBe('done')
    expect(result.totalTokensUsed).toBe(160)
    expect(warnings.some((warning) => warning.kind === 'processed_tokens' && warning.fraction === 0.5)).toBe(
      true
    )
    expect(warnings.some((warning) => warning.kind === 'processed_tokens' && warning.fraction === 0.75)).toBe(
      true
    )
    expect(warnings.some((warning) => warning.kind === 'model_calls' && warning.fraction === 0.5)).toBe(true)
  })

  it('invokes safe-boundary compaction between tool batches before the next model request', async () => {
    const compact = vi.fn(async (messages: Message[]) => {
      // Ensure we only see complete batches (no trailing assistant without results).
      const last = messages[messages.length - 1]
      expect(last?.role).toBe('toolResult')
      return [
        userMessage('[Compacted conversation summary]\nGoal: continue'),
        ...messages.slice(-2)
      ]
    })

    const { client, captured } = makeClient([
      toolCallAssistant('c1', 80),
      response([{ type: 'text', text: 'after compact' }], 'stop', 40)
    ])

    const result = await client.chat([userMessage('compact me')], undefined, {
      toolLoopSafety: {
        maxModelCalls: 8,
        maxProcessedTokens: 10_000,
        compactionThresholdTokens: 50,
        compactNativeMessages: compact
      }
    })

    expect(compact).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('after compact')
    // Second model request must see the compacted transcript.
    expect(captured[1]?.messages[0]).toMatchObject({
      role: 'user'
    })
    expect(String((captured[1]?.messages[0] as { content: string }).content)).toContain(
      'Compacted conversation summary'
    )
    expect(captured[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult'
    ])
  })

  it('does not compact again until another full threshold interval is processed', async () => {
    const compact = vi.fn(async (messages: Message[]) => messages.slice(-3))
    const { client } = makeClient([
      toolCallAssistant('c1', 80),
      toolCallAssistant('c2', 10),
      response([{ type: 'text', text: 'done' }], 'stop', 10)
    ])

    const result = await client.chat([userMessage('compact once')], undefined, {
      toolLoopSafety: {
        maxModelCalls: 8,
        maxProcessedTokens: 10_000,
        compactionThresholdTokens: 50,
        compactNativeMessages: compact
      }
    })

    expect(result.text).toBe('done')
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('keeps the live transcript when the compaction hook throws', async () => {
    const { client, captured } = makeClient([
      toolCallAssistant('c1', 80),
      response([{ type: 'text', text: 'recovered' }], 'stop', 40)
    ])

    const result = await client.chat([userMessage('fail compact')], undefined, {
      toolLoopSafety: {
        maxModelCalls: 8,
        maxProcessedTokens: 10_000,
        compactionThresholdTokens: 1,
        compactNativeMessages: async () => {
          throw new Error('boom')
        }
      }
    })

    expect(result.text).toBe('recovered')
    expect(captured[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult'
    ])
  })

  it('labels totalTokensUsed as aggregate processed usage across model calls', async () => {
    const { client } = makeClient([
      toolCallAssistant('c1', 111),
      response([{ type: 'text', text: 'ok' }], 'stop', 222)
    ])
    const result = await client.chat([userMessage('sum')], undefined, {
      toolLoopSafety: { maxModelCalls: 8, maxProcessedTokens: 10_000 }
    })
    expect(result.totalTokensUsed).toBe(333)
    expect(result.usage.totalTokens).toBe(222)
  })
})
