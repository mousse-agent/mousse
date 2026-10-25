import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { CodexAppServerExitedError } from '../../src/mms/providers/codex/CodexAppServerClient'
import {
  CodexAdapter,
  createCodexProviderService,
  type CodexProviderService
} from '../../src/mms/run/adapters/codex'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { mousseOrchestrationInstructions } from '../../src/mms/run/mcp/instructions'
import { CODEX_APP_SERVER_BOUNDARY, replayCodexAppServer } from '../../src/mms/run/testkit/codexAppServerReplay'
import { parseTranscript, ReplayTransport, type TranscriptFrame } from '../../src/mms/run/testkit/ReplayTransport'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../src/shared/types'
import { serializeAppError, type AppError } from '../../src/shared/errors'

// ----- transcript frames (codex app-server JSON-RPC lines) -----------------------------------

const T = 'thr-1'
const out = (frame: unknown): TranscriptFrame => ({ dir: 'out', frame })
const inn = (frame: unknown): TranscriptFrame => ({ dir: 'in', frame })
const cue = (frame: unknown): TranscriptFrame => ({ dir: 'cue', frame })
const note = (method: string, params: unknown): TranscriptFrame => inn({ method, params })
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const WORKSPACE_WRITE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }

function handshake(firstId = 1, probe = true): TranscriptFrame[] {
  return [
    out({ id: firstId, method: 'initialize', params: { clientInfo: { name: 'mousse', title: 'Mousse', version: '0.1.1' }, capabilities: { experimentalApi: false, requestAttestation: false } } }),
    inn({ id: firstId, result: { userAgent: 'replay', codexHome: '/home/replay/.codex', platformFamily: 'unix', platformOs: 'macos' } }),
    out({ method: 'initialized' }),
    ...(probe
      ? [
          out({ id: firstId + 1, method: 'account/read', params: { refreshToken: false } }),
          inn({ id: firstId + 1, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } })
        ]
      : [])
  ]
}

const threadParams = (extra: Record<string, unknown> = {}) => ({
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  model: 'gpt-x',
  modelProvider: 'openai',
  config: { model_provider: 'openai' },
  ...extra
})
const threadResult = (thread = T, modelProvider = 'openai') => ({ thread: { id: thread }, model: 'gpt-x', modelProvider, cwd: '/w' })

function threadStart(id: number, params = threadParams(), thread = T): TranscriptFrame[] {
  return [out({ id, method: 'thread/start', params }), inn({ id, result: threadResult(thread) })]
}

function turnStart(id: number, prompt: string, turn = 'turn-1', extra: Record<string, unknown> = {}): TranscriptFrame[] {
  return [
    out({ id, method: 'turn/start', params: { threadId: T, input: text(prompt), approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE_WRITE, model: 'gpt-x', ...extra } }),
    inn({ id, result: { turn: { id: turn, status: 'inProgress', error: null, items: [] } } }),
    note('turn/started', { threadId: T, turn: { id: turn, status: 'inProgress', error: null } })
  ]
}

function message(id: string, chunks: string[], turn = 'turn-1'): TranscriptFrame[] {
  return [
    note('item/started', { threadId: T, turnId: turn, item: { type: 'agentMessage', id, text: '' } }),
    ...chunks.map((delta) => note('item/agentMessage/delta', { threadId: T, turnId: turn, itemId: id, delta })),
    note('item/completed', { threadId: T, turnId: turn, item: { type: 'agentMessage', id, text: chunks.join('') } })
  ]
}

const completed = (status: string, turn = 'turn-1', error: unknown = null): TranscriptFrame =>
  note('turn/completed', { threadId: T, turn: { id: turn, status, error } })

function transport(frames: TranscriptFrame[], onCue?: (frame: unknown) => void | Promise<void>): ReplayTransport {
  const header = { kind: 'transcript', adapter: 'codex', scenario: 'unit', boundary: CODEX_APP_SERVER_BOUNDARY, recordedAt: 'hand-authored', version: 1 }
  return new ReplayTransport(parseTranscript([header, ...frames].map((line) => JSON.stringify(line)).join('\n')), { onCue, stallMs: 2_000 })
}

