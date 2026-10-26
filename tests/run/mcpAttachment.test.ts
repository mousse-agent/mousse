/**
 * Phase 5 attachment per adapter (docs/run-engine/SPEC.md §15.2): Claude's SDK `mcpServers`, the
 * ACP `session/new|resume` `mcpServers` (HTTP or the stdio bridge), and CLI children's materialised
 * `mousse` entry. Nothing is attached without `AdapterHost.mcp`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigManager } from '../../src/mms/integrations/agents/AgentConfigManager'
import type { McpRegistry } from '../../src/mms/integrations/mcp/McpRegistry'
import type { SkillsRegistry } from '../../src/mms/integrations/skills/SkillsRegistry'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../src/mms/providers/antigravity/AntigravityProviderService'
import {
  ClaudeSubscriptionProviderService,
  type ClaudeSubscriptionChatInput
} from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { antigravityAdapter } from '../../src/mms/harness/drivers/antigravity'
import type { AcpTurnClient as AntigravityClient } from '../../src/mms/run/adapters/acp/AcpAdapter'
import { ClaudeSubscriptionAdapter, type ClaudeSubscriptionClient } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { acpMcpServers, claudeMcpServers, MOUSSE_MCP_TOKEN_ENV } from '../../src/mms/run/mcp/attachment'
import { mousseOrchestrationInstructions } from '../../src/mms/run/mcp/instructions'
import type { SettingsStore } from '../../src/mms/settings/SettingsStore'

const MCP = { url: 'http://127.0.0.1:4567/mcp', token: 'tok-secret' }
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const tempHome = (prefix: string): string => {
  const home = mkdtempSync(join(tmpdir(), prefix))
  homes.push(home)
  return home
}

const sink = (): TurnSink => new Proxy({} as TurnSink, { get: () => () => undefined })
/** A host whose bridge attaches `mcp` (with the session text a turn would get), or none. */
const host = (mcp: { url: string; token: string } | null): AdapterHost => ({
  bridge: { mcp, turnToken: 'turn-1', sessionInstructions: mcp ? mousseOrchestrationInstructions() : '', turnPreamble: '', userMcp: 'native' },
  tools: {},
  context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => text }
})
const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  runId: 'run-1', attemptId: 'a-1', threadId: 'thread-1', cwd: '/work', instanceId: 'claude-subscription', model: 'sonnet', llmProvider: 'claude-subscription',
  modelPinned: true, mode: 'agent', prompt: 'hello', messages: [], signal: new AbortController().signal, ...overrides
})
const control = { drainSteer: () => undefined, heartbeat: () => undefined }

