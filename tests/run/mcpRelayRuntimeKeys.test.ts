/**
 * The MCP relay in each runtime (SPEC §15.5): a runtime reads its MCP tool lists when it opens a
 * process, thread or session, so a new relay catalogue revision is a soft reopen key (Claude's
 * launch key, Codex's loaded thread, an ACP session) while the same one keeps what is open. Relayed
 * calls reach Mousse like its own: Claude stamps them with the turn token, and Codex's drained-turn
 * proof counts them.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { createCodexProviderService, type CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { CodexAdapter } from '../../src/mms/harness/drivers/codex/adapter'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { McpAttachment } from '../../src/mms/run/mcp/MousseMcpServer'
import { CODEX_APP_SERVER_BOUNDARY, replayCodexAppServer } from '../../src/mms/run/testkit/codexAppServerReplay'
import { parseTranscript, ReplayTransport, type TranscriptFrame } from '../../src/mms/run/testkit/ReplayTransport'

const MCP = { url: 'http://127.0.0.1:4567/mcp', token: 'tok-secret' }
const RELAY_URL = 'http://127.0.0.1:4567/mcp/relay'
const relayed = (revision: string): McpAttachment => ({ ...MCP, relay: { url: RELAY_URL, revision } })

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const tempHome = (prefix: string): string => {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

describe('Claude Code', () => {
  const service = (query: (input: { options: Options; prompt: unknown }) => Query = () => { throw new Error('no query') }) => {
    const home = tempHome('mousse-relay-claude-')
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const questions = new UserQuestionService()
    const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    return { home, questions, service: new ClaudeSubscriptionProviderService(home, questions, { query, runAuth, launchConfig: () => ({ binaryPath: binary }) }) }
  }

  it('the soft launch key changes with the relay and its revision, and is the same without a relay', () => {
    const { service: claude } = service()
    const launchKey = (relay?: McpAttachment['relay'] | null) =>
      (claude as unknown as { launchKey(env: NodeJS.ProcessEnv, integrations: undefined, settings: undefined, relay?: McpAttachment['relay'] | null): string })
        .launchKey({ PATH: '/bin' }, undefined, undefined, relay)
    const without = launchKey()
    expect(launchKey(null)).toBe(without)
    expect(launchKey(undefined)).toBe(without)
    const first = launchKey(relayed('rev-1').relay)
    expect(first).not.toBe(without)
    expect(launchKey(relayed('rev-1').relay)).toBe(first)
    expect(launchKey(relayed('rev-2').relay)).not.toBe(first)
  })

  it('Mousse\'s PreToolUse hook stamps a relayed call with the turn token, like a Mousse call', async () => {
    const options: Options[] = []
    const finished = (o: Options) => Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }
    })(), { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
    const { home, service: claude } = service(({ options: o }) => { options.push(o); return finished(o) })
    await claude.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn(), mcp: relayed('rev-1'), mcpTurnToken: 'turn-7' })
    const hook = (tool_name: string) => options[0].hooks!.PreToolUse![0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_name, tool_input: { limit: 5 }, tool_use_id: 'u' } as never, 'u', { signal: new AbortController().signal }
    )
    expect(await hook('mcp__mousse-relay__github__create_issue')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { limit: 5, _mousse_turn: 'turn-7' } }
    })
    expect(await hook('mcp__mousse__thread_read')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { limit: 5, _mousse_turn: 'turn-7' } }
    })
    // A server whose name only starts like Mousse's is not Mousse's.
    expect(await hook('mcp__mousse-relayed__x')).toEqual({})
  })
})

// ----- Codex (the transcript helpers of `codexAdapter.test.ts`) ---------------------------------

const T = 'thr-1'
const out = (frame: unknown): TranscriptFrame => ({ dir: 'out', frame })
const inn = (frame: unknown): TranscriptFrame => ({ dir: 'in', frame })
const note = (method: string, params: unknown): TranscriptFrame => inn({ method, params })
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const SUPERVISED = { type: 'readOnly', networkAccess: false }
const NIL_THREAD = '00000000-0000-0000-0000-000000000000'

function handshake(): TranscriptFrame[] {
  return [
    out({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mousse', title: 'Mousse', version: '0.1.1' }, capabilities: { experimentalApi: true, requestAttestation: false } } }),
    inn({ id: 1, result: { userAgent: 'replay', codexHome: '/home/replay/.codex', platformFamily: 'unix', platformOs: 'macos' } }),
    out({ method: 'initialized' }),
    out({ id: 2, method: 'account/read', params: { refreshToken: false } }),
    inn({ id: 2, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } }),
    out({ id: 3, method: 'thread/list', params: { parentThreadId: NIL_THREAD, ancestorThreadId: NIL_THREAD, limit: 1 } }),
    inn({ id: 3, result: { data: [], nextCursor: null } })
  ]
}
const threadParams = (extra: Record<string, unknown> = {}) => ({
  approvalPolicy: 'untrusted', sandbox: 'read-only', model: 'gpt-x', modelProvider: 'openai', config: { model_provider: 'openai' }, ...extra
})
const threadResult = (thread = T) => ({ thread: { id: thread }, model: 'gpt-x', modelProvider: 'openai', cwd: '/w' })
const turnStartOn = (id: number, thread: string, prompt: string, turn: string): TranscriptFrame[] => [
  out({ id, method: 'turn/start', params: { summary: 'auto', threadId: thread, input: text(prompt), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
  inn({ id, result: { turn: { id: turn, status: 'inProgress', error: null } } })
]
const reply = (thread: string, turn: string, value: string): TranscriptFrame[] => [
  note('item/completed', { threadId: thread, turnId: turn, item: { type: 'agentMessage', id: `msg-${turn}`, text: value } }),
  note('turn/completed', { threadId: thread, turn: { id: turn, status: 'completed', error: null } })
]
function transport(frames: TranscriptFrame[]): ReplayTransport {
  const header = { kind: 'transcript', adapter: 'codex', scenario: 'unit', boundary: CODEX_APP_SERVER_BOUNDARY, recordedAt: 'hand-authored', version: 1 }
  return new ReplayTransport(parseTranscript([header, ...frames].map((line) => JSON.stringify(line)).join('\n')), { stallMs: 2_000 })
}
/** Codex's config for the Mousse server and, with a revision, the relay (`codexMcpConfigOverrides`). */
const mcpConfig = (relay: boolean) => ({
  model_provider: 'openai',
  'mcp_servers.mousse.url': MCP.url,
  'mcp_servers.mousse.http_headers': { Authorization: 'Bearer tok-secret' },
  'mcp_servers.mousse.tool_timeout_sec': 3600,
  'mcp_servers.mousse.default_tools_approval_mode': 'approve',
  ...(relay
    ? {
        'mcp_servers.mousse-relay.url': RELAY_URL,
        'mcp_servers.mousse-relay.http_headers': { Authorization: 'Bearer tok-secret' },
        'mcp_servers.mousse-relay.tool_timeout_sec': 3600,
        'mcp_servers.mousse-relay.default_tools_approval_mode': 'approve'
      }
    : {})
})

