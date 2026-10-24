/**
 * Issue #142: a delegated child's policy per provider, on its first and its resumed turns. Shared
 * (read-only) children cannot change the workspace, see no user MCP servers and start no native
 * subagents; isolated children keep their write access but lose native subagents too.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { claudeChildOptions } from '../src/mms/providers/claudeSubscription/childPolicy'
import type { ClaudeTurnIntegrations } from '../src/mms/providers/claudeSubscription/integrations'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { CodexLaunch, CodexProcess } from '../src/mms/providers/codex/CodexAppServerClient'
import { codexChildConfigOverrides, codexTurnPolicy } from '../src/mms/providers/codex/childPolicy'
import { CODEX_MODEL_PROVIDER, CodexProviderService, type CodexChatInput } from '../src/mms/providers/codex/CodexProviderService'
import type { ChildTurnPolicy } from '../src/mms/run/adapters/ProviderAdapter'

const SHARED: ChildTurnPolicy = { readOnly: true }
const ISOLATED: ChildTurnPolicy = { readOnly: false }
const MOUSSE = { url: 'http://127.0.0.1:9/mcp', token: 'tok' }

describe('policy table: pure option builders', () => {
  it.each([
    ['not a subagent', undefined, {}],
    ['isolated child', ISOLATED, { disallowedTools: ['Agent', 'Task'] }],
    ['shared child', SHARED, {
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task'],
      strictMcpConfig: true
    }]
  ])('Claude options for %s', (_name, child, expected) => {
    expect(claudeChildOptions(child)).toEqual(expected)
  })

  it.each([
    ['agent turn', 'default', undefined, { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }],
    ['plan turn', 'plan', undefined, { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ['isolated child', 'default', ISOLATED, { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }],
    ['shared child', 'default', SHARED, { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
    ['shared child in plan mode', 'plan', SHARED, { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }]
  ] as const)('Codex sandbox and approvals for a %s', (_name, mode, child, expected) => {
    expect(codexTurnPolicy(mode, child)).toMatchObject(expected)
  })

  it('Codex config: only children change it; every child loses native subagents', () => {
    expect(codexChildConfigOverrides(undefined, ['ext'])).toEqual({})
    expect(codexChildConfigOverrides(ISOLATED, ['ext'])).toEqual({ 'features.multi_agent': false, 'features.multi_agent_v2': false })
    expect(codexChildConfigOverrides(SHARED, ['ext', 'mousse', 'other_2'])).toEqual({
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'features.plugins': false,
      'features.apps': false,
      'features.computer_use': false,
      'features.browser_use': false,
      'mcp_servers.ext.enabled': false,
      'mcp_servers.other_2.enabled': false
    })
  })

  it('Codex config: a server name a dotted key cannot address fails closed', () => {
    expect(() => codexChildConfigOverrides(SHARED, ['a.b'])).toThrow(/cannot be turned off/)
  })
})

describe('Claude Subscription children', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'vendor-session' }
  /** What `canUseTool` said to each probe, asked while the turn runs (the turn's controller aborts after it). */
  const PROBES: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: 'touch x' }],
    ['Write', { file_path: 'x' }],
    ['Agent', {}],
    ['mcp__userserver__anything', {}],
    ['Read', { file_path: 'x' }],
    ['mcp__mousse__thread_read', {}]
  ]
  const decisions: Array<Record<string, string>> = []
  const fakeQuery = (options: Options) => {
    const generator = (async function* () {
      const decided: Record<string, string> = {}
      // A bypass turn asks the user for what it cannot approve itself; only restricted turns are probed.
      for (const [tool, args] of options.permissionMode === 'bypassPermissions' ? [] : PROBES)
        decided[tool] = (await options.canUseTool!(tool, args, { signal: new AbortController().signal } as never)).behavior
      decisions.push(decided)
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

  afterEach(() => {
    decisions.length = 0
  })

  it('a shared child is read-only on its first turn and on a resumed turn', async () => {
    const { service, options, input } = fixture()
    await service.chat(input({ child: SHARED }))
    service.commitConversation('child', 'history')
    await service.chat(input({ child: SHARED, history: 'history' }))
    expect(options[1].resume).toBe('vendor-session')
    for (const turn of options) {
      expect(turn).toMatchObject({
        permissionMode: 'default',
        strictMcpConfig: true,
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch']
      })
      expect(turn).not.toHaveProperty('allowDangerouslySkipPermissions')
      expect(turn.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task']))
      // Only Mousse's own server: neither the user's stdio server nor the OAuth one Mousse proxies.
      expect(Object.keys(turn.mcpServers ?? {})).toEqual(['mousse'])
    }
    // The permission callback of each turn: reads and Mousse's own tools only.
    expect(decisions).toEqual([
      { Bash: 'deny', Write: 'deny', Agent: 'deny', mcp__userserver__anything: 'deny', Read: 'allow', mcp__mousse__thread_read: 'allow' },
      { Bash: 'deny', Write: 'deny', Agent: 'deny', mcp__userserver__anything: 'deny', Read: 'allow', mcp__mousse__thread_read: 'allow' }
    ])
  })

  it('an isolated child keeps write access and the user MCP servers but has no native subagent tool', async () => {
    const { service, options, input } = fixture()
    await service.chat(input({ child: ISOLATED }))
    service.commitConversation('child', 'history')
    await service.chat(input({ child: ISOLATED, history: 'history' }))
    for (const turn of options) {
      expect(turn).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, disallowedTools: ['Agent', 'Task'] })
      expect(turn).not.toHaveProperty('tools')
      expect(turn).not.toHaveProperty('strictMcpConfig')
      expect(Object.keys(turn.mcpServers ?? {})).toEqual(expect.arrayContaining(['mousse', 'userserver', 'oauthserver']))
    }
  })

  it('a thread that is not a subagent is unchanged', async () => {
    const { service, options, input } = fixture()
    await service.chat(input())
    expect(options[0]).toMatchObject({ permissionMode: 'bypassPermissions' })
    for (const key of ['tools', 'disallowedTools', 'strictMcpConfig']) expect(options[0]).not.toHaveProperty(key)
  })
})