describe('Claude subscription attachment', () => {
  it('the Claude adapter passes the server, its turn token and the session text only when the bridge attaches one, and leaves AGENTS.md to Claude Code', async () => {
    const seen: ClaudeSubscriptionChatInput[] = []
    const standalone = tempHome('mousse-claude-standalone-')
    writeFileSync(join(standalone, 'AGENTS.md'), 'STANDALONE RULES')
    const client: ClaudeSubscriptionClient = {
      chat: vi.fn(async (chat: ClaudeSubscriptionChatInput) => { seen.push(chat); return 'ok' }),
      commitConversation: vi.fn(),
      standaloneWorkspace: () => standalone,
      configured: () => true
    }
    const adapter = new ClaudeSubscriptionAdapter(() => client)
    const project = tempHome('mousse-claude-project-')
    writeFileSync(join(project, 'AGENTS.md'), 'PROJECT RULES')
    await adapter.startTurn(input({ cwd: project }), sink(), control, host(MCP))
    writeFileSync(join(project, 'AGENTS.md'), 'UPDATED RULES')
    await adapter.startTurn(input({ cwd: project }), sink(), control, host(null))
    await adapter.startTurn(input({ cwd: tempHome('mousse-claude-bare-') }), sink(), control, host(null))
    await adapter.startTurn(input({ cwd: null }), sink(), control, { ...host(null), bridge: undefined })
    // The server and the turn token are passed through only when the bridge attaches the server.
    expect(seen[0].mcp).toEqual(MCP)
    expect(seen[0].mcpTurnToken).toBe('turn-1')
    for (const chat of seen.slice(1)) {
      expect(chat.mcp).toBeNull()
      expect(chat.mcpTurnToken).toBeUndefined()
    }
    // Claude Code loads the project's instruction files itself; Mousse adds only its own guidance.
    expect(seen[0].systemPromptAppend).toBe(mousseOrchestrationInstructions())
    for (const chat of seen.slice(1)) expect(chat.systemPromptAppend).toBeUndefined()
    // A projectless thread runs in Mousse's own standalone workspace.
    expect(seen[3]).toMatchObject({ cwd: standalone })
  })

  it('the adapter resolves the user\'s MCP servers and skills for the turn\'s project', async () => {
    const seen: ClaudeSubscriptionChatInput[] = []
    const client: ClaudeSubscriptionClient = {
      chat: vi.fn(async (chat: ClaudeSubscriptionChatInput) => { seen.push(chat); return 'ok' }),
      commitConversation: vi.fn(),
      standaloneWorkspace: () => '/standalone',
      configured: () => true
    }
    const integrations = { mcpServers: { files: { type: 'stdio' as const, command: 'files-mcp' } }, proxiedServers: {}, env: {}, toolRules: {}, pluginPath: '/plugin', warnings: [] }
    const resolve = vi.fn(async (_projectPath?: string) => integrations)
    const adapter = new ClaudeSubscriptionAdapter(() => client, () => ({ resolve }))
    await adapter.startTurn(input({ cwd: '/project' }), sink(), control, host(MCP))
    await adapter.startTurn(input({ cwd: null }), sink(), control, host(null))
    expect(resolve.mock.calls).toEqual([['/project'], [undefined]])
    expect(seen.map((chat) => chat.integrations)).toEqual([integrations, integrations])
    // A failing registry does not block the turn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = new ClaudeSubscriptionAdapter(() => client, () => ({ resolve: async () => { throw new Error('registry down') } }))
    await failing.startTurn(input(), sink(), control, host(null))
    expect(seen[2].integrations).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry down'))
    warn.mockRestore()
  })

  const service = (query: (input: { options: Options; prompt: unknown }) => Query) => {
    const home = tempHome('mousse-mcp-claude-')
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const questions = new UserQuestionService()
    const runAuth = vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    return { home, questions, service: new ClaudeSubscriptionProviderService(home, questions, { query, runAuth }) }
  }
  /** A query that asks for a Mousse tool permission mid-turn, then finishes. */
  const decisions: unknown[] = []
  const finished = (options: Options) => Object.assign((async function* () {
    decisions.push(await options.canUseTool?.('mcp__mousse__delegate_task', { prompt: 'x' }, { signal: new AbortController().signal } as never))
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }
  })(), { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query

  it('the service builds mcpServers.mousse with the bearer header, the system prompt, and allows Mousse tools without a prompt', async () => {
    const options: Options[] = []
    const { home, questions, service: claude } = service(({ options: o }) => { options.push(o); return finished(o) })
    const ask = vi.spyOn(questions, 'requestAnswers')
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }))
    await claude.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn(), mcp: MCP, systemPromptAppend: 'GUIDE' })
    await claude.chat({ threadId: 't2', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn() })
    expect(options[0].mcpServers).toEqual({
      mousse: { type: 'http', url: MCP.url, headers: { Authorization: 'Bearer tok-secret' }, timeout: 3_600_000 }
    })
    expect(options[0].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'GUIDE' })
    expect(options[0]).not.toHaveProperty('settingSources')
    expect(options[0].extraArgs?.['strict-mcp-config']).toBeUndefined()
    expect(decisions[0]).toMatchObject({ behavior: 'allow' })
    expect(ask).toHaveBeenCalledTimes(1)
    // Without the server the same name is an ordinary tool and goes to the user.
    expect(ask.mock.calls[0][0][0].prompt).toMatch(/mcp__mousse__delegate_task/)
    expect(decisions[1]).toMatchObject({ behavior: 'deny' })
    expect(options[1].mcpServers).toEqual({})
    expect(options[1].systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(claudeMcpServers(null)).toEqual({})
  })

  it('the service launches Claude with the user\'s MCP servers, their secrets, the skills plugin and tool limits', async () => {
    const options: Options[] = []
    const { home, questions, service: claude } = service(({ options: o }) => { options.push(o); return finished(o) })
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }))
    await claude.chat({
      threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn(), mcp: MCP,
      integrations: {
        mcpServers: {
          files: { type: 'stdio', command: 'files-mcp', env: { API_KEY: '${MOUSSE_MCP_VALUE_0}' } },
          mousse: { type: 'stdio', command: 'impostor' }
        },
        proxiedServers: { linear: { tools: [{ name: 'get' }], call: vi.fn() }, mousse: { tools: [], call: vi.fn() } },
        env: { MOUSSE_MCP_VALUE_0: 'resolved-key' },
        toolRules: { mcp__files__: { enabled: ['read'] } },
        pluginPath: '/generated/plugin',
        warnings: []
      }
    })
    await claude.chat({ threadId: 't2', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn() })
    expect(options[0].mcpServers).toEqual({
      files: { type: 'stdio', command: 'files-mcp', env: { API_KEY: '${MOUSSE_MCP_VALUE_0}' } },
      linear: { type: 'sdk', name: 'linear', instance: expect.anything() },
      mousse: { type: 'http', url: MCP.url, headers: { Authorization: 'Bearer tok-secret' }, timeout: 3_600_000 }
    })
    expect(options[0].env).toMatchObject({ MOUSSE_MCP_VALUE_0: 'resolved-key' })
    expect(options[0].plugins).toEqual([{ type: 'local', path: '/generated/plugin' }])
    expect(options[0]).not.toHaveProperty('settingSources')
    expect(options[0].extraArgs?.['strict-mcp-config']).toBeUndefined()
    const hook = options[0].hooks!.PreToolUse![0].hooks[0]
    const call = (tool_name: string) => hook(
      { hook_event_name: 'PreToolUse', tool_name, tool_input: {}, tool_use_id: 'u' } as never, 'u', { signal: new AbortController().signal }
    )
    expect(await call('mcp__files__write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await call('mcp__files__read')).toEqual({})
    expect(options[1].mcpServers).toEqual({})
    expect(options[1].plugins).toBeUndefined()
    expect(options[1].env).not.toHaveProperty('MOUSSE_MCP_VALUE_0')
  })

  it('Mousse\'s PreToolUse hook stamps each Mousse call with the turn token (per_call), and nothing else', async () => {
    const options: Options[] = []
    const { home, questions, service: claude } = service(({ options: o }) => { options.push(o); return finished(o) })
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }))
    await claude.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn(), mcp: MCP, mcpTurnToken: 'turn-7' })
    await claude.chat({ threadId: 't2', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn(), mcp: MCP, mcpTurnToken: 'turn-8', mode: 'plan' })
    await claude.chat({ threadId: 't3', cwd: home, model: 'sonnet', prompt: 'hi', onText: vi.fn() })
    const hook = (index: number, tool_name: string) => options[index].hooks!.PreToolUse![0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_name, tool_input: { limit: 5 }, tool_use_id: 'u' } as never, 'u', { signal: new AbortController().signal }
    )
    // The spike (`claudeUpdatedInputSpike.test.ts`) shows Claude Code forwards `updatedInput` to the server.
    expect(await hook(0, 'mcp__mousse__thread_read')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { limit: 5, _mousse_turn: 'turn-7' } }
    })
    expect(await hook(0, 'Read')).toEqual({})
    // A plan turn routes every call through canUseTool (`ask`), stamped all the same.
    expect(await hook(1, 'mcp__mousse__thread_read')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: { limit: 5, _mousse_turn: 'turn-8' } }
    })
    expect(await hook(1, 'Read')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
    // Without the server, the same name is not Mousse's and is left as it is.
    expect(await hook(2, 'mcp__mousse__thread_read')).toEqual({})
  })
})

