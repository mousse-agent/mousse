import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { UserQuestionService, type ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import { approvalFingerprint } from '../../src/mms/run/approvalFingerprint'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { CodexAppServerExitedError } from '../../src/mms/providers/codex/CodexAppServerClient'
import { CodexTurnFailure } from '../../src/mms/providers/codex/CodexProviderService'
import { decideUsageLimit } from '../../src/mms/run/pausePolicy'
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
const SUPERVISED = { type: 'readOnly', networkAccess: false }

/**
 * A new process: `initialize`, the sign-in check and, before the first turn, the check whether the server
 * lists a thread's helpers by ancestor. This server ignores the filters (it answers a listing), so Codex's
 * helpers are tracked from the thread's items alone.
 */
const NIL_THREAD = '00000000-0000-0000-0000-000000000000'
function handshake(firstId = 1, probe = true): TranscriptFrame[] {
  return [
    out({ id: firstId, method: 'initialize', params: { clientInfo: { name: 'mousse', title: 'Mousse', version: '0.1.1' }, capabilities: { experimentalApi: true, requestAttestation: false } } }),
    inn({ id: firstId, result: { userAgent: 'replay', codexHome: '/home/replay/.codex', platformFamily: 'unix', platformOs: 'macos' } }),
    out({ method: 'initialized' }),
    ...(probe
      ? [
          out({ id: firstId + 1, method: 'account/read', params: { refreshToken: false } }),
          inn({ id: firstId + 1, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } }),
          out({ id: firstId + 2, method: 'thread/list', params: { parentThreadId: NIL_THREAD, ancestorThreadId: NIL_THREAD, limit: 1 } }),
          inn({ id: firstId + 2, result: { data: [], nextCursor: null } })
        ]
      : [])
  ]
}

