import type { Message } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { LlmChatOptions, LlmChatResult } from '../../src/mms/orchestrator/LlmClient'
import { PiLoopAdapter, type PiChatClient } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type {
  AdapterHost,
  TurnControl,
  TurnInput,
  TurnSink
} from '../../src/mms/run/adapters/ProviderAdapter'

type ChatArgs = Parameters<PiChatClient['chat']>

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })

function chatResult(overrides: Partial<LlmChatResult> = {}): LlmChatResult {
  return {
    text: 'done',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    modelName: 'Probe Model',
    totalResponseTimeMs: 42,
    totalTokensUsed: 18,
    tokensPerSecond: 7,
    contextInputs: {
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'sig',
      modelKey: 'openai:gpt'
    },
    toolEvents: [],
    nativeMessages: [user('hi')],
    ...overrides
  }
}

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    threadId: 'thread-1',
    cwd: '/work',
    model: 'gpt',
    llmProvider: 'openai',
    modelPinned: true,
    mode: 'agent',
    prompt: 'hi',
    messages: [user('hi')],
    contextSummary: 'summary',
    appletInstructions: 'applets',
    signal: new AbortController().signal,
    ...overrides
  }
}

function recordingSink(): TurnSink & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, args.length > 1 ? args : args[0]])
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

function host(overrides: Partial<AdapterHost['context']> = {}): AdapterHost {
  return {
    tools: {
      onPublishApplet: () => ({ queued: true }),
      browser: undefined,
      delegation: undefined,
      toolAccess: { allows: () => true, execute: (_name, _args, run) => run() },
      toolLedger: { start: () => 'inv', commit: () => {}, failed: () => {} }
    },
    context: {
      toolLoopSafety: { compactionThresholdTokens: 1000, compactNativeMessages: (m) => m },
      recoverOverflow: () => null,
      prepareNativeContext: () => null,
      nativeHistoryAfterTurn: () => '',
      ...overrides
    }
  }
}

function control(steer?: string): TurnControl & { beats: number } {
  const ctl = {
    beats: 0,
    drainSteer: () => steer,
    heartbeat: () => {
      ctl.beats += 1
    }
  }
  return ctl
}