describe('Codex', () => {
  let home: string
  let work: string
  let questions: UserQuestionService
  const services: CodexProviderService[] = []
  beforeEach(() => {
    home = tempHome('mousse-relay-codex-')
    work = join(home, 'work')
    mkdirSync(work)
    questions = new UserQuestionService()
  })
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    questions.shutdown()
  })

  const service = (replay: ReplayTransport): CodexProviderService => {
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-x', label: 'GPT X' }] }))
    const created = createCodexProviderService(home, questions, { launch: replayCodexAppServer(replay) }, { launch: () => ({ binaryPath: binary }) })
    services.push(created)
    return created
  }
  const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
    runId: 'run-1', attemptId: 'attempt-1', threadId: 'thread-1', cwd: work, instanceId: 'codex', model: 'gpt-x', llmProvider: 'codex',
    modelPinned: true, mode: 'agent', permissionMode: 'ask', prompt: 'hello', messages: [], signal: new AbortController().signal, ...overrides
  })
  const sink = (): TurnSink => new Proxy({} as TurnSink, { get: () => () => undefined })
  // No session text, so the thread parameters stay the same across turns.
  const host = (mcp: McpAttachment | null): AdapterHost => ({
    tools: {},
    bridge: { mcp, turnToken: 'turn-1', sessionInstructions: '', turnPreamble: '', userMcp: 'native' },
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (value) => `history+${value}` }
  })
  const control = () => ({ drainSteer: () => undefined, heartbeat: () => {} })

  it('forks a loaded thread when the relay or its revision changes, and continues it while the relay is the same', async () => {
    const replay = transport([
      ...handshake(),
      out({ id: 4, method: 'thread/start', params: threadParams({ config: mcpConfig(false) }) }),
      inn({ id: 4, result: threadResult() }),
      ...turnStartOn(5, T, 'hello', 'turn-1'),
      ...reply(T, 'turn-1', 'one'),
      // The relay is attached while the thread is loaded: fork it with the new config.
      out({ id: 6, method: 'thread/fork', params: { threadId: T, excludeTurns: true, ...threadParams({ config: mcpConfig(true) }) } }),
      inn({ id: 6, result: threadResult('thr-2') }),
      out({ id: 7, method: 'thread/unsubscribe', params: { threadId: T } }),
      inn({ id: 7, result: { status: 'unsubscribed' } }),
      ...turnStartOn(8, 'thr-2', 'two', 'turn-2'),
      ...reply('thr-2', 'turn-2', 'two'),
      // Same relay and revision: the forked thread continues as loaded.
      ...turnStartOn(9, 'thr-2', 'three', 'turn-3'),
      ...reply('thr-2', 'turn-3', 'three'),
      // A new revision (same config keys): fork again, so Codex lists the relay's tools anew.
      out({ id: 10, method: 'thread/fork', params: { threadId: 'thr-2', excludeTurns: true, ...threadParams({ config: mcpConfig(true) }) } }),
      inn({ id: 10, result: threadResult('thr-3') }),
      out({ id: 11, method: 'thread/unsubscribe', params: { threadId: 'thr-2' } }),
      inn({ id: 11, result: { status: 'unsubscribed' } }),
      ...turnStartOn(12, 'thr-3', 'four', 'turn-4'),
      ...reply('thr-3', 'turn-4', 'four')
    ])
    const codex = service(replay)
    const adapter = new CodexAdapter(() => codex)
    await adapter.startTurn(input(), sink(), control(), host(MCP))
    const second = await adapter.startTurn(input({ prompt: 'two', nativeHistory: 'history+one' }), sink(), control(), host(relayed('rev-1')))
    expect(second).toMatchObject({ text: 'two', providerRef: { sessionId: 'thr-2' } })
    const third = await adapter.startTurn(input({ prompt: 'three', nativeHistory: 'history+two' }), sink(), control(), host(relayed('rev-1')))
    expect(third).toMatchObject({ text: 'three', providerRef: { sessionId: 'thr-2' } })
    const fourth = await adapter.startTurn(input({ prompt: 'four', nativeHistory: 'history+three' }), sink(), control(), host(relayed('rev-2')))
    expect(fourth).toMatchObject({ text: 'four', providerRef: { sessionId: 'thr-3' } })
    replay.assertDone()
  })

  it('the drained-turn proof counts relayed calls with Mousse\'s own, and no other server\'s', async () => {
    const mcp = (id: string, server: string, tool: string) => ({ type: 'mcpToolCall', id, server, tool, arguments: {} })
    const call = (id: string, server: string, tool: string): TranscriptFrame[] => [
      note('item/started', { threadId: T, turnId: 'turn-1', item: { ...mcp(id, server, tool), status: 'inProgress' } }),
      note('item/completed', { threadId: T, turnId: 'turn-1', item: { ...mcp(id, server, tool), status: 'completed' } })
    ]
    const replay = transport([
      ...handshake(),
      out({ id: 4, method: 'thread/start', params: threadParams({ config: mcpConfig(true) }) }),
      inn({ id: 4, result: threadResult() }),
      ...turnStartOn(5, T, 'hello', 'turn-1'),
      ...call('m-1', 'mousse', 'thread_read'),
      ...call('r-1', 'mousse-relay', 'github__create_issue'),
      ...call('o-1', 'tracker', 'list'),
      ...reply(T, 'turn-1', 'ok')
    ])
    const result = await new CodexAdapter(() => service(replay)).startTurn(input(), sink(), control(), host(relayed('rev-1')))
    replay.assertDone()
    expect(result.drain).toEqual({ mousseCalls: 2, toolsSettled: true })
  })
})

