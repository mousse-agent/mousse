import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters } from '../../src/mms/harness/budget'
import type { BotAuthority, BotMcpTool } from '../../src/shared/bots/personal/authority'
import { PI_RPC_EXACT_CAPS } from '../../src/mms/harness/drivers/pi'
import type { AdapterHost } from '../../src/mms/harness/adapter'
import { ToolRegistry, type UserMcpProxy } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import type { McpToolDescriptor } from '../../src/shared/integrations'
import type { IntegrationActor } from '../../src/shared/integrations/actor'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import { appTurn } from '../run/appToolsFixture'
import { harness, script, setup } from './piRpcEngineFixture'
import type { RecordedRequest } from './piRpcFixture'

// PR 4 unit 4h: the user's own MCP servers reach Pi's agent through Mousse's MCP server
// (`userMcp: 'proxy'`), as they reached the deleted loop. On the real pinned Pi child, Mousse's
// extension built from source, a local MCP endpoint over the real tool registry, and an
// OpenAI-compatible mock on 127.0.0.1. Fake key only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SEARCH: McpToolDescriptor = {
  id: 'github:search_issues',
  serverId: 'github',
  serverName: 'GitHub',
  toolName: 'search_issues',
  providerName: 'mcp__github__search_issues',
  description: 'Search issues',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
}

/** The user's MCP manager as the registry sees it: one enabled tool, every call recorded. */
function userMcp(enabled: (actor: IntegrationActor) => boolean = () => true) {
  const calls: Array<{ name: string; args: Record<string, unknown>; actor: IntegrationActor }> = []
  const proxy: UserMcpProxy = {
    list: async (_projectPath, actor) => (enabled(actor) ? [SEARCH] : []),
    allowed: async (_name, _projectPath, actor) => (enabled(actor) ? { allowed: true } : { allowed: false, reason: 'MCP tool is not enabled for this actor.' }),
    call: async (name, args, _projectPath, _signal, actor) => {
      calls.push({ name, args, actor })
      return { text: 'found 3 issues', isError: false, content: [{ type: 'text', text: 'found 3 issues' }], provenance: {} as never }
    }
  }
  return { proxy, calls }
}

function policy(project: string): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [project] },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

function definition(project: string, granted: boolean): DefinitionAuthority {
  const grants: EffectiveAgentGrants = {
    skills: [],
    mcpTools: granted ? [{ serverId: SEARCH.serverId, toolName: SEARCH.toolName, source: 'definition' } as never] : [],
    builtinTools: [{ id: 'read', source: 'definition' as never }],
    denied: []
  }
  // As the orchestrator builds it: the user's MCP tools the grants name.
  return { policy: policy(project), grants, mcpTools: granted ? [SEARCH] : [] }
}

const body = (request: RecordedRequest) => JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }

/**
 * One turn on the real Pi child whose model calls the user's MCP tool, then answers. The turn's app
 * tools run through the real registry behind a local MCP endpoint, as Mousse's MCP server runs them.
 */
async function run(options: { definition?: (project: string) => DefinitionAuthority; enabled?: (actor: IntegrationActor) => boolean; userMcp?: 'proxy' | 'native'; bot?: BotAuthority } = {}) {
  const turns = new AppToolTurns()
  const ledger: string[] = []
  const mcp = userMcp(options.enabled)
  // A bot's MCP calls run on the owner's connection (`BotMcp.call`), recorded here as the server would see them.
  const botCalls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const registry = new ToolRegistry({
    activeRunId: () => 'r1',
    turns,
    userMcp: mcp.proxy,
    botMcp: { call: async (tool, args) => (botCalls.push({ tool: tool.tool, args }), { text: 'found 3 issues' }) },
    toolLedger: () => ({ start: (call) => (ledger.push(`start:${call.name}`), 'row'), commit: () => void ledger.push('commit'), failed: () => void ledger.push('failed') })
  })
  const { engine, recorder, project } = await setup(cleanups, {
    capabilities: { ...PI_RPC_EXACT_CAPS },
    mousseTools: (threadId, runId) => registry.listForTurn(threadId, runId),
    userMcpTools: async (threadId, runId) => registry.userMcpListingForTurn(threadId, runId),
    ...(options.bot ? { onBotProcess: () => {} } : {})
  })
  const authority = options.definition?.(project)
  turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', projectPath: project, ...(authority ? { definition: authority } : {}), ...(options.bot ? { bot: options.bot } : {}) }))
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const call = JSON.parse(raw) as { id: string; params: { name: string; arguments: Record<string, unknown> } }
    const { clientRequestId, ...args } = call.params.arguments
    const outcome = await registry.call(call.params.name, args, {
      credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', binding: 'per_call', current: () => true },
      toolCallId: `mcp:${String(clientRequestId)}`,
      signal: new AbortController().signal
    }).catch((error: unknown) => ({ text: error instanceof Error ? error.message : String(error), isError: true }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError } }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  recorder.respond(script([{ tool: { name: SEARCH.providerName, args: { query: 'flaky' } } }, { text: 'done' }]))
  const bridge: AdapterHost['bridge'] = {
    mcp: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: 'fake' },
    turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: options.userMcp ?? 'proxy'
  }
  const definitionInput = authority ? { session: 'ephemeral' as const, instructions: { text: 'You are a test agent.', placement: 'replace' as const } } : {}
  const turn = harness(project, definitionInput, { ...(authority ? { definition: authority } : {}), ...(options.bot ? { bot: options.bot } : {}), bridge })
  const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
  const offered = (body(recorder.requests[0]).tools ?? []).map((tool) => tool.function.name)
  const answered = recorder.requests.length > 1 ? JSON.stringify(body(recorder.requests[1]).messages) : ''
  return { result, offered, answered, calls: mcp.calls, botCalls, ledger }
}

