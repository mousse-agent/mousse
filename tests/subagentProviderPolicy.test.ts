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
import { QUESTIONS_REFUSED_MESSAGE } from '../src/mms/harness/acp/permissions'
import { claudeChildToolDenial } from '../src/mms/harness/vendors/claude/childPolicy'
import type { ClaudeTurnIntegrations } from '../src/mms/harness/vendors/claude/integrations'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { CodexLaunch, CodexProcess } from '../src/mms/harness/vendors/codex/CodexAppServerClient'
import { codexTurnPolicy } from '../src/mms/harness/vendors/codex/childPolicy'
import { CODEX_MODEL_PROVIDER, CodexProviderService, type CodexChatInput } from '../src/mms/harness/vendors/codex/CodexProviderService'
import { CodexAdapter } from '../src/mms/harness/drivers/codex/adapter'
import type { ChildTurnPolicy } from '../src/mms/harness/adapter'

const SHARED: ChildTurnPolicy = { readOnly: true }
const ISOLATED: ChildTurnPolicy = { readOnly: false }
const MOUSSE = { url: 'http://127.0.0.1:9/mcp', token: 'tok' }

describe('policy table: permission decisions', () => {
  const READ_ONLY_BUILTINS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch']
  // A read-only subagent may start (read-only) subagents; `delegate_task` itself limits them to read-only ones.
  const MOUSSE_READS = ['mcp__mousse__thread_read', 'mcp__mousse__queue_list', 'mcp__mousse__ask_user', 'mcp__mousse__present_plan', 'mcp__mousse__delegate_task', 'mcp__mousse__continue_subagent', 'mcp__mousse__answer_subagent', 'mcp__mousse__task_status', 'mcp__mousse__task_cancel', 'mcp__mousse__list_subagents']
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

  const READ_ONLY = { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  const SUPERVISED = { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  const FULL = { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  it.each([
    ['agent turn asking', 'default', undefined, 'ask', SUPERVISED],
    ['agent turn accepting edits', 'default', undefined, 'accept_edits', SUPERVISED],
    ['agent turn with full access', 'default', undefined, 'full', FULL],
    // A plan turn and a read-only child stay read-only whatever the permission mode says.
    ['plan turn', 'plan', undefined, 'full', READ_ONLY],
    ['isolated child asking', 'default', ISOLATED, 'ask', SUPERVISED],
    ['isolated child with full access', 'default', ISOLATED, 'full', FULL],
    ['shared child', 'default', SHARED, 'full', READ_ONLY],
    ['shared child in plan mode', 'plan', SHARED, 'ask', READ_ONLY]
  ] as const)('Codex sandbox and approvals for a %s', (_name, mode, child, permissionMode, expected) => {
    expect(codexTurnPolicy(mode, child, permissionMode)).toEqual(expected)
  })

  it('never sends a workspaceWrite policy on an interactive turn', () => {
    for (const permissionMode of ['ask', 'accept_edits', 'full'] as const)
      expect(codexTurnPolicy('default', undefined, permissionMode).sandboxPolicy.type).not.toBe('workspaceWrite')
  })
})

describe('Claude Subscription children', () => {
  const homes: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
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
    // The user's own Claude settings (which may forbid bypassing permissions) must not reach a test.
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude-config'))
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const options: Options[] = []
    const questions = new UserQuestionService()
    // A command or edit the mode asks about reaches the user; the probes reject it.
    questions.on('pending', ({ requestId }: { requestId: string }) => questions.submitAnswers(requestId, { permission: 'reject' }, { kind: 'user' }))
    const service = new ClaudeSubscriptionProviderService(home, questions, {
      launchConfig: () => ({ binaryPath: binary }),
      query: (input) => {
        options.push(input.options)
        return fakeQuery(input.options)
      },
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    const input = (patch: Partial<ClaudeSubscriptionChatInput> = {}): ClaudeSubscriptionChatInput => ({
      threadId: 'child', cwd: home, model: 'sonnet', prompt: 'look', permissionMode: 'full', onText: vi.fn(), mcp: MOUSSE, integrations, ...patch
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

  it('a child runs under its own permission mode: the hook asks for commands and edits the mode does not allow', async () => {
    const asking = fixture()
    await asking.service.chat(asking.input({ child: ISOLATED, permissionMode: 'ask' }))
    expect(asking.options[0]).toMatchObject({ permissionMode: 'default' })
    // The flag stays allowed on a live query so a later turn can switch to Full access; the mode itself is `default`.
    for (const tool of ['Bash', 'Write']) expect(seen[0].hook[tool], tool).toBe('ask')
    // A read-only built-in and an MCP tool follow Claude's own rules.
    for (const tool of ['Read', 'mcp__userserver__lookup']) expect(seen[0].hook[tool], tool).toBe('none')

    const accepting = fixture()
    await accepting.service.chat(accepting.input({ child: ISOLATED, permissionMode: 'accept_edits' }))
    expect(accepting.options[0]).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(seen[1].hook.Bash).toBe('ask')
    expect(seen[1].hook.Write).toBe('none')
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
  function server(options: {
    approvalRequests?: boolean
    pages?: Feature[][]
    mcpServers?: Record<string, { enabled?: boolean } | null>
    layers?: Array<{ disabledReason: string | null; config?: unknown }>
    configFails?: boolean
    onTurnStart?: (send: (value: unknown) => void, params: Record<string, unknown>) => void
    onInterrupt?: (send: (value: unknown) => void, params: Record<string, unknown>) => void
    /** Answers a request itself (a `{ result }` or `{ error }`), or leaves it to the default; may write notifications first. */
    answer?: (message: Message, send: (value: unknown) => void) => Record<string, unknown> | undefined
    /** The Codex thread ids `thread/start` hands out, in turn; `thr-1` after that. */
    threads?: string[]
  } = {}) {
    const messages: Message[] = []
    let latest: PassThrough | undefined
    let latestProcess: EventEmitter | undefined
    let started = 0
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
      latestProcess = process
      let pending = ''
      stdin.on('data', (chunk: Buffer) => {
        pending += chunk.toString()
        let end: number
        while ((end = pending.indexOf('\n')) !== -1) {
          const message = JSON.parse(pending.slice(0, end)) as Message
          pending = pending.slice(end + 1)
          messages.push(message)
          if (message.id === undefined || !message.method) continue
          const threadId = ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) ? (options.threads?.[started++] ?? 'thr-1') : 'thr-1'
          const thread = { result: { thread: { id: threadId }, model: 'gpt-x', modelProvider: CODEX_MODEL_PROVIDER, cwd: home } }
          const reply: Record<string, unknown> =
            options.answer?.(message, send) ??
            (message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } }
            : message.method === 'account/read' ? { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }
            : message.method === 'config/read' ? (options.configFails ? { error: { code: -32603, message: 'unreadable' } } : { result: { config: { mcp_servers: options.mcpServers ?? {} }, layers: options.layers ?? [] } })
            : ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) ? thread
            : message.method === 'turn/start' ? { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
            : { result: {} })
          if ((reply as { silent?: boolean }).silent) continue
          const { delayMs, ...answered } = reply as { delayMs?: number } & Record<string, unknown>
          if (delayMs) setTimeout(() => send({ id: message.id, ...answered }), delayMs)
          else send({ id: message.id, ...answered })
          if (message.method === 'turn/interrupt') options.onInterrupt?.(send, message.params ?? {})
          if (message.method === 'turn/start' && options.onTurnStart) options.onTurnStart(send, message.params ?? {})
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
    return {
      launch: launch as (spec: CodexLaunch) => CodexProcess,
      messages,
      emit: (value: unknown) => latest?.write(JSON.stringify(value) + '\n'),
      /** The app-server process dies. */
      crash: () => void latestProcess?.emit('exit', 1, null),
      requests: (method: string) => messages.filter((message) => message.method === method)
    }
  }

  const create = (s: ReturnType<typeof server>) => {
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: join(home, 'codex') }))
    const service = new CodexProviderService(home, questions, { launch: s.launch }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
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
    const restarted = new CodexProviderService(home, questions, { launch: s.launch }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
    services.push(restarted)
    await chat(restarted, { child: SHARED })
    expect(s.requests('thread/resume')[0].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })

    const turns = s.requests('turn/start')
    expect(turns).toHaveLength(3)
    for (const turn of turns) expect(turn.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    // The turns themselves never read or write the user's Codex config.
    expect(s.messages.map((message) => message.method)).not.toContain('config/read')
  })

  it('an isolated child and a thread that is not a subagent run under the thread\'s permission mode', async () => {
    for (const child of [ISOLATED, undefined]) {
      const asking = server()
      await chat(create(asking), { child, permissionMode: 'ask' })
      expect(asking.requests('thread/start')[0].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted' })
      expect(asking.requests('thread/start')[0].params!.config).toMatchObject(mousseOnly)
      expect(asking.requests('turn/start')[0].params).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } })

      const full = server()
      await chat(create(full), { child, permissionMode: 'full' })
      expect(full.requests('thread/start')[0].params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
      expect(full.requests('turn/start')[0].params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
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

  it('a run with `approvals: never` declines every approval without asking (PR 4 §4)', async () => {
    const s = server({ approvalRequests: true })
    const asked = vi.spyOn(questions, 'requestAnswers')
    await chat(create(s), { approvals: 'never' })
    const reply = (id: number) => s.messages.find((message) => message.id === id)
    await vi.waitFor(() => expect(reply(96)).toBeTruthy())
    expect(reply(99)).toMatchObject({ result: { decision: 'decline' } })
    expect(reply(98)).toMatchObject({ result: { decision: 'decline' } })
    expect(asked).not.toHaveBeenCalled()
    asked.mockRestore()
  })

  it('a run with `approvals: never` refuses Codex questions to the user without asking (PR 4 §4)', async () => {
    const s = server({
      onTurnStart: (send) => {
        send({ id: 95, method: 'item/tool/requestUserInput', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'ask-1', questions: [{ id: 'q', header: 'File', question: 'Which file?', options: [{ label: 'a.ts' }] }] } })
        setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed', error: null } } }), 20)
      }
    })
    const asked = vi.spyOn(questions, 'requestAnswers')
    await chat(create(s), { approvals: 'never' })
    const reply = (id: number) => s.messages.find((message) => message.id === id)
    await vi.waitFor(() => expect(reply(95)).toBeTruthy())
    expect(reply(95)).toMatchObject({ error: { message: QUESTIONS_REFUSED_MESSAGE } })
    expect(asked).not.toHaveBeenCalled()
    asked.mockRestore()
  })

  it('an isolated child\'s approvals are asked through UserQuestionService in the child\'s own thread, where the question router sees them (issue #142)', async () => {
    const s = server({ approvalRequests: true })
    const asked: Array<{ requestId: string; threadId: string; prompts: string[] }> = []
    // What a person (or the parent, through the router and answer_subagent) answers with.
    const onPending = (event: { requestId: string; threadId: string; questions: Array<{ prompt: string }> }): void => {
      asked.push({ requestId: event.requestId, threadId: event.threadId, prompts: event.questions.map((question) => question.prompt) })
      questions.submitAnswers(event.requestId, { permission: 'allow' }, { kind: 'user' })
    }
    questions.on('pending', onPending)
    try {
      await chat(create(s), { child: ISOLATED, permissionMode: 'ask' })
      const reply = (id: number) => s.messages.find((message) => message.id === id)
      await vi.waitFor(() => expect(reply(96)).toBeTruthy())
      // The command and the file edit were asked of the user, keyed by the child's Mousse thread (`chat`'s threadId).
      expect(asked.map((entry) => entry.threadId)).toEqual(['child', 'child'])
      expect(asked[0].prompts[0]).toContain('rm -rf build')
      expect(reply(99)).toMatchObject({ result: { decision: 'accept' } })
      expect(reply(98)).toMatchObject({ result: { decision: 'accept' } })
      // Elicitations and extra permissions are still never granted from Mousse.
      expect(reply(97)).toMatchObject({ result: { action: 'decline' } })
      expect(reply(96)).toMatchObject({ result: { permissions: {} } })
    } finally {
      questions.off('pending', onPending)
    }
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
    // The scripted server answers thread/list with an empty result: the fallback, and its one warning, in every test here.
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    afterEach(() => vi.restoreAllMocks())

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

    it('against a server that does not list descendants the direct helpers named by items are what is followed (the fallback), and the process says so once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const service = create(server())
        await chat(service, { child: SHARED })
        expect((service as unknown as { app?: { tree?: string } }).app?.tree).toBe('off')
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
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

    it("a later run that reuses a helper is not interrupted by the stopped run's tracker, even when the helper's first turn ended before the parent was released", async () => {
      let turns = 0
      const later = { method: 'turn/started', params: { threadId: HELPER, turn: { id: 'h-turn-2', status: 'inProgress', error: null } } }
      const s = server({
        onTurnStart: (send) => {
          turns += 1
          if (turns === 1) setImmediate(() => send(spawned('subAgentActivity')))
          else
            setImmediate(() => {
              // The helper's new turn starts before the item that names it reaches the parent's thread.
              send(later)
              send(spawned('subAgentActivity'))
              send(completed(PARENT, 'turn-1'))
            })
        }
      })
      const service = create(s)
      const internals = service as unknown as { turns: Map<string, unknown>; orphans: Set<unknown> }
      const stop = new AbortController()
      const first = chat(service, { child: SHARED, signal: stop.signal })
      first.catch(() => undefined)
      await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
      await new Promise((done) => setTimeout(done, 50))
      stop.abort(new Error('Stopped'))
      await expect(first).rejects.toThrow('Stopped')
      // The helper had no turn id at Stop; its turn starts and ends while the parent is still registered.
      expect(internals.turns.size).toBe(1)
      s.emit(helperTurn)
      await vi.waitFor(() => expect(interrupts(s)).toContain(`${HELPER}/h-turn-1`))
      s.emit(completed(HELPER, 'h-turn-1', 'interrupted'))
      await vi.waitFor(() => expect(internals.orphans.size).toBe(0))
      s.emit(completed(PARENT, 'turn-1', 'interrupted'))
      await vi.waitFor(() => expect(internals.turns.size).toBe(0))

      const second = chat(service, { child: SHARED })
      expect(await state(second)).toBe('pending')
      expect(interrupts(s)).not.toContain(`${HELPER}/h-turn-2`)
      s.emit(completed(HELPER, 'h-turn-2'))
      await expect(second).resolves.toMatchObject({ codexThreadId: PARENT })
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

    describe('idle cap', () => {
      const withCaps = (s: ReturnType<typeof server>, caps: { helperIdleCapMs?: number; helperPinCapMs?: number }) => {
        mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
        writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: join(home, 'codex') }))
        const service = new CodexProviderService(home, questions, { launch: s.launch, ...caps }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
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

  describe("the helper tree of a Codex thread (the app-server lists a thread's helpers by ancestor)", () => {
    const PARENT = 'thr-1'
    const NIL = '00000000-0000-0000-0000-000000000000'
    const MUTUAL = 'parentThreadId and ancestorThreadId are mutually exclusive'
    /** Short waits, so a run settles in tens of milliseconds. */
    const FAST = { pairGapMs: 15, scanMinMs: 15, safetyTickMs: 250, sweepRoundMs: 30, newbornMs: 40 }
    type Node = { parent: string | null; status: string; createdAt: number; edge: boolean; unreadable: boolean }
    type Mode = 'on' | 'listing' | 'nodb' | 'nonempty' | 'ignoring'
    type Server = ReturnType<typeof server>
    type Send = (value: unknown) => void
    const noop = () => undefined
    const asString = (value: unknown) => String(value)
    const turnOf = (id: string) => (id === PARENT ? 'turn-1' : `${id}-turn`)
    const completedNote = (id: string, status = 'completed', turn = turnOf(id), error: unknown = null) => ({ method: 'turn/completed', params: { threadId: id, turn: { id: turn, status, error } } })
    const startedNote = (id: string, turn = turnOf(id)) => ({ method: 'turn/started', params: { threadId: id, turn: { id: turn, status: 'inProgress', error: null } } })
    const statusNote = (id: string, type: string) => ({ method: 'thread/status/changed', params: { threadId: id, status: { type } } })
    const spawnItem = (helper: string) => ({ method: 'item/completed', params: { threadId: PARENT, turnId: 'turn-1', item: { type: 'subAgentActivity', id: `spawn-${helper}`, kind: 'started', agentThreadId: helper } } })
    const messageDone = (text: string) => ({ method: 'item/completed', params: { threadId: PARENT, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm-1', text } } })
    const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))
    const state = (promise: Promise<unknown>, ms = 250) => Promise.race([promise.then(() => 'settled', () => 'rejected'), settle(ms).then(() => 'pending')])
    const interruptsOf = (s: Server) => s.requests('turn/interrupt').map((message) => `${message.params!.threadId}/${message.params!.turnId}`)
    const listsOf = (s: Server) => s.requests('thread/list').filter((message) => message.params!.ancestorThreadId !== NIL)

    /** The app-server's threads: what `thread/list` and `thread/read` answer. */
    function world(mode: Mode = 'on', roots: string[] = [PARENT]) {
      const nodes = new Map<string, Node>()
      for (const id of roots) nodes.set(id, { parent: null, status: 'idle', createdAt: 0, edge: true, unreadable: false })
      const reaches = (id: string, ancestor: string): boolean => {
        for (let cursor = nodes.get(id)?.parent; cursor; cursor = nodes.get(cursor)?.parent) if (cursor === ancestor) return true
        return false
      }
      const row = (id: string) => ({ id, parentThreadId: nodes.get(id)!.parent, status: { type: nodes.get(id)!.status }, createdAt: nodes.get(id)!.createdAt })
      const answer = (message: Message): Record<string, unknown> | undefined => {
        const params = message.params ?? {}
        if (message.method === 'thread/list') {
          if (params.parentThreadId && params.ancestorThreadId) return mode === 'listing' ? { result: { data: [], nextCursor: null } } : { error: { code: -32600, message: MUTUAL } }
          if (mode === 'nodb') return { error: { code: -32600, message: 'state DB unavailable for filtered thread listing' } }
          const ancestor = asString(params.ancestorThreadId)
          // A server that answers the second probe step with a listing for an id no thread has.
          if (mode === 'nonempty' && ancestor === NIL) return { result: { data: [{ id: 'x', parentThreadId: NIL, status: { type: 'idle' } }], nextCursor: null } }
          // A server that ignores the filter lists every thread it has.
          const ids = [...nodes.keys()].filter((id) => (mode === 'ignoring' && ancestor !== NIL ? true : nodes.get(id)!.edge && reaches(id, ancestor)))
          const from = Number(params.cursor ?? 0)
          const limit = Number(params.limit ?? 100)
          return { result: { data: ids.slice(from, from + limit).map(row), nextCursor: from + limit < ids.length ? String(from + limit) : null } }
        }
        if (message.method === 'thread/read') {
          const node = nodes.get(asString(params.threadId))
          if (!node || node.unreadable) return { error: { code: -32600, message: `thread not found: ${params.threadId}` } }
          return { result: { thread: row(asString(params.threadId)) } }
        }
        return undefined
      }
      const add = (id: string, parent: string, status = 'idle', extra: Partial<Node> = {}) => nodes.set(id, { parent, status, createdAt: 0, edge: true, unreadable: false, ...extra })
      return { nodes, answer, add, status: (id: string) => nodes.get(id)?.status, set: (id: string, status: string) => void (nodes.get(id)!.status = status) }
    }
    type World = ReturnType<typeof world>

    /** A helper starts its turn: the server announces the status first, then the turn. */
    const begin = (w: World, s: Server, id: string, parent: string, extra: Partial<Node> = {}) => {
      w.add(id, parent, 'active', extra)
      s.emit(statusNote(id, 'active'))
      s.emit(startedNote(id))
    }
    const end = (w: World, s: Server, id: string, status = 'completed', turn?: string) => {
      w.set(id, 'idle')
      s.emit(completedNote(id, status, turn))
      s.emit(statusNote(id, 'idle'))
    }

    type Script = (w: World, send: Send, s: Server) => void
    type TreeOptions = {
      mode?: Mode
      roots?: string[]
      threads?: string[]
      /** Threads that ignore `turn/interrupt`. */
      stubborn?: string[]
      /** How long a thread takes to stop after its interrupt. */
      stopDelay?: number
      /** What the parent's n-th turn does, once started (a function applies to every turn). */
      script?: Script | Array<Script | undefined>
      /** The parent's n-th turn never completes by itself. */
      open?: (index: number) => boolean
      /** Runs at once when the n-th `turn/start` arrives. */
      onStart?: (index: number, w: World, params: Record<string, unknown>) => void
      answer?: (message: Message, send: Send, w: World) => Record<string, unknown> | undefined
    }
    /** An app-server whose threads form a tree; the parent is active during its turn and idle after. */
    function tree(options: TreeOptions = {}) {
      const w = world(options.mode ?? 'on', options.roots)
      let starts = 0
      // eslint-disable-next-line prefer-const
      let s: Server
      s = server({
        answer: (message, send) =>
          options.answer?.(message, send, w) ??
          w.answer(message) ??
          (message.method === 'turn/start' ? { result: { turn: { id: turnOf(asString(message.params!.threadId)), status: 'inProgress', error: null } } } : undefined),
        threads: options.threads,
        onTurnStart: (send, params) => {
          const index = starts++
          const thread = asString(params.threadId)
          w.set(thread, 'active')
          options.onStart?.(index, w, params)
          const script = Array.isArray(options.script) ? options.script[index] : options.script
          setImmediate(() => {
            script?.(w, send, s)
            if (options.open?.(index)) return
            w.set(thread, 'idle')
            s.emit(completedNote(thread))
          })
        },
        onInterrupt: (_send, params) => {
          const id = asString(params.threadId)
          if (options.stubborn?.includes(id) || w.status(id) !== 'active') return
          // The turn that was interrupted is the one that ends (an empty turn id means the thread's current turn).
          const turn = asString(params.turnId) || undefined
          setTimeout(() => w.status(id) === 'active' && end(w, s, id, 'interrupted', turn), options.stopDelay ?? 0)
        }
      })
      return { w, s }
    }

    const createFast = (s: Server, deps: Partial<ConstructorParameters<typeof CodexProviderService>[2]> = {}) => {
      mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
      writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: join(home, 'codex') }))
      const service = new CodexProviderService(home, questions, { launch: s.launch, helperTiming: FAST, helperSweepMs: 900, ...deps }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
      services.push(service)
      return service
    }
    const internals = (service: CodexProviderService) =>
      service as unknown as { app?: { tree?: string }; turns: Map<string, unknown>; pendingSweeps: Map<string, unknown>; activeThreads: Set<string> }
    /** Stops a chat and waits for the rejection. */
    const stopped = async (running: Promise<unknown>, stop: AbortController) => {
      stop.abort(new Error('Stopped'))
      await expect(running).rejects.toThrow('Stopped')
    }

    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(noop)
    })
    afterEach(() => warn.mockRestore())

    describe('capability probe', () => {
      it('initialize asks for the experimental API; two requests with an unknown thread id prove the filters before the first turn, once per process', async () => {
        const { s } = tree()
        const service = createFast(s)
        await chat(service, { child: SHARED })
        expect(s.requests('initialize')[0].params).toMatchObject({ capabilities: { experimentalApi: true } })
        expect(s.requests('thread/list').slice(0, 2).map((message) => message.params)).toEqual([
          { parentThreadId: NIL, ancestorThreadId: NIL, limit: 1 },
          { ancestorThreadId: NIL, limit: 1, useStateDbOnly: true }
        ])
        const methods = s.messages.map((message) => message.method)
        expect(methods.indexOf('thread/list')).toBeLessThan(methods.indexOf('thread/start'))
        expect(internals(service).app?.tree).toBe('on')
        service.commitConversation('child', '')
        await chat(service, { child: SHARED })
        expect(s.requests('thread/list').filter((message) => message.params!.limit === 1)).toHaveLength(2)
        expect(warn).not.toHaveBeenCalled()
      })

      it.each([
        ['a listing answered to both filters (an older server)', 'listing' as const, 1],
        ['"state DB unavailable" answered to the ancestor filter', 'nodb' as const, 2],
        ['a listing answered to the ancestor filter alone', 'nonempty' as const, 2]
      ])('%s: the process falls back for good, with one warning and no more thread/list', async (_name, mode, probeRequests) => {
        const { s } = tree({ mode })
        const service = createFast(s)
        await chat(service, { child: SHARED })
        expect(internals(service).app?.tree).toBe('off')
        service.commitConversation('child', '')
        await chat(service, { child: SHARED })
        expect(s.requests('thread/list')).toHaveLength(probeRequests)
        expect(s.requests('thread/read')).toEqual([])
        expect(warn).toHaveBeenCalledTimes(1)
      })

      it('a probe that gets no answer leaves the question open for the next chat, which asks again', async () => {
        let silent = true
        const { s } = tree({ answer: (message, _send, w) => (message.method === 'thread/list' && silent ? ({ silent: true } as Record<string, unknown>) : w.answer(message)) })
        const service = createFast(s, { requestTimeoutMs: 150 })
        await chat(service, { child: SHARED })
        expect(internals(service).app?.tree).toBeUndefined()
        expect(warn).not.toHaveBeenCalled()
        silent = false
        service.commitConversation('child', '')
        await chat(service, { child: SHARED })
        expect(internals(service).app?.tree).toBe('on')
      })
    })

    describe('waiting for helpers', () => {
      it('with no helper the run ends after two agreeing snapshots and its text is unchanged', async () => {
        const { s } = tree({ script: (_w, send) => send(messageDone('All done.')) })
        const result = await chat(createFast(s), { child: SHARED })
        expect(result.text).toBe('All done.')
        expect(listsOf(s).length).toBeGreaterThanOrEqual(2)
        expect(listsOf(s).length).toBeLessThanOrEqual(3)
        expect(s.requests('thread/read').filter((message) => message.params!.threadId === PARENT).length).toBeGreaterThanOrEqual(2)
        expect(interruptsOf(s)).toEqual([])
      })

      it('a helper and its own helper, announced by no spawn item, hold the run until both are idle', async () => {
        const { w, s } = tree({ script: (w, _send, s) => { begin(w, s, 'h1', PARENT); begin(w, s, 'h2', 'h1') } })
        const running = chat(createFast(s), { child: SHARED })
        expect(await state(running)).toBe('pending')
        end(w, s, 'h2')
        expect(await state(running)).toBe('pending')
        end(w, s, 'h1')
        await expect(running).resolves.toMatchObject({ codexThreadId: PARENT })
        expect(interruptsOf(s)).toEqual([])
      })

      it('every page of the listing is read', async () => {
        const { s } = tree({ script: (w) => { for (let i = 0; i < 130; i += 1) w.add(`h${i}`, PARENT, 'idle') } })
        await chat(createFast(s), { child: SHARED })
        const lists = listsOf(s)
        expect(lists.length).toBeGreaterThanOrEqual(4)
        expect(lists.filter((message) => message.params!.cursor === '100')).toHaveLength(lists.length / 2)
      })

      it('a helper whose edge was never written is found through its own status, read, held until idle, and interrupted by Stop with an empty turn id', async () => {
        const { w, s } = tree({ script: (w, _send, s) => begin(w, s, 'ghost', PARENT, { edge: false }), stubborn: ['ghost'] })
        const service = createFast(s)
        const first = chat(service, { child: SHARED })
        expect(await state(first)).toBe('pending')
        expect(s.requests('thread/read').filter((message) => message.params!.threadId === 'ghost').length).toBeGreaterThan(0)
        end(w, s, 'ghost')
        await expect(first).resolves.toBeTruthy()

        service.commitConversation('child', '')
        const stop = new AbortController()
        const second = chat(service, { child: SHARED, signal: stop.signal })
        second.catch(noop)
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        begin(w, s, 'ghost', PARENT, { edge: false })
        await settle(150)
        await stopped(second, stop)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('ghost/'))
        end(w, s, 'ghost', 'interrupted')
      })

      it.each([
        ['a helper whose own row is not written yet (an edge without a thread row)', false],
        ['an archived helper that can no longer be read', true]
      ])('%s, with a listed child under it, stays in tree mode: the child holds the run until idle', async (_name, unreadable) => {
        const { w, s } = tree({
          script: (w, _send, s) => {
            w.add('mid', PARENT, 'idle', { edge: false, unreadable })
            begin(w, s, 'leaf', 'mid')
          }
        })
        const service = createFast(s)
        const running = chat(service, { child: SHARED })
        expect(await state(running)).toBe('pending')
        expect(internals(service).app?.tree).toBe('on')
        expect(warn).not.toHaveBeenCalled()
        end(w, s, 'leaf')
        await expect(running).resolves.toBeTruthy()
        expect(internals(service).app?.tree).toBe('on')
      })

      it('a listing slower than the sweep deadline does not hold the thread: the next message starts within the deadline', async () => {
        let hang = false
        const { s } = tree({
          open: (index) => index === 0,
          answer: (message) => (message.method === 'thread/list' && hang && message.params!.ancestorThreadId !== NIL ? ({ silent: true } as Record<string, unknown>) : undefined)
        })
        const service = createFast(s, { helperSweepMs: 300 })
        const stop = new AbortController()
        const first = chat(service, { child: SHARED, signal: stop.signal })
        first.catch(noop)
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
        hang = true
        await stopped(first, stop)
        const stoppedAt = Date.now()
        const second = chat(service, { child: SHARED })
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2), { timeout: 2_000 })
        expect(Date.now() - stoppedAt).toBeLessThan(1_500)
        hang = false
        await expect(second).resolves.toBeTruthy()
      })

      it('a listing page that answers after the sweep gave up does not lead to a request for the next page', async () => {
        let slow = false
        const { w, s } = tree({
          open: (index) => index === 0,
          answer: (message, _send, w) => {
            if (message.method !== 'thread/list' || !slow || message.params!.ancestorThreadId === NIL) return undefined
            return { ...w.answer(message), delayMs: 700 }
          }
        })
        for (let i = 0; i < 130; i += 1) w.add(`h${i}`, PARENT, 'idle')
        const service = createFast(s, { helperSweepMs: 300 })
        const stop = new AbortController()
        const first = chat(service, { child: SHARED, signal: stop.signal })
        first.catch(noop)
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
        slow = true
        await stopped(first, stop)
        await vi.waitFor(() => expect(internals(service).pendingSweeps.size).toBe(0), { timeout: 2_000 })
        // The first page is answered only now, after the run was released.
        await settle(800)
        expect(listsOf(s).filter((message) => message.params!.cursor)).toEqual([])
      })

      it('a steer held while a cap sweeps still gets its turn, and the helpers of that turn are swept before the run ends', async () => {
        const { s } = tree({
          stubborn: ['h1'],
          script: [(w, _send, s) => begin(w, s, 'h1', PARENT), (w, _send, s) => begin(w, s, 'h2', PARENT)]
        })
        let pending: string | undefined
        const service = createFast(s, { helperIdleCapMs: 200, helperSweepMs: 600 })
        const running = chat(service, { child: SHARED, drainSteer: () => { const text = pending; pending = undefined; return text } })
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('h1/'))
        pending = 'one more thing'
        const result = await running
        expect(result.text).toBe('Some helpers were abandoned after 1 minute without activity')
        expect(s.requests('turn/start')).toHaveLength(2)
        expect(interruptsOf(s)).toContain('h2/')
      })

      it('a helper the listing and thread/read cannot show is still held by the direct-helper floor, and Stop interrupts it by turn id', async () => {
        const { w, s } = tree({
          script: (w, send, s) => {
            w.add('ghost', PARENT, 'active', { edge: false, unreadable: true })
            send(spawnItem('ghost'))
            s.emit(startedNote('ghost'))
          },
          stubborn: ['ghost']
        })
        const stop = new AbortController()
        const running = chat(createFast(s), { child: SHARED, signal: stop.signal })
        running.catch(noop)
        expect(await state(running)).toBe('pending')
        await stopped(running, stop)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('ghost/ghost-turn'))
        end(w, s, 'ghost', 'interrupted')
      })

      it('a server that ignores the ancestor filter fails validation: fallback, nobody else interrupted, direct helpers still followed', async () => {
        const { w, s } = tree({
          mode: 'ignoring',
          roots: [PARENT, 'alien'],
          script: (w, send, s) => {
            w.add('alien-helper', 'alien', 'active')
            send(spawnItem('h1'))
            begin(w, s, 'h1', PARENT)
          }
        })
        const stop = new AbortController()
        const service = createFast(s)
        const running = chat(service, { child: SHARED, signal: stop.signal })
        running.catch(noop)
        await vi.waitFor(() => expect(internals(service).app?.tree).toBe('off'))
        expect(await state(running)).toBe('pending')
        await stopped(running, stop)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('h1/h1-turn'))
        expect(interruptsOf(s).filter((entry) => entry.startsWith('alien'))).toEqual([])
        expect(warn).toHaveBeenCalledTimes(1)
        end(w, s, 'h1', 'interrupted')
      })

      it('an error response to thread/read of the thread switches the process to the fallback after one failure', async () => {
        let refuse = false
        const { s } = tree({
          answer: (message, _send, w) => (message.method === 'thread/read' && refuse ? { error: { code: -32603, message: 'broken' } } : w.answer(message)),
          onStart: () => (refuse = true)
        })
        const service = createFast(s)
        await chat(service, { child: SHARED })
        expect(internals(service).app?.tree).toBe('off')
        expect(s.requests('thread/read')).toHaveLength(1)
      })

      it('a server turn on the thread while the run waits is adopted: its text joins the reply, a steer goes to it by id, and the run ends after the thread is idle', async () => {
        const { w, s } = tree({ script: (w, send, s) => { send(messageDone('First.')); begin(w, s, 'h1', PARENT) } })
        let steer: string | undefined
        const texts: string[] = []
        const running = chat(createFast(s), { child: SHARED, onText: (text) => texts.push(text), drainSteer: () => { const text = steer; steer = undefined; return text } })
        await vi.waitFor(() => expect(listsOf(s).length).toBeGreaterThan(0))
        // A helper's message wakes the parent: the server starts a turn of its own.
        w.set(PARENT, 'active')
        s.emit(statusNote(PARENT, 'active'))
        s.emit(startedNote(PARENT, 'srv-turn'))
        s.emit({ method: 'item/agentMessage/delta', params: { threadId: PARENT, turnId: 'srv-turn', itemId: 'srv-msg', delta: 'Helper reported.' } })
        await settle(60)
        steer = 'and also this'
        await vi.waitFor(() => expect(s.requests('turn/steer')).toHaveLength(1))
        expect(s.requests('turn/steer')[0].params).toMatchObject({ threadId: PARENT, expectedTurnId: 'srv-turn' })
        expect(await state(running)).toBe('pending')
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'srv-turn'))
        s.emit(statusNote(PARENT, 'idle'))
        expect(await state(running)).toBe('pending')
        end(w, s, 'h1')
        const result = await running
        expect(result.text).toBe('First.\n\nHelper reported.')
        expect(s.requests('turn/start')).toHaveLength(1)
        expect(interruptsOf(s)).toEqual([])
      })

      /** A server turn of the parent is adopted while helper h1 keeps the run waiting; steers are refused until `acceptSteers`. */
      const adoptedScenario = (options: { turnStartAnswers?: string[] } = {}) => {
        let starts = 0
        let steers = 0
        const t = tree({
          script: [(w, _send, s) => begin(w, s, 'h1', PARENT), undefined],
          open: (index) => index === 1,
          answer: (message) => {
            if (message.method === 'turn/steer') return ++steers < 2 ? { error: { code: -32600, message: 'no active turn to steer' } } : { result: { turnId: 'x' } }
            if (message.method === 'turn/start' && ++starts === 2 && options.turnStartAnswers?.[0])
              return { result: { turn: { id: options.turnStartAnswers[0], status: 'inProgress', error: null } } }
            return undefined
          }
        })
        let steer: string | undefined
        const serverTurn = async () => {
          await vi.waitFor(() => expect(t.w.status('h1')).toBe('active'))
          await vi.waitFor(() => expect(listsOf(t.s).length).toBeGreaterThan(0))
          t.w.set(PARENT, 'active')
          t.s.emit(statusNote(PARENT, 'active'))
          t.s.emit(startedNote(PARENT, 'srv-turn'))
          await settle(40)
        }
        const send = (text: string) => void (steer = text)
        const drain = () => {
          const text = steer
          steer = undefined
          return text
        }
        return { ...t, serverTurn, send, drain }
      }

      it("Mousse's turn/start that the server steers into an adopted turn makes that turn the run's own: its completion ends the run", async () => {
        const { w, s, serverTurn, send, drain } = adoptedScenario({ turnStartAnswers: ['srv-turn'] })
        const running = chat(createFast(s), { child: SHARED, drainSteer: drain })
        await serverTurn()
        // The steer into the adopted turn is refused, so it is held and starts a turn; the server steers that into the running one.
        send('and this')
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        end(w, s, 'h1')
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'srv-turn'))
        expect(await state(running, 1500)).toBe('settled')
        await expect(running).resolves.toMatchObject({ turnId: 'srv-turn' })
      })

      it("a late completion of an adopted turn does not close the turn Mousse started after it: a steer still goes to that turn", async () => {
        const { w, s, serverTurn, send, drain } = adoptedScenario({ turnStartAnswers: ['mine'] })
        const running = chat(createFast(s), { child: SHARED, drainSteer: drain })
        await serverTurn()
        send('first')
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        // The adopted turn only now reports its end; Mousse's own turn ('mine') is the one running.
        w.set(PARENT, 'active')
        s.emit(completedNote(PARENT, 'completed', 'srv-turn'))
        await settle(30)
        send('second')
        await vi.waitFor(() => expect(s.requests('turn/steer')).toHaveLength(2))
        expect(s.requests('turn/steer')[1].params).toMatchObject({ expectedTurnId: 'mine' })
        expect(s.requests('turn/start')).toHaveLength(2)
        end(w, s, 'h1')
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'mine'))
        await expect(running).resolves.toMatchObject({ turnId: 'mine' })
      })

      it('an adopted turn that reports its failure after Mousse started its own turn does not fail that turn', async () => {
        const { w, s, serverTurn, send, drain } = adoptedScenario({ turnStartAnswers: ['mine'] })
        const running = chat(createFast(s), { child: SHARED, drainSteer: drain })
        await serverTurn()
        send('go on')
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        s.emit(completedNote(PARENT, 'failed', 'srv-turn', { message: 'late failure' }))
        await settle(30)
        end(w, s, 'h1')
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'mine'))
        await expect(running).resolves.toMatchObject({ turnId: 'mine' })
      })

      it('the wait for an adopted turn to fail is dropped when the hold ends another way', async () => {
        const { w, s, send, drain } = adoptedScenario({ turnStartAnswers: ['mine'] })
        const service = createFast(s)
        const running = chat(service, { child: SHARED, drainSteer: drain })
        const waiters = () => ((internals(service).turns.get(PARENT) as unknown as { adoptedFailureWaiters: unknown[] } | undefined)?.adoptedFailureWaiters.length)
        await vi.waitFor(() => expect(waiters()).toBe(1))
        // A steer with no turn open ends the hold; the run starts a turn.
        send('new work')
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        expect(waiters()).toBe(0)
        end(w, s, 'h1')
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'mine'))
        await expect(running).resolves.toBeTruthy()
      })

      it.each([
        ['failed', { message: 'model exploded' }, 'model exploded'],
        ['interrupted', null, 'Codex interrupted the turn']
      ])('an adopted turn that ends %s fails the run, and the helpers still running are swept', async (status, error, message) => {
        const { w, s, serverTurn } = adoptedScenario()
        const service = createFast(s)
        const running = chat(service, { child: SHARED })
        running.catch(noop)
        await serverTurn()
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, status, 'srv-turn', error))
        await expect(running).rejects.toThrow(message)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('h1/'))
        await vi.waitFor(() => expect(internals(service).turns.size).toBe(0))
        expect(w.status('h1')).toBe('idle')
      })

      it('a server turn that is running when Stop lands is interrupted by its id', async () => {
        const { w, s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT) })
        const stop = new AbortController()
        const running = chat(createFast(s), { child: SHARED, signal: stop.signal })
        running.catch(noop)
        await vi.waitFor(() => expect(listsOf(s).length).toBeGreaterThan(0))
        w.set(PARENT, 'active')
        s.emit(statusNote(PARENT, 'active'))
        s.emit(startedNote(PARENT, 'srv-turn'))
        await settle(40)
        await stopped(running, stop)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('thr-1/srv-turn'))
      })

      it('when a server turn starts while turn/start is on its way, the server steers the input into it: one turn is tracked and the steer targets it', async () => {
        let steer: string | undefined
        const { w, s } = tree({
          open: () => true,
          answer: (message, send, w) => {
            if (message.method !== 'turn/start') return undefined
            w.set(PARENT, 'active')
            send(statusNote(PARENT, 'active'))
            send(startedNote(PARENT, 'srv-turn'))
            return { result: { turn: { id: 'srv-turn', status: 'inProgress', error: null } } }
          }
        })
        const running = chat(createFast(s), { child: SHARED, drainSteer: () => { const text = steer; steer = undefined; return text } })
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
        await settle(60)
        steer = 'one more'
        await vi.waitFor(() => expect(s.requests('turn/steer')).toHaveLength(1))
        expect(s.requests('turn/steer')[0].params).toMatchObject({ expectedTurnId: 'srv-turn' })
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'srv-turn'))
        await expect(running).resolves.toMatchObject({ turnId: 'srv-turn' })
        expect(s.requests('turn/start')).toHaveLength(1)
      })

      it("a server turn that completed before turn/start answered does not settle the run: Mousse's own turn does, and a steer targets it", async () => {
        let steer: string | undefined
        const { w, s } = tree({
          open: () => true,
          answer: (message, send) => {
            if (message.method !== 'turn/start') return undefined
            send(startedNote(PARENT, 'srv-old'))
            send(completedNote(PARENT, 'completed', 'srv-old'))
            return { result: { turn: { id: 'mine', status: 'inProgress', error: null } } }
          }
        })
        const running = chat(createFast(s), { child: SHARED, drainSteer: () => { const text = steer; steer = undefined; return text } })
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
        await settle(120)
        expect(await state(running, 50)).toBe('pending')
        steer = 'go on'
        await vi.waitFor(() => expect(s.requests('turn/steer')).toHaveLength(1))
        expect(s.requests('turn/steer')[0].params).toMatchObject({ expectedTurnId: 'mine' })
        w.set(PARENT, 'idle')
        s.emit(completedNote(PARENT, 'completed', 'mine'))
        await expect(running).resolves.toMatchObject({ turnId: 'mine' })
      })

      it.each([
        ['completed', undefined],
        ['failed', 'boom']
      ])("Mousse's own turn that ends before its turn/start answer is read still settles the run, with its own status (%s)", async (status, failure) => {
        const { s } = tree({
          answer: (message, send) => {
            if (message.method !== 'turn/start') return undefined
            send(startedNote(PARENT, 'mine'))
            send(completedNote(PARENT, status, 'mine', failure ? { message: failure } : null))
            return { result: { turn: { id: 'mine', status: 'inProgress', error: null } } }
          }
        })
        const running = chat(createFast(s), { child: SHARED })
        if (failure) await expect(running).rejects.toThrow(failure)
        else await expect(running).resolves.toMatchObject({ turnId: 'mine' })
      })

      it('a steer that arrives with no turn open starts a turn; the wait resumes after it and no helper is interrupted', async () => {
        const { w, s } = tree({ script: [(w, _send, s) => begin(w, s, 'h1', PARENT), undefined] })
        let steer: string | undefined
        const running = chat(createFast(s), { child: SHARED, drainSteer: () => { const text = steer; steer = undefined; return text } })
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        expect(await state(running)).toBe('pending')
        steer = 'also check the tests'
        await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2))
        expect(s.requests('turn/start')[1].params!.input).toEqual([{ type: 'text', text: 'also check the tests', text_elements: [] }])
        expect(await state(running)).toBe('pending')
        end(w, s, 'h1')
        await expect(running).resolves.toMatchObject({ codexThreadId: PARENT })
        expect(interruptsOf(s)).toEqual([])
      })

      it('notifications of the experimental API and extra fields on an approval request are ignored without error', async () => {
        const { w, s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT) })
        const running = chat(createFast(s), { child: SHARED })
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        s.emit({ method: 'thread/goal/updated', params: { threadId: PARENT, goal: {} } })
        s.emit({ method: 'mcpServer/startupStatus/updated', params: { name: 'ext', status: 'ready' } })
        s.emit({ method: 'item/commandExecution/requestApproval', id: 77, params: { threadId: PARENT, turnId: 'turn-1', itemId: 'c1', command: 'ls', availableDecisions: ['accept', 'decline'], additionalPermissions: { network: true } } })
        await vi.waitFor(() => expect(s.messages.find((message) => message.id === 77)).toMatchObject({ result: { decision: 'decline' } }))
        expect(await state(running)).toBe('pending')
        end(w, s, 'h1')
        await expect(running).resolves.toBeTruthy()
      })

      it('the process dying while the run waits fails the chat, and the sweep it leaves behind resolves', async () => {
        const { s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT), stubborn: ['h1'] })
        const service = createFast(s)
        const running = chat(service, { child: SHARED })
        running.catch(noop)
        await vi.waitFor(() => expect(listsOf(s).length).toBeGreaterThan(0))
        s.crash()
        await expect(running).rejects.toThrow(/exited/)
        await vi.waitFor(() => expect(internals(service).pendingSweeps.size).toBe(0))
        expect(internals(service).turns.size).toBe(0)
      })

      it('the process dying during the sweep after Stop releases the thread too', async () => {
        const { s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT), stubborn: ['h1'] })
        const service = createFast(s)
        const stop = new AbortController()
        const running = chat(service, { child: SHARED, signal: stop.signal })
        running.catch(noop)
        await vi.waitFor(() => expect(listsOf(s).length).toBeGreaterThan(0))
        await stopped(running, stop)
        expect(internals(service).pendingSweeps.size).toBe(1)
        s.crash()
        await vi.waitFor(() => expect(internals(service).pendingSweeps.size).toBe(0))
        expect(internals(service).turns.size).toBe(0)
      })
    })

    describe('Stop, failure and the caps', () => {
      it('Stop while the parent runs rejects at once, interrupts the parent by id, then catches a helper that shows up after the parent went idle', async () => {
        const stop = new AbortController()
        const w = world()
        let late = false
        // The parent stops on its interrupt; a helper it was still spawning appears right after.
        const s: Server = server({
          answer: w.answer,
          onTurnStart: () => w.set(PARENT, 'active'),
          onInterrupt: (_send, params) => {
            const id = asString(params.threadId)
            if (w.status(id) !== 'active') return
            end(w, s, id, 'interrupted')
            if (id === PARENT && !late) {
              late = true
              setTimeout(() => begin(w, s, 'late', PARENT), 5)
            }
          }
        })
        const service = createFast(s)
        let turnKnown = false
        const running = chat(service, { child: ISOLATED, signal: stop.signal, onSession: (session) => (turnKnown ||= Boolean(session.turnId)) })
        running.catch(noop)
        await vi.waitFor(() => expect(turnKnown).toBe(true))
        await stopped(running, stop)
        // The chat is gone, the thread's sweep is still working.
        expect(internals(service).pendingSweeps.size).toBe(1)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('late/'), { timeout: 3_000 })
        expect(interruptsOf(s)[0]).toBe('thr-1/turn-1')
        await vi.waitFor(() => expect(internals(service).turns.size).toBe(0))
        expect(w.status('late')).toBe('idle')
      })

      it('Stop while the run waits rejects at once; a message sent meanwhile waits for the sweep (no "already running") and starts after it', async () => {
        let helperAtSecondStart: string | undefined
        const { w, s } = tree({
          script: [(w, _send, s) => begin(w, s, 'h1', PARENT), undefined],
          stopDelay: 300,
          onStart: (index, w) => {
            if (index === 1) helperAtSecondStart = w.status('h1')
          }
        })
        const service = createFast(s)
        const stop = new AbortController()
        const first = chat(service, { child: SHARED, signal: stop.signal })
        first.catch(noop)
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        expect(await state(first)).toBe('pending')
        await stopped(first, stop)
        expect(w.status('h1')).toBe('active')
        const second = chat(service, { child: SHARED })
        await expect(second).resolves.toMatchObject({ codexThreadId: PARENT })
        // The new turn went out only after the helper had stopped.
        expect(helperAtSecondStart).toBe('idle')
        expect(s.requests('turn/start')).toHaveLength(2)
      })

      describe('a helper that ignores its interrupt', () => {
        const leftover = async (secondStep: (ctx: { w: World; s: Server; second: Promise<unknown>; stop2: AbortController; stoppedAt: number }) => Promise<void>) => {
          const { w, s } = tree({ stubborn: ['h1'], script: [(w, _send, s) => begin(w, s, 'h1', PARENT), undefined] })
          const service = createFast(s, { helperSweepMs: 300 })
          const stop = new AbortController()
          const first = chat(service, { child: SHARED, signal: stop.signal })
          first.catch(noop)
          await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
          await settle(60)
          await stopped(first, stop)
          const stoppedAt = Date.now()
          const stop2 = new AbortController()
          const second = chat(service, { child: SHARED, signal: stop2.signal })
          second.catch(noop)
          await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(2), { timeout: 3_000 })
          // The sweep gave up at its deadline, with a warning, and only then did the next turn go out.
          expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(250)
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stop'))
          // The leftover is a descendant like any other: it holds the second run.
          expect(await state(second)).toBe('pending')
          await secondStep({ w, s, second, stop2, stoppedAt })
        }

        it('the sweep releases the thread at its deadline; the next run waits for the leftover and ends when it goes idle', async () => {
          await leftover(async ({ w, s, second }) => {
            end(w, s, 'h1')
            await expect(second).resolves.toMatchObject({ codexThreadId: PARENT })
          })
        })

        it("the next run's Stop interrupts the leftover again", async () => {
          await leftover(async ({ s, second, stop2 }) => {
            const before = interruptsOf(s).filter((entry) => entry.startsWith('h1/')).length
            await stopped(second, stop2)
            await vi.waitFor(() => expect(interruptsOf(s).filter((entry) => entry.startsWith('h1/')).length).toBeGreaterThan(before))
          })
        })

        it('in the fallback a parent that ignores its interrupt is released at the deadline too, and the next message starts', async () => {
          const { s } = tree({ mode: 'listing', stubborn: [PARENT], open: (index) => index === 0 })
          const service = createFast(s, { helperSweepMs: 300 })
          const stop = new AbortController()
          const first = chat(service, { child: SHARED, signal: stop.signal })
          first.catch(noop)
          await vi.waitFor(() => expect(s.requests('turn/start')).toHaveLength(1))
          await settle(60)
          await stopped(first, stop)
          const stoppedAt = Date.now()
          await expect(chat(service, { child: SHARED })).resolves.toMatchObject({ codexThreadId: PARENT })
          expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(250)
          expect(s.requests('turn/start')).toHaveLength(2)
          // Stop's own interrupt, then one more every round of the sweep.
          expect(interruptsOf(s).filter((entry) => entry === 'thr-1/turn-1').length).toBeGreaterThanOrEqual(3)
        })
      })

      it('a failed parent turn sweeps the tree and the error propagates; a turn that ends in systemError is a failed run, not a reason to leave the tree mode', async () => {
        const { w, s } = tree({
          open: (index) => index === 0,
          script: [
            (w, send, s) => {
              begin(w, s, 'h1', PARENT)
              w.set(PARENT, 'systemError')
              send(completedNote(PARENT, 'failed', 'turn-1', { message: 'model exploded' }))
            },
            undefined
          ]
        })
        const service = createFast(s)
        await expect(chat(service, { child: SHARED })).rejects.toThrow('model exploded')
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('h1/'))
        await vi.waitFor(() => expect(internals(service).turns.size).toBe(0))
        expect(internals(service).app?.tree).toBe('on')
        expect(w.status('h1')).toBe('idle')
        // The next message runs in the tree mode as before.
        w.set(PARENT, 'idle')
        service.commitConversation('child', '')
        await expect(chat(service, { child: SHARED })).resolves.toBeTruthy()
        expect(s.requests('thread/list').filter((message) => message.params!.limit === 1)).toHaveLength(2)
      })

      it('helpers silent for the idle cap are swept, and the run ends done with the note; traffic of another run on the process does not keep them alive', async () => {
        const { w, s } = tree({
          roots: [PARENT, 'thr-2'],
          threads: [PARENT, 'thr-2'],
          onStart: () => undefined,
          script: [(w, _send, s) => begin(w, s, 'h1', PARENT), (w, _send, s) => begin(w, s, 'h2', 'thr-2')]
        })
        const service = createFast(s, { helperIdleCapMs: 400 })
        const first = chat(service, { child: SHARED })
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        const other = chat(service, { child: SHARED, threadId: 'other' })
        other.catch(noop)
        await vi.waitFor(() => expect(w.status('h2')).toBe('active'))
        // The other run's helper is busy the whole time.
        const chatter = setInterval(() => s.emit(statusNote('h2', 'active')), 25)
        try {
          const result = await first
          expect(result.text).toBe('Some helpers were abandoned after 1 minute without activity')
          expect(interruptsOf(s)).toContain('h1/')
          expect(interruptsOf(s).filter((entry) => entry.startsWith('h2') || entry.startsWith('thr-2'))).toEqual([])
        } finally {
          clearInterval(chatter)
        }
        end(w, s, 'h2')
        await expect(other).resolves.toBeTruthy()
      })

      it('helpers that keep reporting are swept at the pin cap', async () => {
        const { w, s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT) })
        const service = createFast(s, { helperIdleCapMs: 10_000, helperPinCapMs: 400 })
        const running = chat(service, { child: SHARED })
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        const chatter = setInterval(() => s.emit(statusNote('h1', 'active')), 25)
        try {
          const result = await running
          expect(result.text).toBe('Some helpers were abandoned after 1 minute')
          expect(interruptsOf(s)).toContain('h1/')
        } finally {
          clearInterval(chatter)
        }
      })

      it('a cap sweep interrupts the parent too when a turn of it is active, and the run still ends done with the note', async () => {
        const { w, s } = tree({ script: (w, _send, s) => begin(w, s, 'h1', PARENT) })
        const running = chat(createFast(s, { helperIdleCapMs: 300 }), { child: SHARED })
        await vi.waitFor(() => expect(listsOf(s).length).toBeGreaterThan(0))
        w.set(PARENT, 'active')
        s.emit(statusNote(PARENT, 'active'))
        s.emit(startedNote(PARENT, 'srv-turn'))
        const result = await running
        expect(result.text).toBe('Some helpers were abandoned after 1 minute without activity')
        expect(interruptsOf(s)).toContain('thr-1/srv-turn')
      })
    })

    describe('several runs', () => {
      it('two unrelated runs on one process neither hold nor sweep each other; the other root is ruled out after one read chain', async () => {
        const { w, s } = tree({
          roots: [PARENT, 'thr-2'],
          threads: [PARENT, 'thr-2'],
          script: [(w, _send, s) => begin(w, s, 'hA', PARENT), (w, _send, s) => begin(w, s, 'hB', 'thr-2')]
        })
        const service = createFast(s)
        const stopA = new AbortController()
        const a = chat(service, { child: SHARED, signal: stopA.signal })
        a.catch(noop)
        await vi.waitFor(() => expect(w.status('hA')).toBe('active'))
        const b = chat(service, { child: SHARED, threadId: 'other' })
        await vi.waitFor(() => expect(w.status('hB')).toBe('active'))
        await settle(150)
        await stopped(a, stopA)
        await vi.waitFor(() => expect(interruptsOf(s)).toContain('hA/'))
        await vi.waitFor(() => expect(internals(service).pendingSweeps.size).toBe(0))
        // B is still waiting for its own helper, untouched.
        expect(await state(b)).toBe('pending')
        expect(interruptsOf(s).filter((entry) => entry.startsWith('hB') || entry.startsWith('thr-2'))).toEqual([])
        // hB sits under B's listing; A read it once, to learn it belongs to another thread.
        expect(s.requests('thread/read').filter((message) => message.params!.threadId === 'hB')).toHaveLength(1)
        end(w, s, 'hB')
        await expect(b).resolves.toBeTruthy()
      })

      it('two consecutive runs on one thread: a helper the second run talks to holds it; the first run left nothing behind', async () => {
        const { w, s } = tree({ script: [(w, _send, s) => { begin(w, s, 'h1', PARENT); setTimeout(() => end(w, s, 'h1'), 60) }, (w, _send, s) => begin(w, s, 'h1', PARENT)] })
        const service = createFast(s)
        await expect(chat(service, { child: SHARED })).resolves.toBeTruthy()
        expect(internals(service).turns.size).toBe(0)
        service.commitConversation('child', '')
        const second = chat(service, { child: SHARED })
        await vi.waitFor(() => expect(w.status('h1')).toBe('active'))
        expect(await state(second)).toBe('pending')
        end(w, s, 'h1')
        await expect(second).resolves.toBeTruthy()
        // Nobody interrupted anything: not the first run's tracker, not the second's.
        expect(interruptsOf(s)).toEqual([])
      })
    })
  })
})