// ----- ACP (the fake agent of `mcpAttachment.test.ts`) --------------------------------------------

type Sent = { method: string; params: Record<string, unknown> }

function fakeAcp(sent: Sent[]) {
  return function () {
    const abort = new AbortController()
    return {
      child: { exitCode: 0, signalCode: null, kill: () => true },
      connection: {
        signal: abort.signal,
        close: () => abort.abort(new Error('closed')),
        agent: {
          request: async (method: string, params: Record<string, unknown>) => {
            sent.push({ method, params })
            if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } } }
            if (method === 'session/new' || method === 'session/resume')
              return { sessionId: 'acp-session', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }] }
            if (method === 'session/prompt') return { stopReason: 'end_turn' }
            return {}
          },
          notify: async () => undefined
        }
      }
    }
  }
}

describe('ACP agents', () => {
  it('reopen the session when the relay or its revision changes, and keep it while the relay is the same', async () => {
    const sent: Sent[] = []
    const launch = vi.fn(fakeAcp(sent))
    const home = tempHome('mousse-relay-acp-')
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const antigravity = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { connect: launch as never })
    Object.assign(antigravity as unknown as Record<string, unknown>, { configured: () => true })
    const opened = () => sent.filter((frame) => frame.method === 'session/new' || frame.method === 'session/resume')
    const chat = { threadId: 't', cwd: workspace, model: 'm1', onText: vi.fn() }
    const auth = [{ name: 'Authorization', value: 'Bearer tok-secret' }]

    await antigravity.chat({ ...chat, prompt: 'first', mcp: MCP })
    antigravity.commitConversation('t', 'history-1')
    await antigravity.chat({ ...chat, prompt: 'second', history: 'history-1', mcp: relayed('rev-1') })
    expect(opened()).toHaveLength(2)
    expect(opened()[1]).toMatchObject({ method: 'session/resume' })
    expect(opened()[1].params.mcpServers).toEqual([
      { name: 'mousse', type: 'http', url: MCP.url, headers: auth },
      { name: 'mousse-relay', type: 'http', url: RELAY_URL, headers: auth }
    ])

    antigravity.commitConversation('t', 'history-2')
    await antigravity.chat({ ...chat, prompt: 'third', history: 'history-2', mcp: relayed('rev-1') })
    expect(opened()).toHaveLength(2)

    antigravity.commitConversation('t', 'history-3')
    await antigravity.chat({ ...chat, prompt: 'fourth', history: 'history-3', mcp: relayed('rev-2') })
    expect(opened()).toHaveLength(3)
    expect(opened()[2]).toMatchObject({ method: 'session/resume' })
    await antigravity.stop()
  })
})