describe('Codex children', () => {
  type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
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

  /** An app-server stand-in: a signed-in account, a user MCP server named `ext`, instant turns. */
  function server(options: { approvalRequest?: boolean } = {}) {
    const messages: Message[] = []
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
          const reply: Record<string, unknown> =
            message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } }
            : message.method === 'account/read' ? { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }
            : message.method === 'config/read' ? { result: { config: { mcp_servers: { ext: { command: 'ext' }, mousse: { url: 'stale' } } } } }
            : ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method) ? thread
            : message.method === 'turn/start' ? { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
            : { result: {} }
          send({ id: message.id, ...reply })
          if (message.method === 'turn/start') {
            if (options.approvalRequest) send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1', itemId: 'cmd-1', command: 'rm -rf build' } })
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

  it('a shared child gets a read-only sandbox, no approvals, no native subagents and no user MCP servers; resumed turns the same', async () => {
    const s = server()
    const service = create(s)
    await chat(service, { child: SHARED })
    const start = s.requests('thread/start')[0].params!
    expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(start.config).toMatchObject({
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'features.plugins': false,
      'features.apps': false,
      'mcp_servers.ext.enabled': false,
      'mcp_servers.mousse.url': MOUSSE.url
    })
    expect(start.config).not.toHaveProperty('mcp_servers.mousse.enabled')

    // The same service, the thread still loaded: only the turn's own policy applies.
    service.commitConversation('child', '')
    await chat(service, { child: SHARED })
    service.commitConversation('child', '')
    // A new process after a restart resumes the saved thread; the policy rides on the resume.
    service.stop()
    const restarted = new CodexProviderService(home, questions, { launch: s.launch })
    services.push(restarted)
    await chat(restarted, { child: SHARED })
    const resume = s.requests('thread/resume')[0].params!
    expect(resume).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(resume.config).toMatchObject({ 'features.multi_agent': false, 'mcp_servers.ext.enabled': false })

    const turns = s.requests('turn/start')
    expect(turns).toHaveLength(3)
    for (const turn of turns)
      expect(turn.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  })

  it('an isolated child keeps workspace-write and its MCP servers but has no native subagents', async () => {
    const s = server()
    await chat(create(s), { child: ISOLATED })
    expect(s.requests('config/read')).toHaveLength(0)
    expect(s.requests('thread/start')[0].params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    const config = s.requests('thread/start')[0].params!.config as Record<string, unknown>
    expect(config).toMatchObject({ 'features.multi_agent': false, 'features.multi_agent_v2': false })
    expect(Object.keys(config).some((key) => key.startsWith('mcp_servers.ext') || key === 'features.plugins')).toBe(false)
    expect(s.requests('turn/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } })
  })

  it('a thread that is not a subagent is unchanged', async () => {
    const s = server()
    await chat(create(s))
    expect(Object.keys(s.requests('thread/start')[0].params!.config as object).some((key) => key.startsWith('features.'))).toBe(false)
    expect(s.requests('thread/start')[0].params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  })

  it('a shared child declines a command approval instead of asking in its hidden thread', async () => {
    const s = server({ approvalRequest: true })
    const asked = vi.spyOn(questions, 'requestAnswers')
    await chat(create(s), { child: SHARED })
    await vi.waitFor(() => expect(s.messages.find((message) => message.id === 99)).toBeTruthy())
    expect(s.messages.find((message) => message.id === 99)).toMatchObject({ result: { decision: 'decline' } })
    expect(asked).not.toHaveBeenCalled()
    asked.mockRestore()
  })
})