type Sent = { method: string; params: Record<string, unknown> }

/**
 * A fake ACP agent process; `http` is what its initialize advertises. It is the service's
 * `AcpConnectionFactory`: the core records the launch-settings generation itself.
 */
function fakeAcp(http: boolean, sent: Sent[]) {
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
            if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http } } }
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

describe('Antigravity attachment', () => {
  it('the Antigravity adapter passes the server and the session text only when the bridge attaches one', async () => {
    const seen: Array<Parameters<AntigravityClient['chat']>[0]> = []
    const client: AntigravityClient = { chat: vi.fn(async (chat) => { seen.push(chat); return 'ok' }), commitConversation: vi.fn(), configured: () => true }
    const adapter = antigravityAdapter(() => client)
    await adapter.startTurn(input({ llmProvider: 'antigravity' }), sink(), control, host(MCP))
    await adapter.startTurn(input({ llmProvider: 'antigravity' }), sink(), control, host(null))
    expect(seen[0]).toMatchObject({ mcp: MCP, orchestrationInstructions: mousseOrchestrationInstructions() })
    expect(seen[1].mcp).toBeNull()
    expect(seen[1].orchestrationInstructions).toBeUndefined()
  })

  const service = (http: boolean, sent: Sent[], connect: () => unknown = fakeAcp(http, sent)) => {
    const home = tempHome('mousse-mcp-acp-')
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const antigravity = new AntigravityProviderService(home, home, new UserQuestionService(), undefined, { connect: connect as never })
    Object.assign(antigravity as unknown as Record<string, unknown>, { configured: () => true })
    return { antigravity, workspace }
  }
  const prompts = (sent: Sent[]) => sent.filter((frame) => frame.method === 'session/prompt')
    .map((frame) => ((frame.params.prompt as Array<{ text: string }>)[0]).text)

  it('attaches an http server when the agent advertises http, with the guidance in the first prompt only', async () => {
    const sent: Sent[] = []
    const { antigravity, workspace } = service(true, sent)
    const chat = { threadId: 't', cwd: workspace, model: 'm1', onText: vi.fn() }
    await antigravity.chat({ ...chat, prompt: 'first', mcp: MCP, orchestrationInstructions: 'GUIDE' })
    const created = sent.find((frame) => frame.method === 'session/new')!
    expect(created.params.mcpServers).toEqual([{ name: 'mousse', type: 'http', url: MCP.url, headers: [{ name: 'Authorization', value: 'Bearer tok-secret' }] }])
    expect(prompts(sent)[0]).toBe('<mousse_orchestration_instructions>\nGUIDE\n</mousse_orchestration_instructions>\n\nfirst')

    // After a revocation the thread's token changes: the session is reopened (resumed) with the new
    // one; the guidance is not repeated.
    antigravity.commitConversation('t', 'history-1')
    sent.length = 0
    await antigravity.chat({ ...chat, prompt: 'second', history: 'history-1', mcp: { ...MCP, token: 'tok-2' }, orchestrationInstructions: 'GUIDE' })
    const resumed = sent.find((frame) => frame.method === 'session/resume')!
    expect(resumed.params.mcpServers).toEqual([{ name: 'mousse', type: 'http', url: MCP.url, headers: [{ name: 'Authorization', value: 'Bearer tok-2' }] }])
    expect(prompts(sent)).toEqual(['second'])
    await antigravity.stop()
  })

  it('reuses the live agent process and ACP session across turns while the thread token is stable', async () => {
    const sent: Sent[] = []
    const launch = vi.fn(fakeAcp(true, sent))
    const { antigravity, workspace } = service(true, sent, launch)
    const chat = { threadId: 't', cwd: workspace, model: 'm1', onText: vi.fn(), mcp: MCP, orchestrationInstructions: 'GUIDE' }
    await antigravity.chat({ ...chat, prompt: 'first' })
    antigravity.commitConversation('t', 'history-1')
    await antigravity.chat({ ...chat, prompt: 'second', history: 'history-1' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(sent.filter((frame) => frame.method === 'initialize')).toHaveLength(1)
    expect(sent.filter((frame) => frame.method === 'session/new' || frame.method === 'session/resume')).toHaveLength(1)
    expect(prompts(sent)).toEqual(['<mousse_orchestration_instructions>\nGUIDE\n</mousse_orchestration_instructions>\n\nfirst', 'second'])
    await antigravity.stop()
  })

  it('a turn\'s permission requests are answered by its bridge\'s prompter', async () => {
    const sent: Sent[] = []
    const asked: string[] = []
    let handlers: { requestPermission(request: unknown): Promise<unknown> } | undefined
    const connect = (request: { handlers: typeof handlers }) => {
      handlers = request.handlers
      const process = fakeAcp(true, sent)() as { connection: { agent: { request: (method: string, params: Record<string, unknown>) => Promise<unknown> } } }
      const base = process.connection.agent.request
      process.connection.agent.request = async (method, params) => {
        if (method === 'session/prompt') answers.push(await handlers!.requestPermission({
          sessionId: 'acp-session',
          toolCall: { toolCallId: 'c1', title: 'Edit file' },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
        }))
        return base(method, params)
      }
      return process
    }
    const answers: unknown[] = []
    const { antigravity, workspace } = service(true, sent, connect as never)
    const prompter = { choose: async ({ title }: { title: string }) => { asked.push(title); return 'yes' } }
    await antigravity.chat({ threadId: 't', cwd: workspace, model: 'm1', prompt: 'go', onText: vi.fn(), prompter })
    expect(asked).toHaveLength(1)
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'yes' } }])
    await antigravity.stop()
  })

  it('a resumed session made with other instructions gets the new text in its next prompt, once', async () => {
    const sent: Sent[] = []
    const { antigravity, workspace } = service(true, sent)
    const chat = { threadId: 't', cwd: workspace, model: 'm1', onText: vi.fn(), mcp: MCP }
    await antigravity.chat({ ...chat, prompt: 'first', orchestrationInstructions: 'GUIDE' })
    antigravity.commitConversation('t', 'history-1')
    sent.length = 0
    // A new token reopens (resumes) the session; the instructions changed since it was made.
    await antigravity.chat({ ...chat, prompt: 'second', history: 'history-1', mcp: { ...MCP, token: 'tok-2' }, orchestrationInstructions: 'GUIDE 2' })
    expect(sent.some((frame) => frame.method === 'session/resume')).toBe(true)
    expect(prompts(sent)).toEqual(['<mousse_orchestration_instructions>\nGUIDE 2\n</mousse_orchestration_instructions>\n\nsecond'])
    antigravity.commitConversation('t', 'history-2')
    sent.length = 0
    await antigravity.chat({ ...chat, prompt: 'third', history: 'history-2', mcp: { ...MCP, token: 'tok-2' }, orchestrationInstructions: 'GUIDE 2' })
    expect(prompts(sent)).toEqual(['third'])
    await antigravity.stop()
  })

  it('falls back to the stdio bridge when the agent does not advertise http; the token stays out of argv', async () => {
    const sent: Sent[] = []
    const { antigravity, workspace } = service(false, sent)
    await antigravity.chat({ threadId: 't', cwd: workspace, model: 'm1', prompt: 'go', onText: vi.fn(), mcp: MCP })
    const [server] = sent.find((frame) => frame.method === 'session/new')!.params.mcpServers as Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>
    expect(server.name).toBe('mousse')
    expect(server.args.slice(-4)).toEqual(['engine', 'mcp-stdio', '--url', MCP.url])
    expect(server.args).not.toContain(MCP.token)
    expect(server.env).toContainEqual({ name: MOUSSE_MCP_TOKEN_ENV, value: MCP.token })
    await antigravity.stop()
  })

  it('attaches nothing without host.mcp', async () => {
    const sent: Sent[] = []
    const { antigravity, workspace } = service(true, sent)
    await antigravity.chat({ threadId: 't', cwd: workspace, model: 'm1', prompt: 'plain', onText: vi.fn() })
    expect(sent.find((frame) => frame.method === 'session/new')!.params.mcpServers).toEqual([])
    expect(prompts(sent)).toEqual(['plain'])
    expect(acpMcpServers(null, { http: true })).toEqual([])
    await antigravity.stop()
  })
})

