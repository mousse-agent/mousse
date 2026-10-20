import type { Message } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSubscriptionChatInput } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import {
  AntigravityAdapter,
  type AntigravityClient
} from '../../src/mms/run/adapters/antigravity/AntigravityAdapter'
import {
  ClaudeSubscriptionAdapter,
  type ClaudeSubscriptionClient
} from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { APPLET_GENERATION_GUIDANCE } from '../../src/shared/appletGuidance'

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    threadId: 'thread-1',
    cwd: '/work',
    model: 'sonnet',
    llmProvider: 'claude-subscription',
    modelPinned: false,
    mode: 'agent',
    prompt: 'hello',
    messages: [user('hello')],
    appletInstructions: '\ncatalogue',
    nativeHistory: 'prior turns',
    signal: new AbortController().signal,
    ...overrides
  }
}

function recordingSink(): TurnSink & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const record =
    (name: string) =>
    (value?: unknown): void => {
      calls.push([name, value])
    }
  return {
    calls,
    text: record('text'),
    thinking: record('thinking'),
    tool: record('tool'),
    nativeMessages: record('nativeMessages'),
    compaction: record('compaction'),
    retry: record('retry'),
    progress: record('progress'),
    usage: record('usage'),
    providerRef: record('providerRef'),
    steerAccepted: record('steerAccepted'),
    providerMetrics: record('providerMetrics'),
    lineEdits: record('lineEdits')
  }
}

function host(context: Partial<AdapterHost['context']> = {}): AdapterHost & { committed: string[] } {
  const committed: string[] = []
  return {
    committed,
    tools: {},
    context: {
      recoverOverflow: () => null,
      prepareNativeContext: () => null,
      nativeHistoryAfterTurn: (text) => {
        committed.push(text)
        return `history+${text}`
      },
      ...context
    }
  }
}

const control = (steer?: string): TurnControl => ({ drainSteer: () => steer, heartbeat: () => {} })

function claudeClient(chat: (input: ClaudeSubscriptionChatInput) => Promise<string>) {
  return {
    chat: vi.fn(chat),
    commitConversation: vi.fn(),
    standaloneWorkspace: vi.fn((threadId: string) => `/standalone/${threadId}`),
    configured: () => true
  } satisfies ClaudeSubscriptionClient
}

describe('ClaudeSubscriptionAdapter', () => {
  it('declares its capabilities, reports its context and stops through the signal', async () => {
    const adapter = new ClaudeSubscriptionAdapter(() => null)
    expect(adapter.driver).toBe('claude')
    expect(adapter.capabilities).toMatchObject({ steer: 'interrupt_restart', interrupt: true, containment: 'weak', historyInjection: 'prompt' })
    expect(adapter.describe('sonnet')).toEqual({ contextUsage: 'reported' })
    expect(adapter.configured()).toBe(false)
    expect(await adapter.interrupt({ provider: 'claude-subscription' })).toBe('not_active')
    await expect(adapter.startTurn(input(), recordingSink(), control(), host())).rejects.toThrow(
      'claude-subscription requires a project workspace'
    )
  })

  it('builds the chat input and relays the stream, steer, metrics and commit through the sink', async () => {
    const client = claudeClient(async (chat) => {
      chat.onThinking?.('Considering')
      chat.onText('Hel')
      expect(chat.drainSteer?.()).toBe('steer text')
      chat.onSteer?.('steer text')
      chat.onTool?.({ phase: 'start', callId: 'tool-1', title: 'Read', toolName: 'Read' })
      chat.onText('Hello')
      chat.onLineEdits?.(3)
      chat.onMetrics?.({
        realModelName: 'claude-real',
        totalResponseTimeMs: 50,
        totalTokensUsed: 30,
        tokensPerSecond: 6,
        usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 5, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        context: { input: 10, cacheRead: 10, cacheWrite: 5, contextWindow: 200_000 }
      })
      return 'Hello'
    })
    const sink = recordingSink()
    const turnHost = host({ prepareNativeContext: () => ({ messages: [], nativeHistory: 'compacted history' }) })
    const result = await new ClaudeSubscriptionAdapter(() => client).startTurn(
      input({ mode: 'plan', cwd: null }),
      sink,
      control('steer text'),
      turnHost
    )
    const chat = client.chat.mock.calls[0][0]
    expect(chat).toMatchObject({
      mode: 'plan',
      threadId: 'thread-1',
      cwd: '/standalone/thread-1',
      model: 'sonnet',
      prompt: 'hello',
      history: 'compacted history',
      appletInstructions: APPLET_GENERATION_GUIDANCE + '\ncatalogue'
    })
    const names = sink.calls.map(([name]) => name).filter((name) => name !== 'progress')
    expect(names).toEqual([
      'providerRef',
      'thinking',
      'thinking',
      'text',
      'text',
      'steerAccepted',
      'tool',
      'text',
      'lineEdits',
      'providerMetrics',
      'usage',
      'thinking',
      'text'
    ])
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => event)).toEqual([
      { phase: 'start', content: '', contentIndex: 0 },
      { phase: 'delta', content: 'Hel', contentIndex: 0 },
      { phase: 'delta', content: 'Hello', contentIndex: 0 },
      { phase: 'complete', content: 'Hello', contentIndex: 0 }
    ])
    expect(sink.calls.find(([name]) => name === 'tool')?.[1]).toEqual({
      kind: 'mcp_tool_call',
      phase: 'start',
      callId: 'tool-1',
      title: 'Read',
      summary: 'Read',
      details: []
    })
    expect(sink.calls.find(([name]) => name === 'usage')?.[1]).toEqual({ input: 10, output: 5, cacheRead: 10, cacheWrite: 5 })
    expect(turnHost.committed).toEqual(['Hello'])
    expect(client.commitConversation).toHaveBeenCalledWith('thread-1', 'history+Hello')
    expect(result).toMatchObject({
      text: 'Hello',
      aborted: false,
      modelName: 'claude-real',
      totalResponseTimeMs: 50,
      totalTokensUsed: 30,
      tokensPerSecond: 6,
      usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 5 },
      contextSignature: 'claude-subscription:sonnet',
      contextModelKey: 'claude-subscription:sonnet',
      nativeMessages: [],
      providerRef: { provider: 'claude-subscription', model: 'sonnet' }
    })
  })

  it('retries a context overflow once with the recovered history, only before progress', async () => {
    let calls = 0
    const quiet = claudeClient(async (chat) => {
      calls += 1
      if (calls === 1) throw new Error('maximum context exceeded')
      expect(chat.history).toBe('recovered history')
      return 'ok'
    })
    const recoverOverflow = vi.fn(() => ({ messages: [], nativeHistory: 'recovered history' }))
    await new ClaudeSubscriptionAdapter(() => quiet).startTurn(input(), recordingSink(), control(), host({ recoverOverflow }))
    expect(quiet.chat).toHaveBeenCalledTimes(2)
    expect(recoverOverflow).toHaveBeenCalledOnce()

    const streamed = claudeClient(async (chat) => {
      chat.onText('partial')
      throw new Error('maximum context exceeded')
    })
    const untouched = vi.fn(() => ({ messages: [], nativeHistory: '' }))
    await expect(
      new ClaudeSubscriptionAdapter(() => streamed).startTurn(input(), recordingSink(), control(), host({ recoverOverflow: untouched }))
    ).rejects.toThrow('maximum context exceeded')
    expect(streamed.chat).toHaveBeenCalledOnce()
    expect(untouched).not.toHaveBeenCalled()
  })
})

