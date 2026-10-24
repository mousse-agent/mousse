/**
 * Issue #142: a delegated child's policy per provider, on its first and its resumed turns. Shared
 * (read-only) children are held to read-only through permission decisions only; the user's MCP
 * servers, settings and config stay as configured. Isolated children keep their write access.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { claudeChildToolDenial } from '../src/mms/providers/claudeSubscription/childPolicy'
import type { ClaudeTurnIntegrations } from '../src/mms/providers/claudeSubscription/integrations'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { CodexLaunch, CodexProcess } from '../src/mms/providers/codex/CodexAppServerClient'
import { codexTurnPolicy } from '../src/mms/providers/codex/childPolicy'
import { CODEX_MODEL_PROVIDER, CodexProviderService, type CodexChatInput } from '../src/mms/providers/codex/CodexProviderService'
import { CodexAdapter } from '../src/mms/run/adapters/codex/CodexAdapter'
import type { ChildTurnPolicy } from '../src/mms/run/adapters/ProviderAdapter'

const SHARED: ChildTurnPolicy = { readOnly: true }
const ISOLATED: ChildTurnPolicy = { readOnly: false }
const MOUSSE = { url: 'http://127.0.0.1:9/mcp', token: 'tok' }

describe('policy table: permission decisions', () => {
  const READ_ONLY_BUILTINS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch']
  const MOUSSE_READS = ['mcp__mousse__thread_read', 'mcp__mousse__queue_list', 'mcp__mousse__ask_user', 'mcp__mousse__present_plan']
  const MOUSSE_WRITES = ['mcp__mousse__queue_enqueue', 'mcp__mousse__thread_fork', 'mcp__mousse__thread_merge_back', 'mcp__mousse__delegate_task', 'mcp__mousse__integrate_delegation', 'mcp__mousse__create_task']
  const WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'BashOutput']
  const EXTERNAL = ['mcp__userserver__lookup', 'mcp__oauthserver__post']
  const NATIVE_SUBAGENT = ['Agent', 'Task']

  it.each([
    ['not a subagent', undefined, [...READ_ONLY_BUILTINS, ...MOUSSE_READS, ...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL, ...NATIVE_SUBAGENT], []],
    ['isolated child', ISOLATED, [...READ_ONLY_BUILTINS, ...MOUSSE_READS, ...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL], NATIVE_SUBAGENT],
    ['shared child', SHARED, [...READ_ONLY_BUILTINS, ...MOUSSE_READS], [...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL, ...NATIVE_SUBAGENT]]
  ])('Claude tools for a %s', (_name, child, allowed, denied) => {
    for (const tool of allowed) expect(claudeChildToolDenial(child, tool), tool).toBeUndefined()
    for (const tool of denied) expect(claudeChildToolDenial(child, tool), tool).toEqual(expect.any(String))
  })

  it.each([
    ['agent turn', 'default', undefined, { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }],
    ['plan turn', 'plan', undefined, { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ['isolated child', 'default', ISOLATED, { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }],
    ['shared child', 'default', SHARED, { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ['shared child in plan mode', 'plan', SHARED, { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }]
  ] as const)('Codex sandbox and approvals for a %s', (_name, mode, child, expected) => {
    expect(codexTurnPolicy(mode, child)).toMatchObject(expected)
  })
})

describe('Claude Subscription children', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
    seen.length = 0
  })

  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'vendor-session' }
  const PROBES = ['Bash', 'Write', 'Agent', 'Task', 'mcp__userserver__lookup', 'Read', 'mcp__mousse__thread_read', 'mcp__mousse__thread_fork']
  /** What the PreToolUse hook and `canUseTool` said to each probe, asked while the turn runs (its controller aborts after). */
  const seen: Array<{ hook: Record<string, string>; canUse: Record<string, string> }> = []
  const fakeQuery = (options: Options) => {
    const generator = (async function* () {
      const hook: Record<string, string> = {}
      const canUse: Record<string, string> = {}
      const hooks = options.hooks!.PreToolUse![0].hooks
      for (const tool of PROBES) {
        const output = (await hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: `id-${tool}` } as never, `id-${tool}`, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } }
        hook[tool] = output.hookSpecificOutput?.permissionDecision ?? 'none'
        // A bypass turn asks the user for what it cannot approve itself; only restricted turns reach the callback in this test.
        if (options.permissionMode !== 'bypassPermissions') canUse[tool] = (await options.canUseTool!(tool, {}, { signal: new AbortController().signal } as never)).behavior
      }
      seen.push({ hook, canUse })
      yield result
    })()
    return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
  }
  const integrations: ClaudeTurnIntegrations = {
    mcpServers: { userserver: { type: 'stdio', command: 'user-mcp' } },
    proxiedServers: { oauthserver: { tools: [{ name: 'lookup' }], call: async () => ({ content: [], isError: false }) } as never },
    env: {},
    toolRules: {},
    warnings: []
  }

  const fixture = () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-claude-child-'))
    homes.push(home)
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const options: Options[] = []
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: (input) => {
        options.push(input.options)
        return fakeQuery(input.options)
      },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    const input = (patch: Partial<ClaudeSubscriptionChatInput> = {}): ClaudeSubscriptionChatInput => ({
      threadId: 'child', cwd: home, model: 'sonnet', prompt: 'look', onText: vi.fn(), mcp: MOUSSE, integrations, ...patch
    })
    return { service, options, input }
  }

  /** The user's setup is left alone: no tool lists, no strict MCP config, every server still passed. */
  const untouched = (turn: Options) => {
    for (const key of ['tools', 'disallowedTools', 'strictMcpConfig', 'settingSources', 'extraArgs']) expect(turn).not.toHaveProperty(key)
    expect(Object.keys(turn.mcpServers ?? {})).toEqual(expect.arrayContaining(['mousse', 'userserver', 'oauthserver']))
  }

  it('a shared child keeps the default permission mode and is denied writes, external MCP tools and native subagents, first and resumed', async () => {
    const { service, options, input } = fixture()
    await service.chat(input({ child: SHARED }))
    service.commitConversation('child', 'history')
    await service.chat(input({ child: SHARED, history: 'history' }))
    expect(options[1].resume).toBe('vendor-session')
    for (const turn of options) {
      // Not plan mode: that would inject the planning and ExitPlanMode flow into a research task.
      expect(turn.permissionMode).toBe('default')
      expect(turn).not.toHaveProperty('allowDangerouslySkipPermissions')
      untouched(turn)
    }
    const hook = { Bash: 'deny', Write: 'deny', Agent: 'deny', Task: 'deny', mcp__userserver__lookup: 'deny', mcp__mousse__thread_fork: 'deny', Read: 'ask', mcp__mousse__thread_read: 'ask' }
    const canUse = { Bash: 'deny', Write: 'deny', Agent: 'deny', Task: 'deny', mcp__userserver__lookup: 'deny', mcp__mousse__thread_fork: 'deny', Read: 'allow', mcp__mousse__thread_read: 'allow' }
    expect(seen).toEqual([{ hook, canUse }, { hook, canUse }])
  })

  it('the hook answers "ask" for a shared child exactly as for a plan turn, so the user\'s own allow rules cannot skip canUseTool', async () => {
    const plan = fixture()
    await plan.service.chat(plan.input({ mode: 'plan' }))
    const shared = fixture()
    await shared.service.chat(shared.input({ child: SHARED }))
    const [planSeen, sharedSeen] = seen
    // Every tool the read-only allowlist lets through is routed to canUseTool by an "ask" decision;
    // without it, an allow rule in the user's settings.json would approve the call before the
    // callback ran. The same decision for both kinds of turn.
    for (const tool of ['Read', 'mcp__mousse__thread_read']) {
      expect(planSeen.hook[tool], tool).toBe('ask')
      expect(sharedSeen.hook[tool], tool).toBe('ask')
    }
    expect(sharedSeen.canUse.Read).toBe('allow')
    expect(shared.options[0].canUseTool).toBeTypeOf('function')
    // A tool outside the allowlist is denied by the hook itself, which also beats an allow rule.
    for (const tool of ['Bash', 'Write', 'mcp__userserver__lookup', 'mcp__mousse__thread_fork']) expect(sharedSeen.hook[tool], tool).toBe('deny')
  })

  it('an isolated child keeps write access and every MCP server but is denied the native subagent tool, first and resumed', async () => {
    const { service, options, input } = fixture()
    await service.chat(input({ child: ISOLATED }))
    service.commitConversation('child', 'history')
    await service.chat(input({ child: ISOLATED, history: 'history' }))
    for (const turn of options) {
      expect(turn).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
      untouched(turn)
    }
    const hook = { Agent: 'deny', Task: 'deny', Bash: 'none', Write: 'none', mcp__userserver__lookup: 'none', Read: 'none', mcp__mousse__thread_read: 'none', mcp__mousse__thread_fork: 'none' }
    expect(seen).toEqual([{ hook, canUse: {} }, { hook, canUse: {} }])
  })

  it('a thread that is not a subagent is unchanged', async () => {
    const { service, options, input } = fixture()
    await service.chat(input())
    expect(options[0]).toMatchObject({ permissionMode: 'bypassPermissions' })
    expect(seen[0].hook.Agent).toBe('none')
    expect(seen[0].hook.Bash).toBe('none')
  })
})