describe('CLI children (AgentConfigManager)', () => {
  const manager = (mcpEnabled = false) => new AgentConfigManager(
    { discover: async () => ({ servers: [], sources: [], diagnostics: [] }) } as unknown as McpRegistry,
    { discover: async () => ({ skills: [], sources: [], diagnostics: [] }) } as unknown as SkillsRegistry,
    { get: () => ({ integrations: { mcp: { enabled: mcpEnabled, enableForAgents: {} }, skills: { enabled: false, enableForAgents: {} } } }) } as unknown as SettingsStore
  )

  it('materialises a mousse http entry with the token moved into env, and removes it on cleanup', async () => {
    const root = tempHome('mousse-mcp-cli-')
    const worktree = join(root, 'worktree')
    mkdirSync(worktree)
    const configs = manager()
    const result = await configs.prepare('agent-1', 'claude-code', worktree, root, undefined, { mousse: MCP })
    const written = readFileSync(join(worktree, '.mcp.json'), 'utf8')
    expect(written).not.toContain(MCP.token)
    const entry = JSON.parse(written).mcpServers.mousse
    expect(entry).toMatchObject({ url: MCP.url, transport: 'http' })
    const reference = /^\$\{env:(\w+)\}$/.exec(entry.headers.Authorization)!
    expect(result.env[reference[1]]).toBe('Bearer tok-secret')
    await configs.cleanup('agent-1')
    expect(() => readFileSync(join(worktree, '.mcp.json'), 'utf8')).toThrow()

    const none = await manager().prepare('agent-2', 'claude-code', worktree, root)
    expect(none.generatedFiles).toEqual([])
    expect(() => readFileSync(join(worktree, '.mcp.json'), 'utf8')).toThrow()
  })
})
