import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Message } from '@earendil-works/pi-ai'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { CursorAdapter, type CursorTurnClient } from '../../src/mms/harness/drivers/cursor/adapter'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { ClaudeSubscriptionChatInput } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { antigravityAdapter } from '../../src/mms/harness/drivers/antigravity'
import type { AcpTurnClient as AntigravityClient } from '../../src/mms/harness/drivers/acp/adapter'
import {
  ClaudeSubscriptionAdapter,
  type ClaudeSubscriptionClient
} from '../../src/mms/harness/drivers/claudeCode/adapter'
import { CodexAdapter, type CodexClient } from '../../src/mms/harness/drivers/codex/adapter'
import { ClaudeMetricsCollector } from '../../src/mms/harness/vendors/claude/metrics'
import { TurnFrames } from '../../src/mms/harness/vendors/claude/turnFrames'
import { transcriptSink } from '../support/transcriptSink'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/harness/adapter'

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    threadId: 'thread-1',
    cwd: '/work',
    instanceId: 'claude-subscription',
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
    status: record('status'),
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
    bridge: { mcp: null, turnToken: 'turn-1', sessionInstructions: 'SESSION', turnPreamble: 'PREAMBLE', userMcp: 'native' },
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
    expect(await adapter.stopThread('thread')).toBe('not_active')
    await expect(adapter.startTurn(input(), recordingSink(), control(), host())).rejects.toThrow(
      'claude-subscription requires a project workspace'
    )
  })

  it('Stop reaches the thread\'s Claude process through the service', async () => {
    const client = { ...claudeClient(async () => ''), stopThread: vi.fn(() => 'stopped' as const) }
    expect(await new ClaudeSubscriptionAdapter(() => client).stopThread('thread-1')).toBe('stopped')
    expect(client.stopThread).toHaveBeenCalledExactlyOnceWith('thread-1')
  })

  it('passes a provider\'s typed activity, update phase and parent call id through to the sink', async () => {
    const client = claudeClient(async (chat) => {
      chat.onTool?.({ phase: 'start', callId: 'toolu_1', title: 'Agent', toolName: 'Agent', activity: { kind: 'subagent', agentType: 'Explore' } })
      chat.onTool?.({
        phase: 'update',
        callId: 'toolu_2',
        title: 'Bash',
        parentCallId: 'toolu_1',
        activity: { kind: 'command', output: 'partial\n' }
      })
      chat.onTool?.({
        phase: 'complete',
        callId: 'toolu_2',
        title: 'Bash',
        parentCallId: 'toolu_1',
        activity: { status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' }
      })
      return 'done'
    })
    const sink = recordingSink()
    await new ClaudeSubscriptionAdapter(() => client).startTurn(input(), sink, control(), host())
    const events = sink.calls.filter(([name]) => name === 'tool').map(([, event]) => event)
    expect(events).toEqual([
      expect.objectContaining({ phase: 'start', callId: 'toolu_1', activity: { toolName: 'Agent', kind: 'subagent', agentType: 'Explore' } }),
      expect.objectContaining({
        phase: 'update',
        callId: 'toolu_2',
        parentCallId: 'toolu_1',
        activity: { kind: 'command', output: 'partial\n' }
      }),
      expect.objectContaining({
        phase: 'complete',
        parentCallId: 'toolu_1',
        activity: { status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' }
      })
    ])
  })

  it('hands a steer the provider could not take back to the turn control, which queues it as the next turn', async () => {
    const returned: string[] = []
    const client = claudeClient(async (chat) => {
      chat.returnSteer?.('too late')
      return 'done'
    })
    await new ClaudeSubscriptionAdapter(() => client).startTurn(
      input(),
      recordingSink(),
      { ...control(), returnSteer: (text) => returned.push(text) },
      host()
    )
    expect(returned).toEqual(['too late'])
  })

  it('builds the chat input and relays the stream, steer, metrics and commit through the sink', async () => {
    const client = claudeClient(async (chat) => {
      chat.onThinking?.('Considering')
      chat.onText('Reading')
      chat.onText('Reading the file.')
      expect(chat.drainSteer?.()).toBe('steer text')
      chat.onSteer?.('steer text')
      chat.onTool?.({ phase: 'start', callId: 'tool-1', title: 'Read', toolName: 'Read' })
      // The runtime's thinking and text are cumulative; what follows the call is a thought and a reply row of its own.
      // The blank lines between blocks are the frames' own (`TurnFrames`), and say so.
      chat.onThinkingSeparator?.('Considering'.length, '\n\n')
      chat.onTextSeparator?.('Reading the file.'.length, '\n\n')
      chat.onThinking?.('Considering\n\nRead the file next')
      chat.onText('Reading the file.\n\nHello')
      chat.onLineEdits?.(3)
      chat.onMetrics?.({
        realModelName: 'claude-real',
        totalResponseTimeMs: 50,
        totalTokensUsed: 30,
        tokensPerSecond: 6,
        usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 5, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        context: { input: 10, cacheRead: 10, cacheWrite: 5, contextWindow: 200_000 },
        requests: 2
      })
      return 'Reading the file.\n\nHello'
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
      // The bridge's preamble and session text, never the pi loop's applet catalogue.
      turnPreamble: 'PREAMBLE',
      systemPromptAppend: 'SESSION',
      mcp: null
    })
    expect(chat).not.toHaveProperty('appletInstructions')
    const names = sink.calls.map(([name]) => name).filter((name) => name !== 'progress')
    expect(names).toEqual([
      'providerRef',
      'thinking',
      'thinking',
      // The reply starts: the thought before it is done.
      'thinking',
      'text',
      'text',
      'text',
      // The steer closes the reply row: the reply goes on below the steered message.
      'text',
      'steerAccepted',
      'tool',
      'thinking',
      'thinking',
      // The answer starts: the thought after the call is done too.
      'thinking',
      'text',
      'text',
      'lineEdits',
      'providerMetrics',
      'usage',
      'text'
    ])
    // The thought before the call closes when the call starts; the next one opens a row below it.
    expect(sink.calls.filter(([name]) => name === 'thinking').map(([, event]) => event)).toEqual([
      { phase: 'start', content: '' },
      { phase: 'delta', content: 'Considering' },
      { phase: 'complete', content: 'Considering' },
      { phase: 'start', content: '' },
      { phase: 'delta', content: 'Read the file next' },
      { phase: 'complete', content: 'Read the file next' }
    ])
    // The note before the call closes its reply row too; the answer after it gets a row of its own.
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => event)).toEqual([
      { phase: 'start', content: '', contentIndex: 0 },
      { phase: 'delta', content: 'Reading', contentIndex: 0 },
      { phase: 'delta', content: 'Reading the file.', contentIndex: 0 },
      { phase: 'complete', content: 'Reading the file.', contentIndex: 0 },
      { phase: 'start', content: '', contentIndex: 0 },
      { phase: 'delta', content: 'Hello', contentIndex: 0 },
      { phase: 'complete', content: 'Hello', contentIndex: 0 }
    ])
    expect(sink.calls.find(([name]) => name === 'tool')?.[1]).toEqual({
      kind: 'mcp_tool_call',
      phase: 'start',
      callId: 'tool-1',
      title: 'Read',
      summary: 'Read',
      details: [],
      activity: { toolName: 'Read' }
    })
    // One report for the turn's two requests (a tool round, then the answer).
    expect(sink.calls.find(([name]) => name === 'usage')?.[1]).toEqual({ input: 10, output: 5, cacheRead: 10, cacheWrite: 5, requests: 2 })
    // The turn's whole text is still the reply the run and the native history keep.
    expect(turnHost.committed).toEqual(['Reading the file.\n\nHello'])
    expect(client.commitConversation).toHaveBeenCalledWith('thread-1', 'history+Reading the file.\n\nHello')
    expect(result).toMatchObject({
      text: 'Reading the file.\n\nHello',
      aborted: false,
      modelName: 'claude-real',
      totalResponseTimeMs: 50,
      totalTokensUsed: 30,
      tokensPerSecond: 6,
      usage: { input: 10, output: 5, cacheRead: 10, cacheWrite: 5 },
      contextSignature: 'claude-subscription:sonnet',
      contextModelKey: 'claude-subscription:sonnet',
      nativeMessages: [],
      providerRef: { provider: 'claude-subscription', instanceId: 'claude-subscription', model: 'sonnet' }
    })
  })

  it('saves Claude\'s blocks as written: an empty thinking block or delta splits nothing, and only the frames\' blank lines go', async () => {
    const client = claudeClient(async (chat) => {
      // Claude Code's stream events through the real frame reader, as the service runs them (hand-authored events).
      const frames = new TurnFrames(chat, new ClaudeMetricsCollector())
      const stream = (event: Record<string, unknown>) => frames.observe({ type: 'stream_event', parent_tool_use_id: null, session_id: 's1', event } as unknown as SDKMessage)
      const block = (type: string, extra: Record<string, unknown> = {}) => stream({ type: 'content_block_start', index: 0, content_block: { type, ...extra } })
      const thinking = (value: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: value } })
      const text = (value: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } })
      stream({ type: 'message_start', message: { id: 'm1' } })
      block('thinking', { thinking: '' })
      thinking('First')
      // A thinking block whose text is omitted: an empty delta, and no paragraph of its own.
      block('thinking', { thinking: '' })
      thinking('')
      block('thinking', { thinking: '' })
      thinking('Second')
      block('text', { text: '' })
      // An empty text delta does not end the thought; the first words do.
      text('')
      expect(frames.text).toBe('')
      text('Note')
      block('tool_use', { id: 'read', name: 'Read', input: {} })
      block('thinking', { thinking: '' })
      thinking('Third')
      block('text', { text: '' })
      text('    indented')
      return frames.text
    })
    const transcript = transcriptSink()
    const result = await new ClaudeSubscriptionAdapter(() => client).startTurn(input(), transcript.sink, control(), host())
    expect(result.text).toBe('Note\n\n    indented')
    expect(transcript.rows()).toEqual([
      { kind: 'thinking', content: 'First\n\nSecond' },
      { kind: 'text', content: 'Note' },
      { kind: 'tool', content: 'Read' },
      { kind: 'thinking', content: 'Third' },
      { kind: 'text', content: '    indented' }
    ])
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

  describe('a stopped turn (issue #142)', () => {
    const stopped = () => {
      const stop = new AbortController()
      const client = { ...claudeClient(async () => { stop.abort(); throw new Error('aborted') }), commitInterrupted: vi.fn() }
      return { stop, client }
    }

    it('fingerprints the history as the stopped turn left it, so the next turn can resume the session', async () => {
      const { stop, client } = stopped()
      await expect(
        new ClaudeSubscriptionAdapter(() => client).startTurn(input({ signal: stop.signal }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history up to the stopped request' }))
      ).rejects.toThrow('aborted')
      expect(client.commitInterrupted).toHaveBeenCalledWith('thread-1', 'history up to the stopped request')
      expect(client.commitConversation).not.toHaveBeenCalled()
    })

    it('reports the history boundary of a turn that failed without being stopped, without fingerprinting it', async () => {
      const client = { ...claudeClient(async () => { throw new Error('boom') }), commitInterrupted: vi.fn(), commitFailed: vi.fn() }
      await expect(
        new ClaudeSubscriptionAdapter(() => client).startTurn(input(), recordingSink(), control(), host({ nativeHistoryNow: () => 'history' }))
      ).rejects.toThrow('boom')
      expect(client.commitInterrupted).not.toHaveBeenCalled()
      expect(client.commitFailed).toHaveBeenCalledExactlyOnceWith('thread-1', 'history')
    })

    it('cannot fingerprint without the host\'s history or the service\'s support, and still rethrows the stop', async () => {
      const { stop, client } = stopped()
      await expect(
        new ClaudeSubscriptionAdapter(() => client).startTurn(input({ signal: stop.signal }), recordingSink(), control(), host())
      ).rejects.toThrow('aborted')
      expect(client.commitInterrupted).not.toHaveBeenCalled()
      const plain = new AbortController()
      const bare = claudeClient(async () => { plain.abort(); throw new Error('aborted') })
      await expect(
        new ClaudeSubscriptionAdapter(() => bare).startTurn(input({ signal: plain.signal }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history' }))
      ).rejects.toThrow('aborted')
    })
  })
})

describe('CodexAdapter', () => {
  describe('a stopped turn (issue #142)', () => {
    const codexClient = (chat: () => Promise<never>) =>
      ({
        chat: vi.fn(chat),
        commitConversation: vi.fn(),
        standaloneWorkspace: vi.fn((threadId: string) => `/standalone/${threadId}`),
        configured: () => true,
        interrupt: vi.fn(),
        userSetup: vi.fn()
      }) as unknown as CodexClient
    const stopped = () => {
      const stop = new AbortController()
      const client = { ...codexClient(async () => { stop.abort(); throw new Error('aborted') }), commitInterrupted: vi.fn() }
      return { stop, client }
    }

    it('fingerprints the history as the stopped turn left it, so the next turn resumes the Codex thread', async () => {
      const { stop, client } = stopped()
      await expect(
        new CodexAdapter(() => client).startTurn(input({ llmProvider: 'codex', signal: stop.signal }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history up to the stopped request' }))
      ).rejects.toThrow('aborted')
      expect(client.commitInterrupted).toHaveBeenCalledExactlyOnceWith('thread-1', 'history up to the stopped request')
      expect(client.commitConversation).not.toHaveBeenCalled()
    })

    it('does not fingerprint a turn that failed without being stopped', async () => {
      const client = { ...codexClient(async () => { throw new Error('boom') }), commitInterrupted: vi.fn() }
      await expect(
        new CodexAdapter(() => client).startTurn(input({ llmProvider: 'codex' }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history' }))
      ).rejects.toThrow('boom')
      expect(client.commitInterrupted).not.toHaveBeenCalled()
    })

    it('cannot fingerprint without the host\'s history or the service\'s support, and still rethrows the stop', async () => {
      const { stop, client } = stopped()
      await expect(
        new CodexAdapter(() => client).startTurn(input({ llmProvider: 'codex', signal: stop.signal }), recordingSink(), control(), host())
      ).rejects.toThrow('aborted')
      expect(client.commitInterrupted).not.toHaveBeenCalled()
      const plain = new AbortController()
      const bare = codexClient(async () => { plain.abort(); throw new Error('aborted') })
      await expect(
        new CodexAdapter(() => bare).startTurn(input({ llmProvider: 'codex', signal: plain.signal }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history' }))
      ).rejects.toThrow('aborted')
    })
  })
})

describe('AntigravityAdapter', () => {
  function client(chat: AntigravityClient['chat']) {
    return { chat: vi.fn(chat), commitConversation: vi.fn(), configured: () => true } satisfies AntigravityClient
  }

  it('declares sparse events, publishes no context and refuses plan mode or a missing workspace', async () => {
    const service = client(async () => 'never')
    const adapter = antigravityAdapter(() => service)
    expect(adapter.driver).toBe('antigravity')
    expect(adapter.capabilities).toMatchObject({ steer: 'interrupt_restart', interrupt: true, events: 'sparse', historyInjection: 'prompt' })
    expect(adapter.describe('m')).toEqual({ contextUsage: 'none' })
    expect(adapter.configured()).toBe(true)
    const turn = { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm' }
    await expect(adapter.startTurn(input({ ...turn, mode: 'plan' }), recordingSink(), control(), host())).rejects.toThrow(
      'Use Antigravity’s /plan command in a chat turn'
    )
    await expect(adapter.startTurn(input({ ...turn, cwd: null }), recordingSink(), control(), host())).rejects.toThrow(
      'antigravity requires a project workspace'
    )
    expect(service.chat).not.toHaveBeenCalled()
  })

  it('uses the runtime standalone workspace when a thread has no project, and keeps the project cwd when one exists', async () => {
    const standaloneWorkspace = vi.fn((threadId: string) => `/standalone/${threadId}`)
    const service = { ...client(async () => 'ok'), standaloneWorkspace }
    const adapter = antigravityAdapter(() => service)
    const turn = { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm' }
    expect(adapter.standaloneWorkspace('thread-1')).toBe('/standalone/thread-1')
    await adapter.startTurn(input({ ...turn, cwd: null }), recordingSink(), control(), host())
    expect(service.chat.mock.calls[0][0].cwd).toBe('/standalone/thread-1')
    await adapter.startTurn(input({ ...turn, cwd: '/project' }), recordingSink(), control(), host())
    expect(service.chat.mock.calls[1][0].cwd).toBe('/project')
  })

  it('reports the history a failed or stopped turn left, so the next turn may resume the agent session', async () => {
    const turn = { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm' }
    const failing = { ...client(async () => { throw new Error('quota') }), commitInterrupted: vi.fn() }
    await expect(antigravityAdapter(() => failing).startTurn(input(turn), recordingSink(), control(), host({ nativeHistoryNow: () => 'history up to the failed request' }))).rejects.toThrow('quota')
    expect(failing.commitInterrupted).toHaveBeenCalledExactlyOnceWith('thread-1', 'history up to the failed request')
    expect(failing.commitConversation).not.toHaveBeenCalled()
    const stop = new AbortController()
    const stopped = { ...client(async () => { stop.abort(); throw new Error('aborted') }), commitInterrupted: vi.fn() }
    await expect(antigravityAdapter(() => stopped).startTurn(input({ ...turn, signal: stop.signal }), recordingSink(), control(), host({ nativeHistoryNow: () => 'history up to the stopped request' }))).rejects.toThrow('aborted')
    expect(stopped.commitInterrupted).toHaveBeenCalledExactlyOnceWith('thread-1', 'history up to the stopped request')
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
    const result = await antigravityAdapter(() => service).startTurn(
      input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm' }),
      sink,
      control(),
      turnHost
    )
    expect(service.chat.mock.calls[0][0]).toMatchObject({
      cwd: '/work',
      history: 'prior turns',
      turnPreamble: 'PREAMBLE',
      orchestrationInstructions: 'SESSION'
    })
    expect(sink.calls.some(([name]) => name === 'thinking' || name === 'providerMetrics')).toBe(false)
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => (event as { phase: string }).phase)).toEqual([
      'start',
      'delta',
      'delta',
      'complete'
    ])
    expect(service.commitConversation).toHaveBeenCalledWith('thread-1', 'history+ACP says hi')
    expect(result).toMatchObject({ text: 'ACP says hi', modelName: 'm', contextSignature: 'antigravity:m', nativeMessages: [], providerRef: { provider: 'antigravity', instanceId: 'antigravity', model: 'm' } })
    expect(sink.calls.find(([name]) => name === 'providerRef')?.[1]).toEqual({ provider: 'antigravity', instanceId: 'antigravity', model: 'm' })
    // An ACP tool call keeps its name for its generic item.
    expect(sink.calls.find(([name]) => name === 'tool')?.[1]).toMatchObject({
      phase: 'start',
      title: 'Antigravity subagent: Research',
      activity: { toolName: 'start_subagent' }
    })
    expect(result.totalTokensUsed).toBeUndefined()
    expect(typeof result.totalResponseTimeMs).toBe('number')
    // The subagent tool call never reached a completed update: the turn cannot be proven drained.
    expect(result.drain).toEqual({ toolCalls: 1, toolsSettled: false })
  })

  describe('how a tool call ended', () => {
    async function toolEvents(signal?: AbortSignal) {
      const service = client(async (chat) => {
        chat.onTool?.({ phase: 'start', callId: 'ok', title: 'Read a.ts', toolName: 'read' })
        chat.onTool?.({ phase: 'complete', callId: 'ok', title: 'Read a.ts', status: 'completed' })
        chat.onTool?.({ phase: 'start', callId: 'bad', title: 'Run tests', toolName: 'execute' })
        chat.onTool?.({ phase: 'complete', callId: 'bad', title: 'Run tests', status: 'failed' })
        chat.onTool?.({ phase: 'start', callId: 'open', title: 'Run build', toolName: 'execute' })
        chat.onTool?.({ phase: 'complete', callId: 'open', title: 'Run build', status: 'unfinished' })
        return 'done'
      })
      const sink = recordingSink()
      await antigravityAdapter(() => service).startTurn(
        input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm', ...(signal ? { signal } : {}) }),
        sink,
        control(),
        host()
      )
      return sink.calls.filter(([name]) => name === 'tool').map(([, event]) => event as { phase: string; callId: string; activity?: unknown })
    }
    const completes = (events: Awaited<ReturnType<typeof toolEvents>>) =>
      Object.fromEntries(events.filter((event) => event.phase === 'complete').map((event) => [event.callId, event.activity]))

    it('reports a call the settled turn ended before its result as interrupted, never done', async () => {
      expect(completes(await toolEvents())).toEqual({
        ok: undefined,
        bad: { status: 'failed' },
        open: { status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' }
      })
    })

    it('reports it as stopped when the turn was stopped', async () => {
      const stop = new AbortController()
      stop.abort()
      expect(completes(await toolEvents(stop.signal)).open).toEqual({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })
    })
  })

  it('reports tokens and output speed from ACP usage before committing canonical history', async () => {
    const order: string[] = []
    const service = client(async (chat) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      chat.onText('Gemini answer')
      chat.onUsage?.({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0, reasoning: 18, totalTokens: 10917, hasOutput: true })
      return 'Gemini answer'
    })
    const sink = recordingSink()
    const origMetrics = sink.providerMetrics
    sink.providerMetrics = (metrics) => {
      order.push('providerMetrics')
      origMetrics(metrics)
    }
    const turnHost = host()
    const origHistory = turnHost.context.nativeHistoryAfterTurn
    turnHost.context.nativeHistoryAfterTurn = (text) => {
      order.push('nativeHistoryAfterTurn')
      return origHistory(text)
    }
    const result = await antigravityAdapter(() => service).startTurn(
      input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'gemini-4-neon' }),
      sink,
      control(),
      turnHost
    )
    expect(order).toEqual(['providerMetrics', 'nativeHistoryAfterTurn'])
    expect(result.totalTokensUsed).toBe(10917)
    expect(result.tokensPerSecond).toBeGreaterThan(0)
    expect(result.usage).toEqual({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0 })
    expect(sink.calls.find(([name]) => name === 'usage')?.[1]).toEqual({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0 })
    expect(sink.calls.find(([name]) => name === 'providerMetrics')?.[1]).toMatchObject({
      totalTokensUsed: 10917,
      tokensPerSecond: result.tokensPerSecond,
      usage: { input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0, reasoning: 18, totalTokens: 10917 }
    })
  })

  it('omits tokensPerSecond when ACP usage reports only totalTokens without outputTokens', async () => {
    const service = client(async (chat) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      chat.onText('done')
      chat.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500, hasOutput: false })
      return 'done'
    })
    const sink = recordingSink()
    const result = await antigravityAdapter(() => service).startTurn(
      input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'gemini-4-neon' }),
      sink,
      control(),
      host()
    )
    expect(result.totalTokensUsed).toBe(500)
    expect(result.tokensPerSecond).toBeUndefined()
  })
})

/**
 * A turn is "Starting…" (`TurnState.step`) until its runtime reports something. Once the prompt reaches the agent, the
 * runtime is up and the model is next: "Thinking…" (`status('waiting')`). Antigravity sends nothing until its reply,
 * so without this the live row said "Starting…" all through a turn that was working.
 */
describe('an agent that got the prompt is no longer starting', () => {
  it('ACP: the session says so while the agent works on the prompt, before any output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-acp-started-'))
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const questions = new UserQuestionService()
    const sink = recordingSink()
    let seenWhileWorking: Array<[string, unknown]> = []
    const connect = vi.fn(() => {
      const abort = new AbortController()
      return {
        child: { exitCode: 0, signalCode: null, kill: () => true },
        connection: {
          signal: abort.signal,
          close: () => abort.abort(new Error('closed')),
          agent: {
            request: async (method: string) => {
              if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
              if (method === 'session/new')
                return { sessionId: 'acp-session', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }] }
              if (method === 'session/prompt') {
                // The agent works and reports nothing (no update) until its turn ends.
                seenWhileWorking = [...sink.calls]
                return { stopReason: 'end_turn' }
              }
              return {}
            },
            notify: async () => undefined
          }
        }
      }
    })
    const service = new AntigravityProviderService(home, home, questions, undefined, { connect: connect as never })
    Object.assign(service as unknown as Record<string, unknown>, { configured: () => true })
    try {
      await antigravityAdapter(() => service).startTurn(
        input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'm', cwd: workspace }),
        sink,
        control(),
        host()
      )
      expect(seenWhileWorking.filter(([name]) => name === 'status')).toEqual([['status', 'waiting']])
      expect(seenWhileWorking.some(([name]) => name === 'text' || name === 'progress')).toBe(false)
    } finally {
      service.stop()
      questions.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('AntigravityProviderService + AcpSessions + AcpAdapter carry PromptResponse.usage through to TurnResult', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-acp-usage-'))
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const questions = new UserQuestionService()
    const sink = recordingSink()
    const connect = vi.fn(() => {
      const abort = new AbortController()
      return {
        child: { exitCode: 0, signalCode: null, kill: () => true },
        connection: {
          signal: abort.signal,
          close: () => abort.abort(new Error('closed')),
          agent: {
            request: async (method: string) => {
              if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
              if (method === 'session/new')
                return { sessionId: 'acp-session', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }] }
              if (method === 'session/prompt') {
                await new Promise((resolve) => setTimeout(resolve, 20))
                return {
                  stopReason: 'end_turn',
                  usage: { inputTokens: 2145, outputTokens: 20, cachedReadTokens: 8752, cachedWriteTokens: 0, thoughtTokens: 18, totalTokens: 10917 }
                }
              }
              return {}
            },
            notify: async () => undefined
          }
        }
      }
    })
    const service = new AntigravityProviderService(home, home, questions, undefined, { connect: connect as never })
    Object.assign(service as unknown as Record<string, unknown>, { configured: () => true })
    try {
      const result = await antigravityAdapter(() => service).startTurn(
        input({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'gemini-4-neon', cwd: workspace }),
        sink,
        control(),
        host()
      )
      expect(result.totalTokensUsed).toBe(10917)
      expect(result.tokensPerSecond).toBeGreaterThan(0)
      expect(result.usage).toEqual({ input: 2145, output: 20, cacheRead: 8752, cacheWrite: 0 })
    } finally {
      service.stop()
      questions.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('Cursor: each run sent says so', async () => {
    const sink = recordingSink()
    let seenWhileWorking: Array<[string, unknown]> = []
    const client: CursorTurnClient = {
      chat: async (chat) => {
        chat.onProviderTurn?.()
        seenWhileWorking = [...sink.calls]
        return { text: '', interrupted: false }
      },
      commitConversation: () => {},
      configured: () => true,
      interrupt: async () => 'not_active'
    }
    await new CursorAdapter(() => client).startTurn(input({ instanceId: 'cursor', llmProvider: 'cursor', model: 'm' }), sink, control(), host())
    expect(seenWhileWorking.filter(([name]) => name === 'status')).toEqual([['status', 'waiting']])
  })
})