describe('PiLoopAdapter', () => {
  it('declares the pi loop capabilities', () => {
    const adapter = new PiLoopAdapter(() => ({ chat: async () => chatResult() }))
    expect(adapter.id).toBe('pi')
    expect(adapter.capabilities).toEqual({
      steer: 'native',
      interrupt: true,
      rollback: 'none',
      fork: 'portable',
      nativeSubagents: 'managed',
      events: 'rich',
      containment: 'strong',
      historyInjection: 'native',
      mcp: false
    })
  })

  it('builds the LlmClient options from the input, host and control', async () => {
    let seen: ChatArgs | undefined
    const turnHost = host()
    const adapter = new PiLoopAdapter(() => ({
      chat: async (...args: ChatArgs) => {
        seen = args
        return chatResult()
      }
    }))
    const turn = input()
    await adapter.startTurn(turn, recordingSink(), control('steer text'), turnHost)
    const [messages, , options] = seen!
    expect(messages).toBe(turn.messages)
    const opts = options as LlmChatOptions
    expect(opts).toMatchObject({
      mode: 'agent',
      appletInstructions: 'applets',
      llmProvider: 'openai',
      model: 'gpt',
      projectPath: '/work',
      threadId: 'thread-1',
      contextSummary: 'summary',
      signal: turn.signal
    })
    expect(opts.onPublishApplet).toBe(turnHost.tools.onPublishApplet)
    expect(opts.toolAccess).toBe(turnHost.tools.toolAccess)
    expect(opts.toolLedger).toBe(turnHost.tools.toolLedger)
    expect(opts.toolLoopSafety).toBe(turnHost.context.toolLoopSafety)
    expect(opts.drainSteer?.()).toBe('steer text')
  })

  it('leaves an unpinned model to the client and maps a null cwd to no project', async () => {
    let options: LlmChatOptions | undefined
    const adapter = new PiLoopAdapter(() => ({
      chat: async (...args: ChatArgs) => {
        options = args[2]
        return chatResult()
      }
    }))
    await adapter.startTurn(input({ modelPinned: false, cwd: null }), recordingSink(), control(), host())
    expect(options?.llmProvider).toBeUndefined()
    expect(options?.model).toBeUndefined()
    expect(options?.projectPath).toBeUndefined()
  })

  it('forwards every stream callback to the sink and heartbeats on each', async () => {
    const native = [user('hi'), user('more')]
    const adapter = new PiLoopAdapter(() => ({
      chat: async (_messages, onTool, options = {}, onThinking, onText) => {
        onText?.({ phase: 'start', content: '', contentIndex: 0 })
        onThinking?.({ phase: 'delta', content: 'hmm' })
        onTool?.({ kind: 'mcp_tool_call', phase: 'start', callId: 'c1', title: 't', summary: 's', details: [] })
        options.onNativeMessages?.(native)
        options.onCompaction?.('start')
        options.onRetry?.(2)
        options.onProviderProgress?.()
        return chatResult()
      }
    }))
    const sink = recordingSink()
    const ctl = control()
    await adapter.startTurn(input(), sink, ctl, host())
    expect(sink.calls.map(([name]) => name)).toEqual([
      'providerRef',
      'text',
      'thinking',
      'tool',
      'nativeMessages',
      'compaction',
      'retry',
      'progress'
    ])
    expect(sink.calls[0][1]).toEqual({ provider: 'openai', model: 'gpt' })
    expect(sink.calls[4][1]).toEqual([native, undefined])
    expect(sink.calls[6][1]).toBe(2)
    expect(ctl.beats).toBe(7)
    expect(sink.calls.some(([name]) => name === 'usage')).toBe(false)
  })

  it('maps the chat result to a TurnResult', async () => {
    const native = [user('hi'), user('reply')]
    const adapter = new PiLoopAdapter(() => ({
      chat: async () => chatResult({ nativeMessages: native })
    }))
    const result = await adapter.startTurn(input(), recordingSink(), control(), host())
    expect(result).toEqual({
      text: 'done',
      aborted: false,
      modelName: 'Probe Model',
      totalResponseTimeMs: 42,
      totalTokensUsed: 18,
      tokensPerSecond: 7,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      contextSignature: 'sig',
      contextModelKey: 'openai:gpt',
      nativeMessages: native,
      providerRef: { provider: 'openai', model: 'gpt' }
    })
  })

  it('reports an abort through the input signal', async () => {
    const abort = new AbortController()
    const adapter = new PiLoopAdapter(() => ({
      chat: (_messages, _onTool, options = {}) =>
        new Promise<LlmChatResult>((resolve) => {
          options.signal?.addEventListener('abort', () =>
            resolve(chatResult({ text: '', aborted: true }))
          )
        })
    }))
    const pending = adapter.startTurn(input({ signal: abort.signal }), recordingSink(), control(), host())
    abort.abort()
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.text).toBe('')
    await expect(adapter.interrupt({ provider: 'openai' })).resolves.toBe('not_active')
  })

  it('reads the client on every turn', async () => {
    let client: PiChatClient = { chat: async () => chatResult({ text: 'first' }) }
    const adapter = new PiLoopAdapter(() => client)
    expect((await adapter.startTurn(input(), recordingSink(), control(), host())).text).toBe('first')
    client = { chat: async () => chatResult({ text: 'second' }) }
    expect((await adapter.startTurn(input(), recordingSink(), control(), host())).text).toBe('second')
  })

  describe('context overflow', () => {
    const overflow = (): Error =>
      Object.assign(new Error('too long'), { code: 'provider_context_overflow' })

    it('retries once with the transcript the host compacted', async () => {
      const compacted = [user('compacted')]
      const seen: Array<{ messages: Message[]; summary?: string }> = []
      const adapter = new PiLoopAdapter(() => ({
        chat: async (messages, _onTool, options = {}) => {
          seen.push({ messages, summary: options.contextSummary })
          if (seen.length === 1) throw overflow()
          return chatResult()
        }
      }))
      const recoverOverflow = vi.fn(() => ({ messages: compacted, contextSummary: 'new summary', nativeHistory: '' }))
      const result = await adapter.startTurn(input(), recordingSink(), control(), host({ recoverOverflow }))
      expect(result.text).toBe('done')
      expect(recoverOverflow).toHaveBeenCalledTimes(1)
      expect(seen[1]).toEqual({ messages: compacted, summary: 'new summary' })
    })

    it('rethrows when the host cannot compact', async () => {
      const failure = overflow()
      const adapter = new PiLoopAdapter(() => ({
        chat: async () => {
          throw failure
        }
      }))
      await expect(
        adapter.startTurn(input(), recordingSink(), control(), host({ recoverOverflow: () => null }))
      ).rejects.toBe(failure)
    })

    it('does not replay a call that already made progress or ran a tool', async () => {
      for (const act of ['progress', 'tool'] as const) {
        const failure = overflow()
        const recoverOverflow = vi.fn(() => ({ messages: [], nativeHistory: '' }))
        const adapter = new PiLoopAdapter(() => ({
          chat: async (_messages, onTool, options = {}) => {
            if (act === 'progress') options.onProviderProgress?.()
            else onTool?.({ kind: 'mcp_tool_call', phase: 'start', callId: 'c', title: 't', summary: 's', details: [] })
            throw failure
          }
        }))
        await expect(
          adapter.startTurn(input(), recordingSink(), control(), host({ recoverOverflow }))
        ).rejects.toBe(failure)
        expect(recoverOverflow).not.toHaveBeenCalled()
      }
    })

    it('still retries after a skill load, which has no side effects', async () => {
      let calls = 0
      const adapter = new PiLoopAdapter(() => ({
        chat: async (_messages, onTool) => {
          calls += 1
          if (calls === 1) {
            onTool?.({ kind: 'skill_loaded', phase: 'complete', title: 'skill', summary: 's', details: [] })
            throw overflow()
          }
          return chatResult()
        }
      }))
      await adapter.startTurn(
        input(),
        recordingSink(),
        control(),
        host({ recoverOverflow: () => ({ messages: [], nativeHistory: '' }) })
      )
      expect(calls).toBe(2)
    })
  })
})