// ----- adapter harness -----------------------------------------------------------------------

let home: string
let work: string
let questions: UserQuestionService
const services: CodexProviderService[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-adapter-'))
  work = join(home, 'work')
  mkdirSync(work)
  questions = new UserQuestionService()
})
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  questions.shutdown()
  rmSync(home, { recursive: true, force: true })
})

const settingsPath = () => join(home, 'providers', 'codex', 'settings.json')

function service(replay: ReplayTransport, settings: Record<string, unknown> = {}): CodexProviderService {
  const binary = join(home, 'codex')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-x', label: 'GPT X' }], ...settings }))
  const created = createCodexProviderService(home, questions, { launch: replayCodexAppServer(replay) })
  services.push(created)
  return created
}

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    threadId: 'thread-1',
    cwd: work,
    instanceId: 'codex',
    model: 'gpt-x',
    llmProvider: 'codex',
    modelPinned: true,
    mode: 'agent',
    prompt: 'hello',
    messages: [],
    signal: new AbortController().signal,
    ...overrides
  }
}

function recordingSink(): TurnSink & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  const record = (name: string) => (value?: unknown) => void calls.push([name, value])
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

function host(mcp: AdapterHost['mcp'] = null): AdapterHost {
  return {
    tools: {},
    mcp,
    context: {
      recoverOverflow: () => null,
      prepareNativeContext: () => null,
      nativeHistoryAfterTurn: (reply) => `history+${reply}`
    }
  }
}

function control(steers: string[] = []): TurnControl {
  return { drainSteer: () => steers.shift(), heartbeat: () => {} }
}