describe('Codex children', () => {
  type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
  type Feature = { name: string; enabled: boolean; defaultEnabled: boolean }
  let home: string
  const services: CodexProviderService[] = []
  const questions = new UserQuestionService()

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-codex-child-'))
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
  })
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    rmSync(home, { recursive: true, force: true })
  })

  /** An app-server stand-in: a signed-in account, instant turns, and the feature pages in `pages`. */
  function server(options: { approvalRequests?: boolean; pages?: Feature[][]; mcpServers?: Record<string, { enabled?: boolean } | null>; layers?: Array<{ disabledReason: string | null; config?: unknown }>; configFails?: boolean; featuresFail?: boolean } = {}) {
    const messages: Message[] = []
    const pages = options.pages ?? [[{ name: 'multi_agent', enabled: false, defaultEnabled: true }]]
    const launch = (): CodexProcess => {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const process = Object.assign(new EventEmitter(), {
        stdin, stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals = 'SIGTERM') {
          if (process.signalCode) return false
          process.signalCode = signal
          setImmediate(() => process.emit('exit', null, signal))
          return true
        }
      })
      const send = (value: unknown) => stdout.write(JSON.stringify(value) + '\n')
      let pending = ''
      stdin.on('data', (chunk: Buffer) => {
        pending += chunk.toString()
        let end: number
        while ((end = pending.indexOf('\n')) !== -1) {
          const message = JSON.parse(pending.slice(0, end)) as Message
          pending = pending.slice(end + 1)
          messages.push(message)
          if (message.id === undefined || !message.method) continue
          const thread = { result: { thread: { id: 'thr-1' }, model: 'gpt-x', modelProvider: CODEX_MODEL_PROVIDER, cwd: home } }
          const page = Number((message.params?.cursor as string | undefined) ?? 0)
          const reply: Record<string, unknown> =
            message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } }
            : message.method === 'account/read' ? { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }
            : message.method === 'config/read' ? (options.configFails ? { error: { code: -32603, message: 'unreadable' } } : { result: { config: { mcp_servers: options.mcpServers ?? {} }, layers: options.layers ?? [] } })
            : message.method === 'experimentalFeature/list' && options.featuresFail ? { error: { code: -32603, message: 'unreadable' } }
            : message.method === 'experimentalFeature/list' ? { result: { data: pages[page], nextCursor: page + 1 < pages.length ? String(page + 1) : null } }
            : ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) ? thread
            : message.method === 'turn/start' ? { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
            : { result: {} }
          send({ id: message.id, ...reply })
          if (message.method === 'turn/start') {
            if (options.approvalRequests) {
              send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1', itemId: 'cmd-1', command: 'rm -rf build' } })
              send({ id: 98, method: 'item/fileChange/requestApproval', params: { threadId: 'thr-1', itemId: 'edit-1' } })
              send({ id: 97, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-1', serverName: 'ext', message: 'Allow ext.write?' } })
              send({ id: 96, method: 'item/permissions/requestApproval', params: { threadId: 'thr-1', itemId: 'perm-1' } })
            }
            setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed', error: null } } }))
          }
        }
      })
      return process as unknown as CodexProcess
    }
    return { launch: launch as (spec: CodexLaunch) => CodexProcess, messages, requests: (method: string) => messages.filter((message) => message.method === method) }
  }

  const create = (s: ReturnType<typeof server>) => {
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: join(home, 'codex') }))
    const service = new CodexProviderService(home, questions, { launch: s.launch })
    services.push(service)
    return service
  }
  const chat = (service: CodexProviderService, patch: Partial<CodexChatInput> = {}) =>
    service.chat({ threadId: 'child', cwd: home, model: 'gpt-x', prompt: 'look', onText: () => {}, mcp: MOUSSE, ...patch })
  /** The config Mousse sends: its own server and the pinned model provider, nothing of the user's changed. */
  const mousseOnly = { 'mcp_servers.mousse.url': MOUSSE.url, model_provider: CODEX_MODEL_PROVIDER }

  it('a shared child gets the read-only sandbox on every turn, first, loaded and resumed after a restart', async () => {
    const s = server()
    const service = create(s)
    await chat(service, { child: SHARED })
    const start = s.requests('thread/start')[0].params!
    expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })
    // The user's Codex config is not touched: only Mousse's own server and the provider pin.
    expect(Object.keys(start.config as object).filter((key) => !key.startsWith('mcp_servers.mousse.'))).toEqual(['model_provider'])
    expect(start.config).toMatchObject(mousseOnly)

    service.commitConversation('child', '')
    await chat(service, { child: SHARED })
    service.commitConversation('child', '')
    service.stop()
    const restarted = new CodexProviderService(home, questions, { launch: s.launch })
    services.push(restarted)
    await chat(restarted, { child: SHARED })
    expect(s.requests('thread/resume')[0].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })

    const turns = s.requests('turn/start')
    expect(turns).toHaveLength(3)
    for (const turn of turns) expect(turn.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    // The turns themselves never read or write the user's Codex config.
    expect(s.messages.map((message) => message.method)).not.toContain('config/read')
  })

  it('an isolated child keeps workspace-write; a thread that is not a subagent is unchanged', async () => {
    for (const child of [ISOLATED, undefined]) {
      const s = server()
      await chat(create(s), { child })
      expect(s.requests('thread/start')[0].params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
      expect(s.requests('thread/start')[0].params!.config).toMatchObject(mousseOnly)
      expect(s.requests('turn/start')[0].params).toMatchObject({ sandboxPolicy: { type: 'workspaceWrite' } })
    }
  })

  it('a shared child answers every approval with a denial itself and never asks in its hidden thread', async () => {
    const s = server({ approvalRequests: true })
    const asked = vi.spyOn(questions, 'requestAnswers')
    await chat(create(s), { child: SHARED })
    const reply = (id: number) => s.messages.find((message) => message.id === id)
    await vi.waitFor(() => expect(reply(96)).toBeTruthy())
    expect(reply(99)).toMatchObject({ result: { decision: 'decline' } })
    expect(reply(98)).toMatchObject({ result: { decision: 'decline' } })
    expect(reply(97)).toMatchObject({ result: { action: 'decline' } })
    expect(reply(96)).toMatchObject({ result: { permissions: {} } })
    expect(asked).not.toHaveBeenCalled()
    asked.mockRestore()
  })

  describe('preflight of the user setup (CodexAdapter.childPreflight)', () => {
    const preflight = (s: ReturnType<typeof server>, workspace: 'shared' | 'isolated') =>
      new CodexAdapter(() => create(s)).childPreflight({ workspace, cwd: home })
    const on = [[{ name: 'multi_agent', enabled: true, defaultEnabled: true }]]
    const off = [[{ name: 'multi_agent', enabled: false, defaultEnabled: true }, { name: 'multi_agent_v2', enabled: false, defaultEnabled: false }]]
    const SHARED_REFUSED = 'shared_unsupported_for_provider'
    const TARGET_REFUSED = 'provider_unsupported_for_subagents'

    it.each([
      ['no MCP servers, native subagents off', {}, 'shared', null],
      ['no MCP servers, native subagents off', {}, 'isolated', null],
      ['a disabled server only', { mcpServers: { old: { enabled: false } } }, 'shared', null],
      ['a user MCP server', { mcpServers: { ext: { enabled: true } } }, 'shared', SHARED_REFUSED],
      ['a user MCP server whose enabled flag is unset', { mcpServers: { ext: {} } }, 'shared', SHARED_REFUSED],
      ['a Mousse-managed server named mousse counts as external', { mcpServers: { mousse: { enabled: true } } }, 'shared', SHARED_REFUSED],
      ['a user MCP server, isolated child', { mcpServers: { ext: { enabled: true } } }, 'isolated', null],
      ['a server only in an applied config layer (project)', { layers: [{ disabledReason: null, config: { mcp_servers: { projsrv: {} } } }] }, 'shared', SHARED_REFUSED],
      ['a server in a layer Codex switched off (untrusted project)', { layers: [{ disabledReason: 'trust this project', config: { mcp_servers: { projsrv: {} } } }] }, 'shared', null],
      ['an unreadable config, shared child', { configFails: true }, 'shared', SHARED_REFUSED],
      ['an unreadable config, isolated child (nothing detected)', { configFails: true }, 'isolated', null],
      ['unreadable feature flags (nothing detected)', { featuresFail: true }, 'isolated', null]
    ] as const)('%s (%s workspace)', async (_name, setup, workspace, code) => {
      const s = server({ pages: off, ...setup })
      expect((await preflight(s, workspace))?.code ?? null).toBe(code)
      // It only reads the user's setup.
      expect(s.messages.map((message) => message.method).filter((method) => /write|set|batch/i.test(method ?? ''))).toEqual([])
    })

    it.each(['shared', 'isolated'] as const)('native subagents detected on refuses a %s child, whatever else is configured', async (workspace) => {
      const refusal = await preflight(server({ pages: on, configFails: true }), workspace)
      expect(refusal?.code).toBe(TARGET_REFUSED)
      expect(refusal?.message).toContain('features.multi_agent')
    })

    it.each([
      ['multi_agent_v2 on', [[{ name: 'multi_agent', enabled: false, defaultEnabled: true }, { name: 'multi_agent_v2', enabled: true, defaultEnabled: false }]], TARGET_REFUSED],
      ['on in a later page', [[{ name: 'apps', enabled: true, defaultEnabled: false }], [{ name: 'multi_agent', enabled: true, defaultEnabled: true }]], TARGET_REFUSED],
      ['an unrelated feature on', [[{ name: 'apps', enabled: true, defaultEnabled: false }, { name: 'multi_agent', enabled: false, defaultEnabled: true }]], null]
    ] as const)('feature flags: %s', async (_name, pages, code) => {
      expect((await preflight(server({ pages: pages as never }), 'isolated'))?.code ?? null).toBe(code)
    })

    it('names the servers and points to isolated', async () => {
      const refusal = await preflight(server({ pages: off, mcpServers: { ext: {}, other: {} } }), 'shared')
      expect(refusal?.message).toContain('ext, other')
      expect(refusal?.message).toContain('"isolated"')
    })
  })
})