describe('AntigravityAdapter', () => {
  function client(chat: AntigravityClient['chat']) {
    return { chat: vi.fn(chat), commitConversation: vi.fn(), configured: () => true } satisfies AntigravityClient
  }

  it('declares sparse events, publishes no context and refuses plan mode or a missing workspace', async () => {
    const service = client(async () => 'never')
    const adapter = new AntigravityAdapter(() => service)
    expect(adapter.driver).toBe('antigravity')
    expect(adapter.capabilities).toMatchObject({ steer: 'interrupt_restart', interrupt: true, events: 'sparse', historyInjection: 'prompt' })
    expect(adapter.describe('m')).toEqual({ contextUsage: 'none' })
    expect(adapter.configured()).toBe(true)
    const turn = { llmProvider: 'antigravity', model: 'm' }
    await expect(adapter.startTurn(input({ ...turn, mode: 'plan' }), recordingSink(), control(), host())).rejects.toThrow(
      'Use Antigravity’s /plan command in a chat turn'
    )
    await expect(adapter.startTurn(input({ ...turn, cwd: null }), recordingSink(), control(), host())).rejects.toThrow(
      'antigravity requires a project workspace'
    )
    expect(service.chat).not.toHaveBeenCalled()
  })

  it('relays text and tools, commits the history and falls back to the selected model metadata', async () => {
    const service = client(async (chat) => {
      chat.onTool?.({ phase: 'start', callId: 'c', title: 'Antigravity subagent: Research', toolName: 'start_subagent' })
      chat.onText('ACP')
      chat.onText('ACP says hi')
      return 'ACP says hi'
    })
    const sink = recordingSink()
    const turnHost = host()
    const result = await new AntigravityAdapter(() => service).startTurn(
      input({ llmProvider: 'antigravity', model: 'm' }),
      sink,
      control(),
      turnHost
    )
    expect(service.chat.mock.calls[0][0]).toMatchObject({
      cwd: '/work',
      history: 'prior turns',
      appletInstructions: APPLET_GENERATION_GUIDANCE + '\ncatalogue'
    })
    expect(sink.calls.some(([name]) => name === 'thinking' || name === 'providerMetrics')).toBe(false)
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => (event as { phase: string }).phase)).toEqual([
      'start',
      'delta',
      'delta',
      'complete'
    ])
    expect(service.commitConversation).toHaveBeenCalledWith('thread-1', 'history+ACP says hi')
    expect(result).toMatchObject({ text: 'ACP says hi', modelName: 'm', contextSignature: 'antigravity:m', nativeMessages: [] })
    expect(result.totalTokensUsed).toBeUndefined()
    expect(typeof result.totalResponseTimeMs).toBe('number')
  })
})