/** Answers every question Mousse asks with `answer(request)`. */
function answerQuestions(answer: (request: PendingUserQuestions & { threadId: string }) => UserQuestionAnswers) {
  const asked: Array<PendingUserQuestions & { threadId: string }> = []
  questions.on('pending', (request: PendingUserQuestions & { threadId: string }) => {
    asked.push(request)
    questions.submitAnswers(request.requestId, answer(request))
  })
  return asked
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('CodexAdapter', () => {
  it('declares native steer and reports its context', async () => {
    const adapter = new CodexAdapter(() => null)
    expect(adapter.driver).toBe('codex')
    expect(adapter.capabilities).toEqual({
      steer: 'native',
      interrupt: true,
      rollback: 'none',
      fork: 'portable',
      events: 'rich',
      containment: 'weak',
      historyInjection: 'prompt',
      mcp: true,
      childPolicy: 'enforced'
    })
    expect(adapter.describe('gpt-x')).toEqual({ contextUsage: 'reported' })
    expect(adapter.configured()).toBe(false)
    expect(await adapter.interrupt({ provider: 'codex', sessionId: T })).toBe('not_active')
    expect(await adapter.forkSession({ provider: 'codex' }, 1)).toBeNull()
  })

  it('records a Mousse subagent call and its result on the tool events, and no other MCP call', async () => {
    const mcp = (id: string, server: string, tool: string, extra: Record<string, unknown>) => ({ type: 'mcpToolCall', id, server, tool, ...extra })
    const delegated = mcp('sub-1', 'mousse', 'delegate_task', { arguments: { title: 'API reviewer', prompt: 'SECRET PROMPT', workspace: 'shared' } })
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'hello'),
      note('item/started', { threadId: T, turnId: 'turn-1', item: { ...delegated, status: 'inProgress' } }),
      note('item/completed', {
        threadId: T,
        turnId: 'turn-1',
        item: { ...delegated, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ delegationId: 'd1', childThreadId: 't1', note: 'Started. LONG NOTE' }) }] } }
      }),
      note('item/started', { threadId: T, turnId: 'turn-1', item: mcp('other-1', 'tracker', 'delegate_task', { arguments: { title: 'x' }, status: 'inProgress' }) }),
      note('item/completed', { threadId: T, turnId: 'turn-1', item: mcp('other-1', 'tracker', 'delegate_task', { arguments: { title: 'x' }, status: 'completed' }) }),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const adapter = new CodexAdapter(() => service(replay))
    const sink = recordingSink()
    await adapter.startTurn(input(), sink, control(), host())
    replay.assertDone()
    const tools = sink.calls.filter(([name]) => name === 'tool').map(([, event]) => event as Record<string, unknown>)
    expect(tools[0]).toMatchObject({ phase: 'start', callId: 'sub-1', input: { title: 'API reviewer' } })
    expect(tools[0]).not.toHaveProperty('response')
    expect(tools[1]).toMatchObject({ phase: 'complete', callId: 'sub-1', input: { title: 'API reviewer' } })
    expect(JSON.parse(tools[1]!.response as string)).toEqual({ delegationId: 'd1', childThreadId: 't1' })
    expect(JSON.stringify(tools)).not.toMatch(/SECRET PROMPT|LONG NOTE/)
    for (const event of tools.slice(2)) {
      expect(event).not.toHaveProperty('input')
      expect(event).not.toHaveProperty('response')
    }
  })

  it('runs a turn: text, thinking, tools, edits, usage and the thread reference', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'hello'),
      note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'reasoning', id: 'r-1', summary: [], content: [] } }),
      note('item/reasoning/summaryTextDelta', { threadId: T, turnId: 'turn-1', itemId: 'r-1', delta: 'Thinking', summaryIndex: 0 }),
      note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', status: 'inProgress' } }),
      note('item/completed', { threadId: T, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', status: 'completed', exitCode: 0 } }),
      note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'fileChange', id: 'patch-1', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@\n-old\n+new\n+more' }], status: 'inProgress' } }),
      note('item/completed', { threadId: T, turnId: 'turn-1', item: { type: 'fileChange', id: 'patch-1', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@\n-old\n+new\n+more' }], status: 'completed' } }),
      ...message('msg-1', ['Hel', 'lo']),
      note('thread/tokenUsage/updated', {
        threadId: T,
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 1230, inputTokens: 1200, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 },
          last: { totalTokens: 1230, inputTokens: 1200, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 },
          modelContextWindow: 272000
        }
      }),
      completed('completed')
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    const sink = recordingSink()
    const result = await adapter.startTurn(input(), sink, control(), host())
    replay.assertDone()
    expect(result).toMatchObject({
      text: 'Hello',
      aborted: false,
      modelName: 'gpt-x',
      totalTokensUsed: 1230,
      usage: { input: 400, output: 30, cacheRead: 800, cacheWrite: 0 },
      contextSignature: 'codex:gpt-x',
      nativeMessages: [],
      providerRef: { provider: 'codex', instanceId: 'codex', model: 'gpt-x', sessionId: T, nativeTurnId: 'turn-1' }
    })
    const refs = sink.calls.filter(([name]) => name === 'providerRef').map(([, ref]) => ref)
    expect(refs).toEqual([
      { provider: 'codex', instanceId: 'codex', model: 'gpt-x' },
      { provider: 'codex', instanceId: 'codex', model: 'gpt-x', sessionId: T },
      { provider: 'codex', instanceId: 'codex', model: 'gpt-x', sessionId: T, nativeTurnId: 'turn-1' }
    ])
    const tools = sink.calls.filter(([name]) => name === 'tool').map(([, event]) => event)
    expect(tools).toEqual([
      { kind: 'mcp_tool_call', phase: 'start', callId: 'cmd-1', title: 'ls', summary: 'shell', details: [] },
      { kind: 'mcp_tool_call', phase: 'complete', callId: 'cmd-1', title: 'ls', summary: 'shell', details: [] },
      { kind: 'mcp_tool_call', phase: 'start', callId: 'patch-1', title: 'Edit a.ts', summary: 'apply_patch', details: [] },
      { kind: 'mcp_tool_call', phase: 'complete', callId: 'patch-1', title: 'Edit a.ts', summary: 'apply_patch', details: [] }
    ])
    expect(sink.calls.find(([name]) => name === 'lineEdits')?.[1]).toBe(3)
    expect(sink.calls.filter(([name]) => name === 'thinking').map(([, event]) => event)).toEqual([
      { phase: 'start', content: '' },
      { phase: 'delta', content: 'Thinking' },
      { phase: 'complete', content: 'Thinking' }
    ])
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => (event as { content: string }).content)).toEqual([
      '',
      'Hel',
      'Hello',
      'Hello'
    ])
    expect(sink.calls.find(([name]) => name === 'usage')?.[1]).toEqual({ input: 400, output: 30, cacheRead: 800, cacheWrite: 0 })
    expect(sink.calls.find(([name]) => name === 'providerMetrics')?.[1]).toMatchObject({
      totalTokensUsed: 1230,
      usage: { input: 400, output: 30, cacheRead: 800, cacheWrite: 0, reasoning: 10, totalTokens: 1230 },
      context: { input: 400, cacheRead: 800, cacheWrite: 0, contextWindow: 272000, modelName: 'gpt-x' }
    })
    // The turn committed: the Codex thread is saved with the canonical history it now holds.
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { threads: Record<string, unknown> }
    // Bound to the instance that started it (the default `codex` instance here).
    expect(saved.threads['thread-1']).toEqual({ codexThreadId: T, cwd: work, historyKey: sha('history+Hello'), instanceId: 'codex' })
  })

  it('continues the loaded thread, resumes it from a new process, and starts fresh when resume fails', async () => {
    // Same process: the committed thread is still loaded, so the turn starts directly.
    const first = transport([...handshake(), ...threadStart(3), ...turnStart(4, 'hello'), ...message('msg-1', ['one']), completed('completed'),
      ...turnStart(5, 'again', 'turn-2'), ...message('msg-2', ['two'], 'turn-2'), completed('completed', 'turn-2')])
    const codex = service(first)
    const adapter = new CodexAdapter(() => codex)
    await adapter.startTurn(input(), recordingSink(), control(), host())
    const second = await adapter.startTurn(input({ prompt: 'again', nativeHistory: 'history+one' }), recordingSink(), control(), host())
    first.assertDone()
    expect(second).toMatchObject({ text: 'two' })
    codex.stop()

    // New process: `thread/resume` with the saved id, no history preamble.
    const resumed = transport([
      ...handshake(),
      out({ id: 3, method: 'thread/resume', params: { threadId: T, excludeTurns: true, ...threadParams() } }),
      inn({ id: 3, result: threadResult() }),
      ...turnStart(4, 'third', 'turn-3'),
      ...message('msg-3', ['three'], 'turn-3'),
      completed('completed', 'turn-3')
    ])
    const reopened = createCodexProviderService(home, questions, { launch: replayCodexAppServer(resumed) })
    services.push(reopened)
    const third = await new CodexAdapter(() => reopened).startTurn(input({ prompt: 'third', nativeHistory: 'history+two' }), recordingSink(), control(), host())
    resumed.assertDone()
    expect(third).toMatchObject({ text: 'three', providerRef: { sessionId: T } })
    reopened.stop()

    // Resume fails: a fresh thread and the history as a preamble; the new thread replaces the saved one.
    const broken = transport([
      ...handshake(),
      out({ id: 3, method: 'thread/resume', params: { threadId: T, excludeTurns: true, ...threadParams() } }),
      inn({ id: 3, error: { code: -32600, message: `no rollout found for thread id ${T}` } }),
      out({ id: 4, method: 'thread/start', params: threadParams() }),
      inn({ id: 4, result: threadResult('thr-2') }),
      out({ id: 5, method: 'turn/start', params: { threadId: 'thr-2', input: text('Previous conversation (context only; do not repeat earlier actions):\nhistory+three\n\nCurrent request:\nfourth'), approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE_WRITE, model: 'gpt-x' } }),
      inn({ id: 5, result: { turn: { id: 'turn-4', status: 'inProgress', error: null } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-4', item: { type: 'agentMessage', id: 'msg-4', text: 'four' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-4', status: 'completed', error: null } })
    ])
    const recovering = createCodexProviderService(home, questions, { launch: replayCodexAppServer(broken) })
    services.push(recovering)
    const fourth = await new CodexAdapter(() => recovering).startTurn(input({ prompt: 'fourth', nativeHistory: 'history+three' }), recordingSink(), control(), host())
    broken.assertDone()
    expect(fourth).toMatchObject({ text: 'four', providerRef: { sessionId: 'thr-2', nativeTurnId: 'turn-4' } })
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { threads: Record<string, { codexThreadId: string }> }
    expect(saved.threads['thread-1'].codexThreadId).toBe('thr-2')
  })

  it('pins the ChatGPT provider and refuses a thread that resolves to another one', async () => {
    // A user or workspace config with a custom `model_provider` would change the effective
    // provider; the pin overrides it, and a thread that still reports another provider never runs.
    const replay = transport([...handshake(), out({ id: 3, method: 'thread/start', params: threadParams() }), inn({ id: 3, result: threadResult(T, 'custom') })])
    const codex = service(replay)
    await expect(new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host())).rejects.toMatchObject({
      code: 'codex_provider_not_chatgpt'
    })
    replay.assertDone()
  })

  it('never echoes the model provider the process reported in the refusal', async () => {
    const canary = 'C'.repeat(21) + '_-' + 'z'.repeat(20)
    const replay = transport([...handshake(), out({ id: 3, method: 'thread/start', params: threadParams() }), inn({ id: 3, result: threadResult(T, canary) })])
    const codex = service(replay)
    const error = await new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host()).catch((caught: unknown) => caught) as AppError
    expect(error).toMatchObject({ code: 'codex_provider_not_chatgpt' })
    expect(error.message).not.toContain(canary)
    expect(JSON.stringify(serializeAppError(error))).not.toContain(canary)
  })

  it('attaches the Mousse MCP server through thread config and developer instructions', async () => {
    const mcp = { url: 'http://127.0.0.1:4000/mcp', token: 'run-token' }
    const replay = transport([
      ...handshake(),
      ...threadStart(
        3,
        threadParams({
          config: {
            model_provider: 'openai',
            'mcp_servers.mousse.url': mcp.url,
            'mcp_servers.mousse.http_headers': { Authorization: 'Bearer run-token' },
            'mcp_servers.mousse.tool_timeout_sec': 3600,
            'mcp_servers.mousse.default_tools_approval_mode': 'approve'
          },
          developerInstructions: mousseOrchestrationInstructions()
        })
      ),
      ...turnStart(4, 'hello'),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const codex = service(replay)
    await new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host(mcp))
    replay.assertDone()
  })

  it('forks a loaded thread when its MCP attachment changes, so the new token takes effect', async () => {
    const mcpConfig = (token: string) => ({
      model_provider: 'openai',
      'mcp_servers.mousse.url': 'http://127.0.0.1:4000/mcp',
      'mcp_servers.mousse.http_headers': { Authorization: `Bearer ${token}` },
      'mcp_servers.mousse.tool_timeout_sec': 3600,
      'mcp_servers.mousse.default_tools_approval_mode': 'approve'
    })
    const developerInstructions = mousseOrchestrationInstructions()
    const replay = transport([
      ...handshake(),
      ...threadStart(3, threadParams({ config: mcpConfig('old'), developerInstructions })),
      ...turnStart(4, 'hello'),
      ...message('msg-1', ['one']),
      completed('completed'),
      // New token while the thread is still loaded: fork with the new config, release the old thread.
      out({ id: 5, method: 'thread/fork', params: { threadId: T, excludeTurns: true, ...threadParams({ config: mcpConfig('new'), developerInstructions }) } }),
      inn({ id: 5, result: threadResult('thr-2') }),
      out({ id: 6, method: 'thread/unsubscribe', params: { threadId: T } }),
      inn({ id: 6, result: { status: 'unsubscribed' } }),
      out({ id: 7, method: 'turn/start', params: { threadId: 'thr-2', input: text('again'), approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE_WRITE, model: 'gpt-x' } }),
      inn({ id: 7, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-2', item: { type: 'agentMessage', id: 'msg-2', text: 'two' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-2', status: 'completed', error: null } }),
      // Same token again: the forked thread is reused as loaded.
      out({ id: 8, method: 'turn/start', params: { threadId: 'thr-2', input: text('third'), approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE_WRITE, model: 'gpt-x' } }),
      inn({ id: 8, result: { turn: { id: 'turn-3', status: 'inProgress', error: null } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-3', item: { type: 'agentMessage', id: 'msg-3', text: 'three' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-3', status: 'completed', error: null } })
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    const attach = (token: string) => host({ url: 'http://127.0.0.1:4000/mcp', token })
    await adapter.startTurn(input(), recordingSink(), control(), attach('old'))
    const second = await adapter.startTurn(input({ prompt: 'again', nativeHistory: 'history+one' }), recordingSink(), control(), attach('new'))
    expect(second).toMatchObject({ text: 'two', providerRef: { sessionId: 'thr-2' } })
    await adapter.startTurn(input({ prompt: 'third', nativeHistory: 'history+two' }), recordingSink(), control(), attach('new'))
    replay.assertDone()
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { threads: Record<string, { codexThreadId: string }> }
    expect(saved.threads['thread-1'].codexThreadId).toBe('thr-2')
  })

  it('routes command, patch and user-input requests to Mousse questions', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'clean up'),
      inn({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 0, environmentId: null, command: 'rm -rf build', cwd: '/w', reason: null } }),
      out({ id: 'srv-1', result: { decision: 'accept' } }),
      note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'fileChange', id: 'patch-1', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '' }], status: 'inProgress' } }),
      inn({ id: 'srv-2', method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: 'patch-1', startedAtMs: 0, reason: 'needs write' } }),
      out({ id: 'srv-2', result: { decision: 'decline' } }),
      inn({ id: 'srv-3', method: 'item/tool/requestUserInput', params: { threadId: T, turnId: 'turn-1', itemId: 'ask-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'q1', header: 'Scope', question: 'Which module?', isOther: true, isSecret: false, options: [{ label: 'run', description: '' }, { label: 'agents', description: '' }] }] } }),
      out({ id: 'srv-3', result: { answers: { q1: { answers: ['agents'] } } } }),
      inn({ id: 'srv-4', method: 'item/tool/call', params: { threadId: T, turnId: 'turn-1', callId: 'c', tool: 'x', arguments: {} } }),
      out({ id: 'srv-4', error: { code: -32601, message: 'Mousse does not handle item/tool/call' } }),
      ...message('msg-1', ['Done']),
      completed('completed')
    ])
    const codex = service(replay)
    const asked = answerQuestions((request) => {
      const prompt = request.questions[0].prompt
      if (prompt.includes('rm -rf build')) return { permission: 'allow' }
      if (prompt.includes('src/a.ts')) return { permission: 'reject' }
      return { q1: 'agents' }
    })
    const result = await new CodexAdapter(() => codex).startTurn(input({ prompt: 'clean up' }), recordingSink(), control(), host())
    replay.assertDone()
    expect(result.text).toBe('Done')
    expect(asked.map((request) => request.threadId)).toEqual(['thread-1', 'thread-1', 'thread-1'])
    expect(asked[0].questions[0]).toMatchObject({ id: 'permission', prompt: 'Allow Codex to run this command?\nrm -rf build\nin /w' })
    expect(asked[1].questions[0].prompt).toBe('Allow Codex to edit src/a.ts?\nneeds write')
    expect(asked[2].questions).toEqual([
      { id: 'q1', prompt: 'Scope\nWhich module?', options: [{ id: 'run', label: 'run' }, { id: 'agents', label: 'agents' }] }
    ])
  })

  it('runs plan turns read-only and declines approvals without asking', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3, threadParams({ sandbox: 'read-only' })),
      ...turnStart(4, 'plan it', 'turn-1', { sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
      inn({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 0, environmentId: null, command: 'touch x' } }),
      out({ id: 'srv-1', result: { decision: 'decline' } }),
      ...message('msg-1', ['Plan']),
      completed('completed')
    ])
    const codex = service(replay)
    const asked = answerQuestions(() => ({ permission: 'allow' }))
    await new CodexAdapter(() => codex).startTurn(input({ prompt: 'plan it', mode: 'plan' }), recordingSink(), control(), host())
    replay.assertDone()
    expect(asked).toEqual([])
  })

  it('stops a turn with turn/interrupt and keeps routing it until the server settles it', async () => {
    const controller = new AbortController()
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(3),
        ...turnStart(4, 'hello'),
        note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: 'Part' }),
        cue({ action: 'stop' }),
        out({ id: 5, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
        inn({ id: 5, result: {} }),
        // Output the server flushes before it settles never reaches the finished turn.
        note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: ' late' }),
        completed('interrupted')
      ],
      () => controller.abort(new Error('stopped by the user'))
    )
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    const sink = recordingSink()
    await expect(adapter.startTurn(input({ signal: controller.signal }), sink, control(), host())).rejects.toThrow('stopped by the user')
    await replay.idle()
    replay.assertDone()
    expect(sink.calls.filter(([name]) => name === 'text').map(([, event]) => (event as { content: string }).content)).toEqual(['', 'Part'])
    await expect.poll(() => adapter.interrupt({ provider: 'codex', sessionId: T })).toBe('not_active')
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { threads: Record<string, { historyKey?: string }> }
    expect(saved.threads['thread-1'].historyKey).toBeUndefined()
  })

  it('interrupts a turn that was stopped before turn/start answered', async () => {
    const controller = new AbortController()
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(3),
        out({ id: 4, method: 'turn/start', params: { threadId: T, input: text('hello'), approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE_WRITE, model: 'gpt-x' } }),
        cue({ action: 'stop' }),
        inn({ id: 4, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }),
        out({ id: 5, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
        inn({ id: 5, result: {} }),
        completed('interrupted')
      ],
      () => controller.abort(new Error('stopped early'))
    )
    const codex = service(replay)
    await expect(new CodexAdapter(() => codex).startTurn(input({ signal: controller.signal }), recordingSink(), control(), host())).rejects.toThrow('stopped early')
    await replay.idle()
    replay.assertDone()
  })

  it('never starts a turn once Stop arrived right after the thread opened', async () => {
    const controller = new AbortController()
    const replay = transport([...handshake(), ...threadStart(3)])
    const codex = service(replay)
    const sink = recordingSink()
    // Stop lands when the thread is known but before turn/start is sent.
    const providerRef = sink.providerRef
    sink.providerRef = (ref) => {
      providerRef(ref)
      if (ref.sessionId && !ref.nativeTurnId) controller.abort(new Error('stopped after thread/start'))
    }
    await expect(new CodexAdapter(() => codex).startTurn(input({ signal: controller.signal }), sink, control(), host())).rejects.toThrow(
      'stopped after thread/start'
    )
    await replay.idle()
    replay.assertDone()
  })

  it('steers the running turn natively, and starts a follow-up turn for a steer that arrives too late', async () => {
    const steers: string[] = []
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(3),
        ...turnStart(4, 'hello'),
        ...message('msg-1', ['Working']),
        cue({ steer: 'Focus on tests' }),
        out({ id: 5, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('Focus on tests') } }),
        inn({ id: 5, result: { turnId: 'turn-1' } }),
        ...message('msg-2', ['Tests pass']),
        cue({ steer: 'And lint' }),
        out({ id: 6, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('And lint') } }),
        completed('completed'),
        inn({ id: 6, error: { code: -32600, message: 'no active turn to steer' } }),
        ...turnStart(7, 'And lint', 'turn-2'),
        ...message('msg-3', ['Lint clean'], 'turn-2'),
        completed('completed', 'turn-2')
      ],
      (frame) => void steers.push((frame as { steer: string }).steer)
    )
    const codex = service(replay)
    const sink = recordingSink()
    const result = await new CodexAdapter(() => codex).startTurn(input(), sink, control(steers), host())
    replay.assertDone()
    expect(result).toMatchObject({ text: 'Working\n\nTests pass\n\nLint clean', providerRef: { nativeTurnId: 'turn-2' } })
    expect(sink.calls.filter(([name]) => name === 'steerAccepted').map(([, value]) => value)).toEqual(['Focus on tests', 'And lint'])
  })

  it('stops at once while a steer is still unanswered after the turn completed', async () => {
    const controller = new AbortController()
    const steers: string[] = []
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(3),
        ...turnStart(4, 'hello'),
        ...message('msg-1', ['Working']),
        cue({ steer: 'Focus' }),
        out({ id: 5, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('Focus') } }),
        completed('completed'),
        // The steer is never answered; Stop must settle without its 60 s timeout or an interrupt.
        cue({ stop: true })
      ],
      (frame) => {
        if ((frame as { steer?: string }).steer) steers.push((frame as { steer: string }).steer)
        else controller.abort(new Error('stopped while steering'))
      }
    )
    const codex = service(replay)
    const startedAt = Date.now()
    await expect(new CodexAdapter(() => codex).startTurn(input({ signal: controller.signal }), recordingSink(), control(steers), host())).rejects.toThrow(
      'stopped while steering'
    )
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await replay.idle()
    replay.assertDone()
  })

  it('fails the turn when the app-server exits mid-turn and restarts it for the next one', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'hello'),
      note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: 'Par' }),
      inn({ kind: 'exit', code: 1 }),
      // A new process proves its own sign-in first; the uncommitted thread is not resumed.
      ...handshake(1, true),
      ...threadStart(3, threadParams(), 'thr-1'),
      ...turnStart(4, 'Previous conversation (context only; do not repeat earlier actions):\nprior\n\nCurrent request:\nretry'),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    const failure = adapter.startTurn(input(), recordingSink(), control(), host())
    await expect(failure).rejects.toBeInstanceOf(CodexAppServerExitedError)
    await expect(failure).rejects.toThrow('Codex app-server exited with code 1')
    const retry = await adapter.startTurn(input({ prompt: 'retry', nativeHistory: 'prior' }), recordingSink(), control(), host())
    replay.assertDone()
    expect(retry).toMatchObject({ text: 'ok' })
  })

  it('withdraws a pending approval question when the app-server dies', async () => {
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(3),
        ...turnStart(4, 'hello'),
        inn({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 0, environmentId: null, command: 'make' } }),
        cue({ wait: 'question' }),
        inn({ kind: 'exit', code: 1 })
      ],
      async () => {
        await expect.poll(() => questions.listPendingForThread('thread-1')).toHaveLength(1)
      }
    )
    const codex = service(replay)
    await expect(new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host())).rejects.toBeInstanceOf(CodexAppServerExitedError)
    replay.assertDone()
    expect(questions.listPendingForThread('thread-1')).toEqual([])
  })

  it('never sends a turn to a replacement process before it reports a ChatGPT account', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'hello'),
      inn({ kind: 'exit', code: 1 }),
      ...handshake(1, false),
      out({ id: 2, method: 'account/read', params: { refreshToken: false } }),
      inn({ id: 2, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    await expect(adapter.startTurn(input(), recordingSink(), control(), host())).rejects.toBeInstanceOf(CodexAppServerExitedError)
    expect(codex.configured()).toBe(false)
    await expect(adapter.startTurn(input({ prompt: 'again' }), recordingSink(), control(), host())).rejects.toMatchObject({
      code: 'codex_not_connected'
    })
    replay.assertDone()
  })

  it('fails a turn the server reports as failed', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(3),
      ...turnStart(4, 'hello'),
      note('error', { threadId: T, turnId: 'turn-1', error: { message: 'Reconnecting', codexErrorInfo: null }, willRetry: true }),
      note('error', { threadId: T, turnId: 'turn-1', error: { message: 'Upstream overloaded', codexErrorInfo: null }, willRetry: false }),
      completed('failed', 'turn-1', { message: 'Upstream overloaded', codexErrorInfo: null })
    ])
    const codex = service(replay)
    const sink = recordingSink()
    await expect(new CodexAdapter(() => codex).startTurn(input(), sink, control(), host())).rejects.toThrow('Upstream overloaded')
    replay.assertDone()
    expect(sink.calls.filter(([name]) => name === 'retry').map(([, attempt]) => attempt)).toEqual([1])
  })
})