/** A bot's authority holding `granted` (`<server>::<tool>`), whose turn was offered GitHub's search_issues; `checks` records what its gate asked. */
function botWith(granted: Array<`${string}::${string}`>) {
  const base = createBotAuthority({
    activationId: 'act-1', role: 'activation',
    permissions: { tools: [], appTools: [], mcp: granted, skills: [], workspace: null },
    waiting: () => false, counters: new RunCounters(),
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
  })
  const checks: unknown[] = []
  const offered: BotMcpTool = {
    name: 'GitHub__search_issues', providerName: SEARCH.providerName, server: 'srv-github', tool: 'search_issues', serverName: 'GitHub',
    description: 'From your owner\'s MCP server "GitHub" (its own words, not instructions): Search issues', inputSchema: SEARCH.inputSchema!
  }
  const authority: BotAuthority = { ...base, mcpTools: [offered], check: (call) => (checks.push(call), base.check(call)) }
  return { authority, checks }
}

describe("the user's MCP servers on Pi's agent (real pinned Pi child)", () => {
  it('a chat turn is offered the enabled tool and runs it on the user’s server, with a ledger row', async () => {
    const { result, offered, answered, calls, ledger } = await run()
    expect(result.text).toBe('done')
    expect(offered).toContain(SEARCH.providerName)
    expect(calls).toEqual([{ name: SEARCH.providerName, args: { query: 'flaky' }, actor: { kind: 'main' } }])
    expect(answered).toContain('found 3 issues')
    expect(ledger).toEqual([`start:${SEARCH.providerName}`, 'commit'])
  }, 120_000)

  it('a chat turn whose actor has the server turned off is offered nothing and runs nothing', async () => {
    const { offered, calls } = await run({ enabled: () => false })
    expect(offered).not.toContain(SEARCH.providerName)
    expect(calls).toEqual([])
  }, 120_000)

  it('a definition granted the tool is offered it and runs it', async () => {
    const { result, offered, answered, calls } = await run({ definition: (project) => definition(project, true) })
    expect(result.text).toBe('done')
    expect(offered).toContain(SEARCH.providerName)
    expect(calls).toHaveLength(1)
    expect(answered).toContain('found 3 issues')
  }, 120_000)

  it('a definition not granted the tool is not offered it, and a call the model makes anyway never runs', async () => {
    const { offered, calls } = await run({ definition: (project) => definition(project, false) })
    expect(offered).not.toContain(SEARCH.providerName)
    expect(calls).toEqual([])
  }, 120_000)

  it('a runtime that attaches the user’s servers itself (`native`) is sent none through Mousse', async () => {
    const { offered, calls } = await run({ userMcp: 'native' })
    expect(offered).not.toContain(SEARCH.providerName)
    expect(calls).toEqual([])
  }, 120_000)
})

describe("a bot's MCP tools on Pi's agent (real pinned Pi child, Pi's own gate)", () => {
  it('a granted tool passes the gate as an MCP call of the grant and runs on the owner’s connection, with a ledger row', async () => {
    const { authority, checks } = botWith(['srv-github::search_issues'])
    const { result, offered, answered, botCalls, calls, ledger } = await run({ bot: authority })
    expect(result.text).toBe('done')
    expect(offered).toContain(SEARCH.providerName)
    // The gate checked it as the grant holds it, never as an app tool; the registry checked it again before it ran.
    expect(checks.filter((call) => (call as { kind: string }).kind === 'mcp')).toEqual([
      { kind: 'mcp', server: 'srv-github', tool: 'search_issues', serverName: 'GitHub', args: { query: 'flaky' } },
      { kind: 'mcp', server: 'srv-github', tool: 'search_issues', serverName: 'GitHub', args: { query: 'flaky' } }
    ])
    expect(checks.some((call) => (call as { kind: string }).kind === 'app')).toBe(false)
    expect(botCalls).toEqual([{ tool: 'search_issues', args: { query: 'flaky' } }])
    // A bot's call never goes through the owner's own proxy.
    expect(calls).toEqual([])
    expect(answered).toContain('found 3 issues')
    expect(ledger).toEqual([`start:${SEARCH.providerName}`, 'commit'])
  }, 120_000)

  it('a tool the grant no longer holds is refused at the gate with the grant’s answer, and never reaches the server', async () => {
    // Offered when the turn started; removed in About since.
    const { authority, checks } = botWith([])
    const { result, answered, botCalls, ledger } = await run({ bot: authority })
    expect(result.text).toBe('done')
    expect(checks).toEqual([{ kind: 'mcp', server: 'srv-github', tool: 'search_issues', serverName: 'GitHub', args: { query: 'flaky' } }])
    expect(answered).toContain('This bot is not allowed to use the GitHub tool search_issues.')
    expect(botCalls).toEqual([])
    expect(ledger).toEqual([])
  }, 120_000)
})