const threadParams = (extra: Record<string, unknown> = {}) => ({
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
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
    out({ id, method: 'turn/start', params: { threadId: T, input: text(prompt), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x', ...extra } }),
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
  const created = createCodexProviderService(home, questions, { launch: replayCodexAppServer(replay) }, { launch: () => ({ binaryPath: binary }) })
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
    permissionMode: 'ask',
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

/** A host whose turn bridge attaches `mcp` with Mousse's session text, or attaches nothing. */
function host(mcp: { url: string; token: string } | null = null): AdapterHost {
  return {
    tools: {},
    bridge: { mcp, turnToken: 'turn-1', sessionInstructions: mcp ? mousseOrchestrationInstructions() : '', turnPreamble: '', userMcp: 'native' },
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
    questions.submitAnswers(request.requestId, answer(request), { kind: 'user' })
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
      ...threadStart(4),
      ...turnStart(5, 'hello'),
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
    const result = await adapter.startTurn(input(), sink, control(), host())
    replay.assertDone()
    // The drained-turn proof counts the calls Codex announced on Mousse's server only, each completed by Codex.
    expect(result.drain).toEqual({ mousseCalls: 1, toolsSettled: true })
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

  it('a Mousse call Codex never completed is not drained: the completion the service adds at the end is not proof', async () => {
    const mcp = (id: string, tool: string, extra: Record<string, unknown>) => ({ type: 'mcpToolCall', id, server: 'mousse', tool, ...extra })
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'hello'),
      // Started and never completed by the server: the turn still completes.
      note('item/started', { threadId: T, turnId: 'turn-1', item: mcp('m-open', 'thread_read', { arguments: {}, status: 'inProgress' }) }),
      // Completed with no start the adapter saw: still announced, and settled.
      note('item/completed', { threadId: T, turnId: 'turn-1', item: mcp('m-late', 'list_tasks', { arguments: {}, status: 'completed' }) }),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const sink = recordingSink()
    const result = await new CodexAdapter(() => service(replay)).startTurn(input(), sink, control(), host())
    replay.assertDone()
    // The open row still closes in the timeline...
    const tools = sink.calls.filter(([name]) => name === 'tool').map(([, event]) => event as { callId: string; phase: string })
    expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ callId: 'm-open', phase: 'complete' })]))
    // ...but the proof counts both calls and knows one never settled, so the bearer rotates.
    expect(result.drain).toEqual({ mousseCalls: 2, toolsSettled: false })
  })

  it('runs a turn: text, thinking, tools, edits, usage and the thread reference', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'hello'),
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
    const diff = '@@\n-old\n+new\n+more'
    const changes = [{ path: 'a.ts', change: 'update', diff, added: 2, removed: 1 }]
    expect(tools).toEqual([
      { kind: 'mcp_tool_call', phase: 'start', callId: 'cmd-1', title: 'ls', summary: 'shell', details: [], activity: { toolName: 'shell', kind: 'command', command: 'ls' } },
      { kind: 'mcp_tool_call', phase: 'complete', callId: 'cmd-1', title: 'ls', summary: 'shell', details: [], activity: { toolName: 'shell', kind: 'command', exitCode: 0, status: 'done' } },
      { kind: 'mcp_tool_call', phase: 'start', callId: 'patch-1', title: 'Edit a.ts', summary: 'apply_patch', details: [], activity: { toolName: 'apply_patch', kind: 'file_change', changes } },
      { kind: 'mcp_tool_call', phase: 'complete', callId: 'patch-1', title: 'Edit a.ts', summary: 'apply_patch', details: [], activity: { toolName: 'apply_patch', kind: 'file_change', changes, status: 'done' } }
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
    const first = transport([...handshake(), ...threadStart(4), ...turnStart(5, 'hello'), ...message('msg-1', ['one']), completed('completed'),
      ...turnStart(6, 'again', 'turn-2'), ...message('msg-2', ['two'], 'turn-2'), completed('completed', 'turn-2')])
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
      out({ id: 4, method: 'thread/resume', params: { threadId: T, excludeTurns: true, ...threadParams() } }),
      inn({ id: 4, result: threadResult() }),
      ...turnStart(5, 'third', 'turn-3'),
      ...message('msg-3', ['three'], 'turn-3'),
      completed('completed', 'turn-3')
    ])
    const reopened = createCodexProviderService(home, questions, { launch: replayCodexAppServer(resumed) }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
    services.push(reopened)
    const third = await new CodexAdapter(() => reopened).startTurn(input({ prompt: 'third', nativeHistory: 'history+two' }), recordingSink(), control(), host())
    resumed.assertDone()
    expect(third).toMatchObject({ text: 'three', providerRef: { sessionId: T } })
    reopened.stop()

    // Resume fails: a fresh thread and the history as a preamble; the new thread replaces the saved one.
    const broken = transport([
      ...handshake(),
      out({ id: 4, method: 'thread/resume', params: { threadId: T, excludeTurns: true, ...threadParams() } }),
      inn({ id: 4, error: { code: -32600, message: `no rollout found for thread id ${T}` } }),
      out({ id: 5, method: 'thread/start', params: threadParams() }),
      inn({ id: 5, result: threadResult('thr-2') }),
      out({ id: 6, method: 'turn/start', params: { threadId: 'thr-2', input: text('Previous conversation (context only; do not repeat earlier actions):\nhistory+three\n\nCurrent request:\nfourth'), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
      inn({ id: 6, result: { turn: { id: 'turn-4', status: 'inProgress', error: null } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-4', item: { type: 'agentMessage', id: 'msg-4', text: 'four' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-4', status: 'completed', error: null } })
    ])
    const recovering = createCodexProviderService(home, questions, { launch: replayCodexAppServer(broken) }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
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
    const replay = transport([...handshake(), out({ id: 4, method: 'thread/start', params: threadParams() }), inn({ id: 4, result: threadResult(T, 'custom') })])
    const codex = service(replay)
    await expect(new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host())).rejects.toMatchObject({
      code: 'codex_provider_not_chatgpt'
    })
    replay.assertDone()
  })

  it('never echoes the model provider the process reported in the refusal', async () => {
    const canary = 'C'.repeat(21) + '_-' + 'z'.repeat(20)
    const replay = transport([...handshake(), out({ id: 4, method: 'thread/start', params: threadParams() }), inn({ id: 4, result: threadResult(T, canary) })])
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
        4,
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
      ...turnStart(5, 'hello'),
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
      ...threadStart(4, threadParams({ config: mcpConfig('old'), developerInstructions })),
      ...turnStart(5, 'hello'),
      ...message('msg-1', ['one']),
      completed('completed'),
      // New token while the thread is still loaded: fork with the new config, release the old thread.
      out({ id: 6, method: 'thread/fork', params: { threadId: T, excludeTurns: true, ...threadParams({ config: mcpConfig('new'), developerInstructions }) } }),
      inn({ id: 6, result: threadResult('thr-2') }),
      out({ id: 7, method: 'thread/unsubscribe', params: { threadId: T } }),
      inn({ id: 7, result: { status: 'unsubscribed' } }),
      out({ id: 8, method: 'turn/start', params: { threadId: 'thr-2', input: text('again'), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
      inn({ id: 8, result: { turn: { id: 'turn-2', status: 'inProgress', error: null } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-2', item: { type: 'agentMessage', id: 'msg-2', text: 'two' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-2', status: 'completed', error: null } }),
      // Same token again: the forked thread is reused as loaded.
      out({ id: 9, method: 'turn/start', params: { threadId: 'thr-2', input: text('third'), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
      inn({ id: 9, result: { turn: { id: 'turn-3', status: 'inProgress', error: null } } }),
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

  it('runs Full access with never-ask approvals and no sandbox, and asks nothing', async () => {
    const FULL = { type: 'dangerFullAccess' }
    const replay = transport([
      ...handshake(),
      ...threadStart(4, threadParams({ approvalPolicy: 'never', sandbox: 'danger-full-access' })),
      ...turnStart(5, 'clean up', 'turn-1', { approvalPolicy: 'never', sandboxPolicy: FULL }),
      // Codex does not ask under `never`; if a request arrives anyway, Mousse accepts without a prompt.
      inn({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 0, environmentId: null, command: 'rm -rf build', cwd: '/w', reason: null } }),
      out({ id: 'srv-1', result: { decision: 'accept' } }),
      inn({ id: 'srv-2', method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: 'patch-1', startedAtMs: 0, reason: null } }),
      out({ id: 'srv-2', result: { decision: 'accept' } }),
      ...message('msg-1', ['Done']),
      completed('completed')
    ])
    const codex = service(replay)
    const asked = answerQuestions(() => ({ permission: 'reject' }))
    await new CodexAdapter(() => codex).startTurn(input({ prompt: 'clean up', permissionMode: 'full' }), recordingSink(), control(), host())
    replay.assertDone()
    expect(asked).toEqual([])
  })

  it('offers only Allow once and Reject, and accepts or declines with nothing for the session', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'go'),
      inn({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 0, environmentId: null, command: 'make', cwd: '/w', reason: null } }),
      out({ id: 'srv-1', result: { decision: 'accept' } }),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const codex = service(replay)
    const asked = answerQuestions(() => ({ permission: 'allow' }))
    await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
    replay.assertDone()
    expect(asked[0].questions[0].options).toEqual([{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }])
  })

  it('asks about a file change only under Ask: Auto-accept edits answers it without a prompt', async () => {
    const patch = (permissionMode: 'ask' | 'accept_edits') => {
      const replay = transport([
        ...handshake(),
        ...threadStart(4),
        ...turnStart(5, 'edit'),
        inn({ id: 'srv-1', method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: 'patch-1', startedAtMs: 0, reason: null } }),
        out({ id: 'srv-1', result: { decision: permissionMode === 'ask' ? 'decline' : 'accept' } }),
        ...message('msg-1', ['ok']),
        completed('completed')
      ])
      return { replay, run: async () => {
        const codex = service(replay)
        const asked = answerQuestions(() => ({ permission: 'reject' }))
        await new CodexAdapter(() => codex).startTurn(input({ prompt: 'edit', permissionMode }), recordingSink(), control(), host())
        replay.assertDone()
        return asked
      } }
    }
    expect(await patch('ask').run()).toHaveLength(1)
    questions.removeAllListeners('pending')
    expect(await patch('accept_edits').run()).toEqual([])
  })

  it('reads a turn without a permission mode as Ask: untrusted approvals, read-only, and an edit is asked about', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'edit'),
      inn({ id: 'srv-1', method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: 'patch-1', startedAtMs: 0, reason: null } }),
      out({ id: 'srv-1', result: { decision: 'decline' } }),
      ...message('msg-1', ['ok']),
      completed('completed')
    ])
    const codex = service(replay)
    const asked = answerQuestions(() => ({ permission: 'reject' }))
    await new CodexAdapter(() => codex).startTurn(input({ prompt: 'edit', permissionMode: undefined }), recordingSink(), control(), host())
    replay.assertDone()
    expect(asked).toHaveLength(1)
  })

  it('sends the new policy on the turn after a mode change, reopening the loaded thread with it', async () => {
    const FULL = { type: 'dangerFullAccess' }
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'one'),
      ...message('msg-1', ['one']),
      completed('completed'),
      out({ id: 6, method: 'thread/fork', params: { threadId: T, excludeTurns: true, ...threadParams({ approvalPolicy: 'never', sandbox: 'danger-full-access' }) } }),
      inn({ id: 6, result: threadResult('thr-2') }),
      out({ id: 7, method: 'thread/unsubscribe', params: { threadId: T } }),
      inn({ id: 7, result: { status: 'unsubscribed' } }),
      out({ id: 8, method: 'turn/start', params: { threadId: 'thr-2', input: text('two'), approvalPolicy: 'never', sandboxPolicy: FULL, model: 'gpt-x' } }),
      inn({ id: 8, result: { turn: { id: 'turn-2', status: 'inProgress', error: null, items: [] } } }),
      note('item/completed', { threadId: 'thr-2', turnId: 'turn-2', item: { type: 'agentMessage', id: 'msg-2', text: 'two' } }),
      note('turn/completed', { threadId: 'thr-2', turn: { id: 'turn-2', status: 'completed', error: null } })
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    await adapter.startTurn(input({ prompt: 'one', permissionMode: 'ask' }), recordingSink(), control(), host())
    await adapter.startTurn(input({ prompt: 'two', permissionMode: 'full', nativeHistory: 'history+one' }), recordingSink(), control(), host())
    replay.assertDone()
  })

  it('routes command, patch and user-input requests to Mousse questions', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(4),
      ...turnStart(5, 'clean up'),
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

  describe('what a saved Codex request is fingerprinted by (a grant after a restart must name the exact action)', () => {
    /** Runs one turn whose approval requests are answered with `decision`, and returns the fingerprint each was saved under. */
    const fingerprints = async (frames: TranscriptFrame[]): Promise<Array<string | null>> => {
      const replay = transport([...handshake(), ...threadStart(4), ...turnStart(5, 'go'), ...frames, ...message('msg-1', ['ok']), completed('completed')])
      const codex = service(replay)
      const asked: Array<ApprovalTag['tool']> = []
      const original = questions.requestAnswers.bind(questions)
      questions.requestAnswers = ((qs: Parameters<typeof original>[0], threadId?: string, options?: Parameters<typeof original>[2]) => {
        asked.push(options?.approval?.tool)
        return Promise.resolve({ permission: 'reject' })
      }) as typeof questions.requestAnswers
      await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
      replay.assertDone()
      return asked.map((tool) => tool === undefined ? null : approvalFingerprint({ instanceId: 'codex', permissionKey: tool.name === 'fileChange' ? 'codex:fileChange' : 'codex:command', toolName: tool.name, input: tool.input, ...(tool.cwd ? { cwd: tool.cwd } : {}) }))
    }
    const command = (id: string, params: Record<string, unknown>): TranscriptFrame[] => [
      inn({ id: `srv-${id}`, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: `cmd-${id}`, startedAtMs: 0, environmentId: null, ...params } }),
      out({ id: `srv-${id}`, result: { decision: 'decline' } })
    ]
    const patch = (id: string, changes: Array<Record<string, unknown>>, params: Record<string, unknown> = {}): TranscriptFrame[] => [
      note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'fileChange', id: `patch-${id}`, changes, status: 'inProgress' } }),
      inn({ id: `srv-${id}`, method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: `patch-${id}`, startedAtMs: 0, reason: null, ...params } }),
      out({ id: `srv-${id}`, result: { decision: 'decline' } })
    ]
    const change = (diff: string | undefined) => ({ path: 'src/a.ts', kind: { type: 'update' }, ...(diff === undefined ? {} : { diff }) })

    it('a command Codex did not give is never fingerprinted; a known one is, with where it runs', async () => {
      const [unknown, known, other] = await fingerprints([...command('1', {}), ...command('2', { command: 'make', cwd: '/w' }), ...command('3', { command: 'make', cwd: '/elsewhere' })])
      expect(unknown).toBeNull()
      expect(known).toMatch(/^[0-9a-f]{64}$/)
      expect(other).not.toBe(known)
    })

    it('a file change without its diff is never fingerprinted, and a session-wide write root is part of the action', async () => {
      const [noDiff, partial, plain, rooted, otherRoot] = await fingerprints([
        ...patch('1', [change(undefined)]),
        ...patch('2', [change('@@\n-a\n+b'), change(undefined)]),
        ...patch('3', [change('@@\n-a\n+b')]),
        ...patch('4', [change('@@\n-a\n+b')], { grantRoot: '/w' }),
        ...patch('5', [change('@@\n-a\n+b')], { grantRoot: '/w/src' })
      ])
      expect(noDiff).toBeNull()
      expect(partial).toBeNull()
      expect(plain).toMatch(/^[0-9a-f]{64}$/)
      expect(rooted).not.toBe(plain)
      expect(otherRoot).not.toBe(rooted)
    })
  })

  describe('"Always for this thread" on Codex approvals', () => {
    const command = (id: string, text: string, cwd = '/w'): TranscriptFrame[] => [
      inn({ id: `srv-${id}`, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: `cmd-${id}`, startedAtMs: 0, environmentId: null, command: text, cwd, reason: null } })
    ]
    const reply = (id: string, decision: string): TranscriptFrame => out({ id: `srv-${id}`, result: { decision } })
    /** The question service bound to a Run Engine that runs `thread-1`, as a profile binds it. */
    const bound = async (mode: 'ask' | 'accept_edits' = 'ask') => {
      const db = new ProfileDatabase({ profileHome: home })
      const store = new RunStore(db)
      const engine = new RunEngine({ store, pid: 1, outbox: new EffectOutbox(store) })
      engine.reconcileOnBoot()
      questions.setLineageSource((threadId) => engine.delegations.getLineage(threadId))
      questions.setApprovalStore({
        store: engine.approvals,
        context: (threadId) => {
          const run = engine.getActiveRun(threadId)
          return run ? { runId: run.runId, instanceId: 'codex', provider: 'codex', origin: 'interactive', permissionMode: mode, approvals: 'ask', startedByPerson: true } : null
        },
        effectDelivery: () => false,
        continuationDue: () => undefined
      })
      const sent = await engine.dispatch({ kind: 'send', threadId: 'thread-1', clientRequestId: 'codex-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      engine.markStarting(sent.runId)
      engine.markRunning(sent.runId)
      return { engine, close: () => db.close() }
    }

    it('answers the exact command again without asking, and still asks for another command, folder or file change', async () => {
      const { engine, close } = await bound()
      try {
        const replay = transport([
          ...handshake(), ...threadStart(4), ...turnStart(5, 'go'),
          ...command('1', 'make test'), reply('1', 'accept'),
          ...command('2', 'make test'), reply('2', 'accept'),
          ...command('3', 'make test --watch'), reply('3', 'decline'),
          ...command('4', 'make test', '/elsewhere'), reply('4', 'decline'),
          ...message('msg-1', ['ok']), completed('completed')
        ])
        const codex = service(replay)
        const asked = answerQuestions((request) => ({ permission: request.questions[0]!.options.some((option) => option.id === 'allow_always') && request.questions[0]!.prompt.includes('make test\n') && !request.questions[0]!.prompt.includes('elsewhere') ? 'allow_always' : 'reject' }))
        await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
        replay.assertDone()
        // The first, the longer command and the other folder were asked; the repeat of the first was not.
        expect(asked.map((request) => request.questions[0]!.prompt.split('\n')[1])).toEqual(['make test', 'make test --watch', 'make test'])
        expect(asked[0]!.questions[0]!.options.map((option) => option.id)).toEqual(['allow', 'allow_always', 'reject'])
        expect(engine.approvals.listRules('thread-1')).toEqual([expect.objectContaining({ permissionKey: 'codex:command', grantedUnder: 'ask' })])
      } finally {
        close()
      }
    })

    const withParams = (id: string, params: Record<string, unknown>): TranscriptFrame[] => [
      inn({ id: `srv-${id}`, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: `cmd-${id}`, startedAtMs: 0, environmentId: null, command: 'npm install', cwd: '/w', reason: null, ...params } })
    ]

    it('a rule made for a plain request never accepts one that asks for more: a reason, an extra field, another folder', async () => {
      const { engine, close } = await bound()
      try {
        const replay = transport([
          ...handshake(), ...threadStart(4), ...turnStart(5, 'go'),
          ...withParams('1', {}), reply('1', 'accept'),
          // The same command and folder, now asking to leave the sandbox: asked, and offered no "always".
          ...withParams('2', { reason: 'Retry outside the sandbox' }), reply('2', 'decline'),
          ...withParams('3', { networkApprovalContext: { host: 'registry.example' } }), reply('3', 'decline'),
          ...withParams('4', { cwd: '/w/packages/a' }), reply('4', 'decline'),
          ...withParams('5', { cwd: 'packages/a' }), reply('5', 'decline'),
          // A path with dot segments names no exact place: asked, and offered no "always".
          ...withParams('6', { cwd: '/w/link/..' }), reply('6', 'decline'),
          // The plain request again is answered by the rule.
          ...withParams('7', {}), reply('7', 'accept'),
          ...message('msg-1', ['ok']), completed('completed')
        ])
        const codex = service(replay)
        // "Always" to the first, plain request only.
        let seen = 0
        const asked = answerQuestions(() => ({ permission: seen++ === 0 ? 'allow_always' : 'reject' }))
        await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
        replay.assertDone()
        // Asked: the first, then each variant; not the last.
        expect(asked).toHaveLength(6)
        expect(asked.map((request) => request.questions[0]!.options.map((option) => option.id).join())).toEqual([
          'allow,allow_always,reject', 'allow,reject', 'allow,allow_always,reject', 'allow,allow_always,reject', 'allow,allow_always,reject', 'allow,reject'
        ])
        expect(engine.approvals.listRules('thread-1')).toHaveLength(1)
      } finally {
        close()
      }
    })

    it('a file change that gives a reason is not offered "always" and is not answered by a rule', async () => {
      const { engine, close } = await bound()
      try {
        const change = { path: 'src/a.ts', kind: { type: 'update' }, diff: '@@\n-a\n+b' }
        const patch = (id: string, params: Record<string, unknown> = {}): TranscriptFrame[] => [
          note('item/started', { threadId: T, turnId: 'turn-1', item: { type: 'fileChange', id: `patch-${id}`, changes: [change], status: 'inProgress' } }),
          inn({ id: `srv-p${id}`, method: 'item/fileChange/requestApproval', params: { threadId: T, turnId: 'turn-1', itemId: `patch-${id}`, startedAtMs: 0, reason: null, ...params } })
        ]
        const replay = transport([
          ...handshake(), ...threadStart(4), ...turnStart(5, 'go'),
          ...patch('1'), out({ id: 'srv-p1', result: { decision: 'accept' } }),
          ...patch('2', { reason: 'needs write outside the workspace' }), out({ id: 'srv-p2', result: { decision: 'decline' } }),
          ...patch('3'), out({ id: 'srv-p3', result: { decision: 'accept' } }),
          ...message('msg-1', ['ok']), completed('completed')
        ])
        const codex = service(replay)
        let seen = 0
        const asked = answerQuestions(() => ({ permission: seen++ === 0 ? 'allow_always' : 'reject' }))
        await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
        replay.assertDone()
        expect(asked.map((request) => request.questions[0]!.options.map((option) => option.id).join())).toEqual(['allow,allow_always,reject', 'allow,reject'])
        expect(engine.approvals.listRules('thread-1')).toHaveLength(1)
      } finally {
        close()
      }
    })

    it('a command Codex gave no text for is asked every time and offers no "always"', async () => {
      const { engine, close } = await bound()
      try {
        const noText = (id: string): TranscriptFrame[] => [
          inn({ id: `srv-${id}`, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: T, turnId: 'turn-1', itemId: `cmd-${id}`, startedAtMs: 0, environmentId: null } }),
          reply(id, 'decline')
        ]
        const replay = transport([...handshake(), ...threadStart(4), ...turnStart(5, 'go'), ...noText('1'), ...noText('2'), ...message('msg-1', ['ok']), completed('completed')])
        const codex = service(replay)
        const asked = answerQuestions(() => ({ permission: 'reject' }))
        await new CodexAdapter(() => codex).startTurn(input({ prompt: 'go' }), recordingSink(), control(), host())
        replay.assertDone()
        expect(asked).toHaveLength(2)
        expect(asked.map((request) => request.questions[0]!.options.map((option) => option.id))).toEqual([['allow', 'reject'], ['allow', 'reject']])
        expect(engine.approvals.listRules('thread-1')).toEqual([])
      } finally {
        close()
      }
    })
  })

  it('runs plan turns read-only and declines approvals without asking', async () => {
    const replay = transport([
      ...handshake(),
      ...threadStart(4, threadParams({ approvalPolicy: 'on-request', sandbox: 'read-only' })),
      ...turnStart(5, 'plan it', 'turn-1', { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
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
        ...threadStart(4),
        ...turnStart(5, 'hello'),
        note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: 'Part' }),
        cue({ action: 'stop' }),
        out({ id: 6, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
        inn({ id: 6, result: {} }),
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

  describe('after Stop', () => {
    const STOPPED = 'history up to the stopped request'
    /** A host that reports the history a stopped turn left, as the engine's does. */
    const stoppedHost = (): AdapterHost => {
      const base = host()
      return { ...base, context: { ...base.context, nativeHistoryNow: () => STOPPED } }
    }
    const savedThreads = () =>
      (JSON.parse(readFileSync(settingsPath(), 'utf8')) as { threads?: Record<string, { codexThreadId: string; historyKey?: string }> }).threads

    it('keeps the Codex thread of a stopped turn, so the next turn continues it without the history preamble', async () => {
      const controller = new AbortController()
      const replay = transport(
        [
          ...handshake(),
          ...threadStart(4),
          ...turnStart(5, 'hello'),
          note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: 'Part' }),
          cue({ action: 'stop' }),
          out({ id: 6, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
          inn({ id: 6, result: {} }),
          completed('interrupted'),
          // The next turn: no thread/start, no thread/resume, and the plain prompt.
          ...turnStart(7, 'again', 'turn-2'),
          ...message('msg-2', ['two'], 'turn-2'),
          completed('completed', 'turn-2')
        ],
        () => controller.abort(new Error('stopped by the user'))
      )
      const codex = service(replay)
      const adapter = new CodexAdapter(() => codex)
      await expect(adapter.startTurn(input({ signal: controller.signal }), recordingSink(), control(), stoppedHost())).rejects.toThrow('stopped by the user')
      expect(savedThreads()['thread-1']).toMatchObject({ codexThreadId: T, historyKey: sha(STOPPED) })
      const next = await adapter.startTurn(input({ prompt: 'again', nativeHistory: STOPPED }), recordingSink(), control(), host())
      replay.assertDone()
      expect(next).toMatchObject({ text: 'two', providerRef: { sessionId: T } })
    })

    it('remembers nothing for a Stop before the thread was opened, and the next turn starts a new thread', async () => {
      const controller = new AbortController()
      const replay = transport([
        ...handshake(),
        // Stop lands while thread/start is still pending: the stopped turn never had a thread to keep.
        out({ id: 4, method: 'thread/start', params: threadParams() }),
        cue({ action: 'stop' }),
        inn({ id: 4, result: threadResult() }),
        // The next turn starts a new thread with the history as a preamble.
        ...threadStart(5),
        out({ id: 6, method: 'turn/start', params: { threadId: T, input: text(`Previous conversation (context only; do not repeat earlier actions):\n${STOPPED}\n\nCurrent request:\nagain`), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
        inn({ id: 6, result: { turn: { id: 'turn-2', status: 'inProgress', error: null, items: [] } } }),
        ...message('msg-2', ['two'], 'turn-2'),
        completed('completed', 'turn-2')
      ], () => controller.abort(new Error('stopped while the thread opened')))
      const codex = service(replay)
      const adapter = new CodexAdapter(() => codex)
      await expect(adapter.startTurn(input({ signal: controller.signal }), recordingSink(), control(), stoppedHost())).rejects.toThrow('stopped while the thread opened')
      expect(savedThreads()?.['thread-1']).toBeUndefined()
      const next = await adapter.startTurn(input({ prompt: 'again', nativeHistory: STOPPED }), recordingSink(), control(), host())
      replay.assertDone()
      expect(next).toMatchObject({ text: 'two' })
    })

    it('resumes the stopped thread on a new process when the app-server exits after Stop', async () => {
      const controller = new AbortController()
      const replay = transport(
        [
          ...handshake(),
          ...threadStart(4),
          ...turnStart(5, 'hello'),
          cue({ action: 'stop' }),
          out({ id: 6, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
          inn({ id: 6, result: {} }),
          inn({ kind: 'exit', code: 1 }),
          // A new process proves its own sign-in, then resumes the stopped thread.
          ...handshake(1, true),
          out({ id: 4, method: 'thread/resume', params: { threadId: T, excludeTurns: true, ...threadParams() } }),
          inn({ id: 4, result: threadResult() }),
          ...turnStart(5, 'again', 'turn-2'),
          ...message('msg-2', ['two'], 'turn-2'),
          completed('completed', 'turn-2')
        ],
        () => controller.abort(new Error('stopped by the user'))
      )
      const codex = service(replay)
      const adapter = new CodexAdapter(() => codex)
      await expect(adapter.startTurn(input({ signal: controller.signal }), recordingSink(), control(), stoppedHost())).rejects.toThrow('stopped by the user')
      await replay.idle()
      const next = await adapter.startTurn(input({ prompt: 'again', nativeHistory: STOPPED }), recordingSink(), control(), host())
      replay.assertDone()
      expect(next).toMatchObject({ text: 'two', providerRef: { sessionId: T } })
    })

    it('fingerprints nothing when no stopped turn is remembered', async () => {
      const replay = transport([...handshake(), ...threadStart(4), ...turnStart(5, 'hello'), ...message('msg-1', ['one']), completed('completed')])
      const codex = service(replay)
      await new CodexAdapter(() => codex).startTurn(input(), recordingSink(), control(), host())
      const before = readFileSync(settingsPath(), 'utf8')
      // No stopped turn is remembered, so a fingerprint changes nothing.
      codex.commitInterrupted('thread-1', STOPPED)
      expect(readFileSync(settingsPath(), 'utf8')).toBe(before)
    })
  })

  it('fingerprints the thread a usage limit ended, and no other failure', async () => {
    const committed: Array<[string, string]> = []
    const client = (failure: Error) =>
      ({
        configured: () => true,
        chat: async () => {
          throw failure
        },
        commitInterrupted: (threadId: string, history: string) => void committed.push([threadId, history])
      }) as unknown as CodexProviderService
    const base = host()
    const withHistory: AdapterHost = { ...base, context: { ...base.context, nativeHistoryNow: () => 'history up to the limit' } }
    const limit = usageLimitError({ provider: 'codex', estimated: true })
    await expect(new CodexAdapter(() => client(limit)).startTurn(input(), recordingSink(), control(), withHistory)).rejects.toBe(limit)
    expect(committed).toEqual([['thread-1', 'history up to the limit']])
    await expect(new CodexAdapter(() => client(new Error('boom'))).startTurn(input(), recordingSink(), control(), withHistory)).rejects.toThrow('boom')
    expect(committed).toHaveLength(1)
  })

  it('a managed run keeps reporting a usage limit to the harness gateway, and still fingerprints the thread', async () => {
    const committed: string[] = []
    const failure = new CodexTurnFailure('Usage limit reached', { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' })
    const client = {
      configured: () => true,
      chat: async () => {
        throw usageLimitError({ provider: 'codex', estimated: true }, failure)
      },
      commitInterrupted: (_threadId: string, history: string) => void committed.push(history)
    } as unknown as CodexProviderService
    const base = host()
    const withHistory: AdapterHost = { ...base, context: { ...base.context, nativeHistoryNow: () => 'history up to the limit' } }
    const error = await new CodexAdapter(() => client, { managed: true }).startTurn(input(), recordingSink(), control(), withHistory).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'rate_limited' })
    expect(committed).toEqual(['history up to the limit'])
  })

  describe('a usage limit reaches the run pause the same way on a managed and on a plain Codex', () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    const failing = (failure: Error) =>
      ({ configured: () => true, chat: async () => { throw failure } }) as unknown as CodexProviderService
    const turn = (client: CodexProviderService, managed: boolean) =>
      new CodexAdapter(() => client, managed ? { managed: true } : {}).startTurn(input(), recordingSink(), control(), host()).catch((caught: unknown) => caught)
    const decide = (error: unknown) =>
      decideUsageLimit({ error, run: { outcome: {} }, lookup: () => null, cap: 3, autoResume: true, nowMs: Date.now() })

    it('both pause with the provider\'s reset time and window', async () => {
      const limit = usageLimitError({ provider: 'codex', resetsAt, estimated: false, limitKind: 'five_hour' })
      const plain = await turn(failing(limit), false)
      const managed = await turn(failing(usageLimitError({ provider: 'codex', resetsAt, estimated: false, limitKind: 'five_hour' }, new CodexTurnFailure('Usage limit reached', { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' }))), true)

      // A plain run throws the typed limit; a managed one throws the gateway's code, with the limit as its cause.
      expect(plain).toMatchObject({ code: 'provider_usage_limit' })
      expect(managed).toMatchObject({ code: 'rate_limited' })
      const expected = { action: 'pause', pause: { reason: 'usage_limit', until: resetsAt, estimated: false, provider: 'codex', limitKind: 'five_hour', count: 1, autoResume: true } }
      expect(decide(plain)).toEqual(expected)
      expect(decide(managed)).toEqual(expected)
    })

    it('both pause with an estimate when the provider gave no time', async () => {
      const managed = await turn(failing(usageLimitError({ provider: 'codex', estimated: true }, new CodexTurnFailure('Usage limit reached', { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' }))), true)
      const plain = await turn(failing(usageLimitError({ provider: 'codex', estimated: true })), false)
      for (const error of [plain, managed]) expect(decide(error)).toMatchObject({ action: 'pause', pause: { estimated: true, provider: 'codex' } })
    })

    it.each([
      ['rateLimitExceeded', { message: 'Rate limit reached', codexErrorInfo: 'rateLimitExceeded' }],
      ['a limit read only from the message of an older server', { message: 'You have hit your usage limit', codexErrorInfo: null }],
      ['a 429 after Codex gave up retrying', { message: 'Too many requests', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }]
    ])('%s pauses on a managed Codex as on a plain one', async (_name, info) => {
      const cause = () => new CodexTurnFailure(info.message, info as never)
      const managed = await turn(failing(usageLimitError({ provider: 'codex', resetsAt, estimated: false }, cause())), true)
      const plain = await turn(failing(usageLimitError({ provider: 'codex', resetsAt, estimated: false }, cause())), false)
      expect(managed).toMatchObject({ code: 'rate_limited' })
      expect(decide(managed)).toEqual(decide(plain))
      expect(decide(managed)).toMatchObject({ action: 'pause', pause: { until: resetsAt, estimated: false } })
    })

    it('a managed Codex failure that is not a usage limit does not pause', async () => {
      const overloaded = new CodexTurnFailure('Overloaded', { message: 'Overloaded', codexErrorInfo: 'serverOverloaded' })
      const managed = await turn(failing(overloaded), true)
      expect(managed).toMatchObject({ code: 'service_unavailable' })
      expect(decide(managed)).toBeUndefined()
    })
  })

  it('interrupts a turn that was stopped before turn/start answered', async () => {
    const controller = new AbortController()
    const replay = transport(
      [
        ...handshake(),
        ...threadStart(4),
        out({ id: 5, method: 'turn/start', params: { threadId: T, input: text('hello'), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
        cue({ action: 'stop' }),
        inn({ id: 5, result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }),
        out({ id: 6, method: 'turn/interrupt', params: { threadId: T, turnId: 'turn-1' } }),
        inn({ id: 6, result: {} }),
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
    const replay = transport([...handshake(), ...threadStart(4)])
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
        ...threadStart(4),
        ...turnStart(5, 'hello'),
        ...message('msg-1', ['Working']),
        cue({ steer: 'Focus on tests' }),
        out({ id: 6, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('Focus on tests') } }),
        inn({ id: 6, result: { turnId: 'turn-1' } }),
        ...message('msg-2', ['Tests pass']),
        cue({ steer: 'And lint' }),
        out({ id: 7, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('And lint') } }),
        completed('completed'),
        inn({ id: 7, error: { code: -32600, message: 'no active turn to steer' } }),
        ...turnStart(8, 'And lint', 'turn-2'),
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
        ...threadStart(4),
        ...turnStart(5, 'hello'),
        ...message('msg-1', ['Working']),
        cue({ steer: 'Focus' }),
        out({ id: 6, method: 'turn/steer', params: { threadId: T, expectedTurnId: 'turn-1', input: text('Focus') } }),
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
      ...threadStart(4),
      ...turnStart(5, 'hello'),
      note('item/agentMessage/delta', { threadId: T, turnId: 'turn-1', itemId: 'msg-1', delta: 'Par' }),
      inn({ kind: 'exit', code: 1 }),
      // A new process proves its own sign-in first; the uncommitted thread is not resumed.
      ...handshake(1, true),
      ...threadStart(4, threadParams(), 'thr-1'),
      ...turnStart(5, 'Previous conversation (context only; do not repeat earlier actions):\nprior\n\nCurrent request:\nretry'),
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
        ...threadStart(4),
        ...turnStart(5, 'hello'),
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
      ...threadStart(4),
      ...turnStart(5, 'hello'),
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
      ...threadStart(4),
      ...turnStart(5, 'hello'),
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
