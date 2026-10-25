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
  // A read-only subagent may start (read-only) subagents; `delegate_task` itself limits them to read-only ones.
  const MOUSSE_READS = ['mcp__mousse__thread_read', 'mcp__mousse__queue_list', 'mcp__mousse__ask_user', 'mcp__mousse__present_plan', 'mcp__mousse__delegate_task', 'mcp__mousse__task_status', 'mcp__mousse__task_cancel', 'mcp__mousse__list_delegations']
  const MOUSSE_WRITES = ['mcp__mousse__queue_enqueue', 'mcp__mousse__thread_fork', 'mcp__mousse__thread_merge_back', 'mcp__mousse__integrate_delegation', 'mcp__mousse__create_task']
  const WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'BashOutput']
  const EXTERNAL = ['mcp__userserver__lookup', 'mcp__oauthserver__post']
  const NATIVE_SUBAGENT = ['Agent', 'Task']

  it.each([
    ['not a subagent', undefined, [...READ_ONLY_BUILTINS, ...MOUSSE_READS, ...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL, ...NATIVE_SUBAGENT], []],
    ['isolated child', ISOLATED, [...READ_ONLY_BUILTINS, ...MOUSSE_READS, ...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL, ...NATIVE_SUBAGENT], []],
    // A subagent may start subagents, so Claude's own subagent tool stays available; its calls pass the same hook.
    ['shared child', SHARED, [...READ_ONLY_BUILTINS, ...MOUSSE_READS, ...NATIVE_SUBAGENT], [...MOUSSE_WRITES, ...WRITERS, ...EXTERNAL]]
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
  const PROBES = ['Bash', 'Write', 'Agent', 'Task', 'mcp__userserver__lookup', 'Read', 'mcp__mousse__thread_read', 'mcp__mousse__thread_fork', 'mcp__mousse__delegate_task', 'mcp__mousse__integrate_delegation']
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

  it('a shared child keeps the default permission mode and is denied writes, shell, external MCP tools and thread-writing tools, first and resumed', async () => {
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
    // Agent and Task (a subagent starting its own subagents) and delegate_task go to the callback like any allowed call.
    const hook = { Bash: 'deny', Write: 'deny', Agent: 'ask', Task: 'ask', mcp__userserver__lookup: 'deny', mcp__mousse__thread_fork: 'deny', mcp__mousse__integrate_delegation: 'deny', Read: 'ask', mcp__mousse__thread_read: 'ask', mcp__mousse__delegate_task: 'ask' }
    const canUse = { Bash: 'deny', Write: 'deny', Agent: 'allow', Task: 'allow', mcp__userserver__lookup: 'deny', mcp__mousse__thread_fork: 'deny', mcp__mousse__integrate_delegation: 'deny', Read: 'allow', mcp__mousse__thread_read: 'allow', mcp__mousse__delegate_task: 'allow' }
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

  it('an isolated child keeps write access, every MCP server and the native subagent tool, first and resumed', async () => {
    const { service, options, input } = fixture()
    await service.chat(input({ child: ISOLATED }))
    service.commitConversation('child', 'history')
    await service.chat(input({ child: ISOLATED, history: 'history' }))
    for (const turn of options) {
      expect(turn).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
      untouched(turn)
    }
    const hook = { Agent: 'none', Task: 'none', Bash: 'none', Write: 'none', mcp__userserver__lookup: 'none', Read: 'none', mcp__mousse__thread_read: 'none', mcp__mousse__thread_fork: 'none', mcp__mousse__delegate_task: 'none', mcp__mousse__integrate_delegation: 'none' }
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
  function server(options: { approvalRequests?: boolean; pages?: Feature[][]; mcpServers?: Record<string, { enabled?: boolean } | null>; layers?: Array<{ disabledReason: string | null; config?: unknown }>; configFails?: boolean; onTurnStart?: (send: (value: unknown) => void) => void; onInterrupt?: (send: (value: unknown) => void, params: Record<string, unknown>) => void } = {}) {
    const messages: Message[] = []
    let latest: PassThrough | undefined
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
      latest = stdout
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
          const reply: Record<string, unknown> =
            message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } }
            : message.method === 'account/read' ? { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }
            : message.method === 'config/read' ? (options.configFails ? { error: { code: -32603, message: 'unreadable' } } : { result: { config: { mcp_servers: options.mcpServers ?? {} }, layers: options.layers ?? [] } })
            : ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) ? thread
            : message.method === 'turn/start' ? { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
            : { result: {} }
          send({ id: message.id, ...reply })
          if (message.method === 'turn/interrupt') options.onInterrupt?.(send, message.params ?? {})
          if (message.method === 'turn/start' && options.onTurnStart) options.onTurnStart(send)
          else if (message.method === 'turn/start') {
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
    return { launch: launch as (spec: CodexLaunch) => CodexProcess, messages, emit: (value: unknown) => latest?.write(JSON.stringify(value) + '\n'), requests: (method: string) => messages.filter((message) => message.method === method) }
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
    const SHARED_REFUSED = 'shared_unsupported_for_provider'

    it.each([
      ['no MCP servers', {}, 'shared', null],
      ['no MCP servers', {}, 'isolated', null],
      ['a disabled server only', { mcpServers: { old: { enabled: false } } }, 'shared', null],
      ['a user MCP server', { mcpServers: { ext: { enabled: true } } }, 'shared', SHARED_REFUSED],
      ['a user MCP server whose enabled flag is unset', { mcpServers: { ext: {} } }, 'shared', SHARED_REFUSED],
      ['a Mousse-managed server named mousse counts as external', { mcpServers: { mousse: { enabled: true } } }, 'shared', SHARED_REFUSED],
      ['a user MCP server, isolated child', { mcpServers: { ext: { enabled: true } } }, 'isolated', null],
      ['a server only in an applied config layer (project)', { layers: [{ disabledReason: null, config: { mcp_servers: { projsrv: {} } } }] }, 'shared', SHARED_REFUSED],
      ['a server in a layer Codex switched off (untrusted project)', { layers: [{ disabledReason: 'trust this project', config: { mcp_servers: { projsrv: {} } } }] }, 'shared', null],
      ['an unreadable config, shared child', { configFails: true }, 'shared', SHARED_REFUSED],
      ['an unreadable config, isolated child', { configFails: true }, 'isolated', null]
    ] as const)('%s (%s workspace)', async (_name, setup, workspace, code) => {
      const s = server(setup)
      expect((await preflight(s, workspace))?.code ?? null).toBe(code)
      // It only reads the user's setup, and it never looks at Codex's own subagent flags.
      expect(s.messages.map((message) => message.method).filter((method) => /write|set|batch|experimentalFeature/i.test(method ?? ''))).toEqual([])
    })

    it("leaves Codex's native subagents alone: no refusal whatever the config", async () => {
      for (const workspace of ['shared', 'isolated'] as const) expect((await preflight(server(), workspace))?.code ?? null).toBeNull()
    })

    it('names the servers and points to isolated', async () => {
      const refusal = await preflight(server({ mcpServers: { ext: {}, other: {} } }), 'shared')
      expect(refusal?.message).toContain('ext, other')
      expect(refusal?.message).toContain('"isolated"')
    })
  })

  describe("native helpers (Codex's own subagents) of a child's turn", () => {
    const PARENT = 'thr-1'
    const HELPER = 'helper-1'
    const completed = (threadId: string, id: string, status = 'completed') => ({ method: 'turn/completed', params: { threadId, turn: { id, status, error: null } } })
    const spawned = (kind: 'subAgentActivity' | 'collabAgentToolCall') => ({
      method: 'item/completed',
      params: {
        threadId: PARENT,
        turnId: 'turn-1',
        item:
          kind === 'subAgentActivity'
            ? { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: HELPER }
            : { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed', receiverThreadIds: [HELPER], agentsStates: { [HELPER]: { status: 'running', message: null } } }
      }
    })
    const helperTurn = { method: 'turn/started', params: { threadId: HELPER, turn: { id: 'h-turn-1', status: 'inProgress', error: null } } }
    const interrupts = (s: ReturnType<typeof server>) => s.requests('turn/interrupt').map((message) => `${message.params!.threadId}/${message.params!.turnId}`)
    const state = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled', () => 'rejected'), new Promise((done) => setTimeout(() => done('pending'), 150))])
    const interruptReply = (send: (value: unknown) => void, params: Record<string, unknown>) =>
      send(completed(params.threadId as string, params.threadId === HELPER ? 'h-turn-1' : 'turn-1', 'interrupted'))

    /** The parent spawns a helper and completes its own turn at once; the helper goes on. */
    const parentCompletesFirst = (kind: 'subAgentActivity' | 'collabAgentToolCall') => (send: (value: unknown) => void) =>
      setImmediate(() => {
        send(spawned(kind))
        send(helperTurn)
        send(completed(PARENT, 'turn-1'))
      })

    it.each(['subAgentActivity', 'collabAgentToolCall'] as const)('the child run does not complete while a helper (%s) is still running, and completes when it finishes', async (kind) => {
      let finishHelper: () => void = () => undefined
      const s = server({
        onTurnStart: (send) => {
          finishHelper = () => send(completed(HELPER, 'h-turn-1'))
          parentCompletesFirst(kind)(send)
        }
      })
      const running = chat(create(s), { child: SHARED })
      expect(await state(running)).toBe('pending')
      expect(interrupts(s)).toEqual([])
      finishHelper()
      await expect(running).resolves.toMatchObject({ codexThreadId: PARENT })
    })

    it('a child with no helper completes as soon as its own turn does', async () => {
      await expect(chat(create(server()), { child: SHARED })).resolves.toMatchObject({ codexThreadId: PARENT })
    })

    it("a helper that finished before the parent's item named it does not hold the run", async () => {
      const s = server({
        onTurnStart: (send) =>
          setImmediate(() => {
            send(helperTurn)
            send(completed(HELPER, 'h-turn-1'))
            send(spawned('subAgentActivity'))
            send(completed(PARENT, 'turn-1'))
          })
      })
      await expect(chat(create(s), { child: SHARED })).resolves.toMatchObject({ codexThreadId: PARENT })
    })

    it('a helper that went idle after being active ends the wait', async () => {
      let idle: () => void = () => undefined
      const s = server({
        onTurnStart: (send) => {
          idle = () => send({ method: 'thread/status/changed', params: { threadId: HELPER, status: { type: 'idle' } } })
          parentCompletesFirst('subAgentActivity')(send)
        }
      })
      const running = chat(create(s), { child: SHARED })
      expect(await state(running)).toBe('pending')
      idle()
      await expect(running).resolves.toBeTruthy()
    })

    it('Stop while the run waits for its helper interrupts the helper and ends the run', async () => {
      const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity'), onInterrupt: (send, params) => params.threadId === HELPER && interruptReply(send, params) })
      const stop = new AbortController()
      const running = chat(create(s), { child: SHARED, signal: stop.signal })
      expect(await state(running)).toBe('pending')
      stop.abort(new Error('Stopped'))
      await expect(running).rejects.toThrow('Stopped')
      // The parent's turn was already complete; only the helper is interrupted.
      await vi.waitFor(() => expect(interrupts(s)).toEqual([`${HELPER}/h-turn-1`]))
    })

    it("Stop during the parent's turn interrupts the parent and its helper", async () => {
      const s = server({
        onTurnStart: (send) =>
          setImmediate(() => {
            send(spawned('subAgentActivity'))
            send(helperTurn)
          }),
        onInterrupt: interruptReply
      })
      const stop = new AbortController()
      const running = chat(create(s), { child: ISOLATED, signal: stop.signal })
      running.catch(() => undefined)
      await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
      await new Promise((done) => setTimeout(done, 80))
      stop.abort(new Error('Stopped'))
      await expect(running).rejects.toThrow()
      await vi.waitFor(() => expect([...interrupts(s)].sort()).toEqual([`${HELPER}/h-turn-1`, `${PARENT}/turn-1`].sort()))
    })

    it('a helper whose turn starts after Stop is interrupted as soon as its turn id is known', async () => {
      const s = server({ onTurnStart: (send) => setImmediate(() => send(spawned('subAgentActivity'))), onInterrupt: interruptReply })
      const stop = new AbortController()
      const running = chat(create(s), { child: ISOLATED, signal: stop.signal })
      running.catch(() => undefined)
      await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
      await new Promise((done) => setTimeout(done, 80))
      stop.abort(new Error('Stopped'))
      await expect(running).rejects.toThrow()
      expect(interrupts(s)).not.toContain(`${HELPER}/h-turn-1`)
      s.emit(helperTurn)
      await vi.waitFor(() => expect(interrupts(s)).toContain(`${HELPER}/h-turn-1`))
    })

    it('a failed parent turn stops the helpers it started', async () => {
      const s = server({
        onTurnStart: (send) =>
          setImmediate(() => {
            send(spawned('subAgentActivity'))
            send(helperTurn)
            send(completed(PARENT, 'turn-1', 'failed'))
          })
      })
      await expect(chat(create(s), { child: SHARED })).rejects.toThrow()
      await vi.waitFor(() => expect(interrupts(s)).toEqual([`${HELPER}/h-turn-1`]))
    })

    it('a message on the thread right after Stop is not blocked by a helper that ignores its interrupt', async () => {
      const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity') })
      const service = create(s)
      const stop = new AbortController()
      const first = chat(service, { child: SHARED, signal: stop.signal })
      first.catch(() => undefined)
      expect(await state(first)).toBe('pending')
      stop.abort(new Error('Stopped'))
      await expect(first).rejects.toThrow('Stopped')
      service.commitConversation('child', '')
      // Same parent thread, helper still running and ignoring the interrupt: the next turn starts at once.
      const again = new AbortController()
      const second = chat(service, { child: SHARED, signal: again.signal })
      second.catch(() => undefined)
      await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2), { timeout: 3_000 })
      again.abort(new Error('Stopped'))
      await expect(second).rejects.toThrow('Stopped')
    })

    describe('idle cap', () => {
      const withCaps = (s: ReturnType<typeof server>, caps: { helperIdleCapMs?: number; helperPinCapMs?: number }) => {
        mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
        writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: join(home, 'codex') }))
        const service = new CodexProviderService(home, questions, { launch: s.launch, ...caps })
        services.push(service)
        return service
      }

      it('a helper silent past the idle cap is stopped and the run ends done with its own text and a note', async () => {
        const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity'), onInterrupt: (send, params) => params.threadId === HELPER && interruptReply(send, params) })
        const texts: string[] = []
        const result = await chat(withCaps(s, { helperIdleCapMs: 60 }), { child: SHARED, onText: (text) => texts.push(text) })
        expect(result.text).toBe('Some helpers were abandoned after 1 minute without activity')
        expect(texts.at(-1)).toBe(result.text)
        expect(interrupts(s)).toEqual([`${HELPER}/h-turn-1`])
      })

      it('the note follows the parent\'s own final text', async () => {
        const s = server({
          onTurnStart: (send) =>
            setImmediate(() => {
              send({ method: 'item/completed', params: { threadId: PARENT, turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'Here is what I found.' } } })
              send(spawned('subAgentActivity'))
              send(helperTurn)
              send(completed(PARENT, 'turn-1'))
            })
        })
        const result = await chat(withCaps(s, { helperIdleCapMs: 60 }), { child: SHARED })
        expect(result.text).toBe('Here is what I found.\n\nSome helpers were abandoned after 1 minute without activity')
      })

      it('a steer held in the same tick as the cap still gets its turn before the run ends with the note', async () => {
        let turns = 0
        const s = server({
          onTurnStart: (send) => {
            turns += 1
            if (turns === 1) parentCompletesFirst('subAgentActivity')(send)
            else setImmediate(() => send(completed(PARENT, 'turn-1')))
          }
        })
        const service = withCaps(s, { helperIdleCapMs: 60 })
        let pending: string | undefined
        // The cap and a steer land together: the wait reports the cap after the steer was held.
        vi.spyOn(service as unknown as { holdForHelpers(): Promise<string> }, 'holdForHelpers').mockImplementation(async () => {
          pending = 'one more thing'
          await new Promise((done) => setTimeout(done, 180))
          return 'Some helpers were abandoned after 1 minute without activity'
        })
        const result = await chat(service, { child: SHARED, drainSteer: () => { const text = pending; pending = undefined; return text } })
        expect(s.requests('turn/start').map((message) => (message.params!.input as Array<{ text: string }>)[0].text)).toEqual(['look', 'one more thing'])
        expect(result.text).toBe('Some helpers were abandoned after 1 minute without activity')
        expect(interrupts(s)).toEqual([`${HELPER}/h-turn-1`])
      })

      it('helper activity restarts the idle clock', async () => {
        const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity') })
        const running = chat(withCaps(s, { helperIdleCapMs: 150 }), { child: SHARED })
        for (let i = 0; i < 6; i += 1) {
          await new Promise((done) => setTimeout(done, 50))
          s.emit({ method: 'item/agentMessage/delta', params: { threadId: HELPER, itemId: 'm', delta: '.' } })
        }
        // 300ms in, past the cap if activity did not count; the helper has spoken within the last 50ms.
        expect(await Promise.race([running.then(() => 'ended'), new Promise((done) => setTimeout(() => done('open'), 20))])).toBe('open')
        await expect(running).resolves.toMatchObject({ text: expect.stringContaining('without activity') })
      })

      it('helpers that keep working are abandoned at the pin cap', async () => {
        const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity') })
        const running = chat(withCaps(s, { helperIdleCapMs: 10_000, helperPinCapMs: 200 }), { child: SHARED })
        const chatter = setInterval(() => s.emit({ method: 'item/agentMessage/delta', params: { threadId: HELPER, itemId: 'm', delta: '.' } }), 30)
        try {
          const result = await running
          expect(result.text).toBe('Some helpers were abandoned after 1 minute')
        } finally {
          clearInterval(chatter)
        }
        expect(interrupts(s)).toEqual([`${HELPER}/h-turn-1`])
      })

      it('a helper that finishes in time ends the run normally, without a note', async () => {
        const s = server({ onTurnStart: parentCompletesFirst('subAgentActivity') })
        const running = chat(withCaps(s, { helperIdleCapMs: 500 }), { child: SHARED })
        setTimeout(() => s.emit(completed(HELPER, 'h-turn-1')), 40)
        await expect(running).resolves.toMatchObject({ text: '' })
      })
    })

    describe('a steer that arrives while the run only waits for helpers', () => {
      it('starts a turn on the Codex thread with the steer text, then keeps waiting for the helper', async () => {
        let turns = 0
        let finishHelper: () => void = () => undefined
        const s = server({
          onTurnStart: (send) => {
            turns += 1
            if (turns === 1) {
              finishHelper = () => send(completed(HELPER, 'h-turn-1'))
              parentCompletesFirst('subAgentActivity')(send)
            } else setImmediate(() => send(completed(PARENT, 'turn-1')))
          }
        })
        let pending: string | undefined
        const steered: string[] = []
        const running = chat(create(s), { child: SHARED, drainSteer: () => { const text = pending; pending = undefined; return text }, onSteer: (text) => steered.push(text) })
        expect(await state(running)).toBe('pending')
        pending = 'also check the tests'
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        expect(s.requests('turn/start')[1].params!.input).toEqual([{ type: 'text', text: 'also check the tests', text_elements: [] }])
        expect(steered).toEqual(['also check the tests'])
        // The helper still holds the run open after the steer's turn.
        expect(await state(running)).toBe('pending')
        finishHelper()
        await expect(running).resolves.toMatchObject({ codexThreadId: PARENT })
      })
    })

    it('losing the process forgets the helpers of finished chats that still awaited a turn id', async () => {
      const s = server({ onTurnStart: (send) => setImmediate(() => send(spawned('subAgentActivity'))), onInterrupt: interruptReply })
      const stop = new AbortController()
      const service = create(s)
      const running = chat(service, { child: ISOLATED, signal: stop.signal })
      running.catch(() => undefined)
      await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
      await new Promise((done) => setTimeout(done, 80))
      stop.abort(new Error('Stopped'))
      await expect(running).rejects.toThrow()
      const orphans = (service as unknown as { orphans: Set<unknown> }).orphans
      expect(orphans.size).toBe(1)
      service.stop()
      await vi.waitFor(() => expect(orphans.size).toBe(0))
    })
  })
})
