import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { RunCounters, TurnBudget } from '../../src/mms/harness/budget'
import { ToolRegistry, type MousseTool } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import { appTurn } from '../run/appToolsFixture'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import type { AdapterHost } from '../../src/mms/run/adapters/ProviderAdapter'
import { PI_RPC_EXACT_CAPS } from '../../src/mms/harness/drivers/pi'
import { harness, script, setup, type SetupOptions } from './piRpcEngineFixture'
import { createDefinitionBrowserBinding } from '../../src/mms/orchestrator/browser/binding'
import { browserTools } from '../../src/mms/run/mcp/appTools/browser'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'

// PR 4 4b2: a definition's authority over Pi's built-in tools, at the gate (`/pi/gate`), on the real
// pinned Pi child. Every refusal is proven by the file system (a write that never happened, a read
// whose content never reached the model's tool result). Fake key, local mock only.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function policy(project: string, overrides: { workspace?: Partial<AgentRuntimePolicy['workspace']>; script?: Partial<AgentRuntimePolicy['script']>; approval?: Partial<AgentRuntimePolicy['approval']>; source?: AgentRuntimePolicy['source']; unattended?: true } = {}): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1',
    source: overrides.source ?? 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [project], ...overrides.workspace },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [], ...overrides.script },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause', ...overrides.approval },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: [],
    ...(overrides.unattended ? { unattended: true as const } : {})
  }
}

function grants(...tools: string[]): EffectiveAgentGrants {
  return { skills: [], mcpTools: [], builtinTools: tools.map((id) => ({ id, source: 'definition' as never })), denied: [] }
}

const ALL = ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find']

/** One turn whose model calls `calls` in order, under `definition`; returns the tool results. */
async function run(definition: (project: string) => DefinitionAuthority, calls: Array<{ name: string; args: Record<string, unknown> }>, host: Partial<AdapterHost> = {}, options: SetupOptions = {}) {
  const { engine, recorder, project } = await setup(cleanups, options)
  recorder.respond(script([...calls.map((tool) => ({ tool })), { text: 'done' }]))
  const turn = harness(project, {}, { definition: definition(project), ...host })
  const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
  expect(result.text).toBe('done')
  const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
  const starts = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'start')
  return { project, results, starts }
}

const refused = (event: { summary?: unknown }) => event.summary === 'The tool returned an error.'

describe('a definition’s authority over Pi’s built-in tools (Pi RPC engine, real child)', () => {
  it('read-only denies write; scripts off deny bash; a tool outside the grants is not even offered', async () => {
    const readOnly = await run((project) => ({ policy: policy(project, { workspace: { mode: 'read_only' } }), grants: grants(...ALL) }), [
      { name: 'write', args: { path: 'blocked.txt', content: 'x' } }
    ])
    expect(existsSync(join(readOnly.project, 'blocked.txt'))).toBe(false)
    expect(readOnly.results.map(refused)).toEqual([true])
    expect(String(readOnly.results[0].response)).toContain('read-only')

    const noScripts = await run((project) => ({ policy: policy(project), grants: grants(...ALL) }), [
      { name: 'bash', args: { command: 'echo ran > ran.txt' } }
    ])
    expect(existsSync(join(noScripts.project, 'ran.txt'))).toBe(false)
    expect(String(noScripts.results[0].response)).toContain('Script execution is disabled')

    const notGranted = await run((project) => ({ policy: policy(project), grants: grants('read') }), [
      { name: 'write', args: { path: 'ungranted.txt', content: 'x' } }
    ])
    expect(existsSync(join(notGranted.project, 'ungranted.txt'))).toBe(false)
    // A definition's turn is offered exactly its grants: Pi has no such tool to run.
    expect(String(notGranted.results[0].response)).toBe('Tool write not found')
  }, 120_000)

  it('a path outside the roots is denied in every form Pi would open, and a path inside runs', async () => {
    const { project, results } = await run((root) => {
      writeFileSync(join(root, '..', 'outside.txt'), 'outside-secret')
      writeFileSync(join(root, 'inside.txt'), 'inside-content')
      return { policy: policy(root), grants: grants(...ALL) }
    }, [
      { name: 'read', args: { path: '../outside.txt' } },
      { name: 'read', args: { path: '@../outside.txt' } },
      { name: 'write', args: { path: '../escaped.txt', content: 'x' } },
      { name: 'read', args: { path: '@inside.txt' } }
    ])
    expect(results.slice(0, 3).map(refused)).toEqual([true, true, true])
    for (const event of results) expect(String(event.response)).not.toContain('outside-secret')
    expect(existsSync(join(project, '..', 'escaped.txt'))).toBe(false)
    expect(refused(results[3])).toBe(false)
    expect(String(results[3].response)).toContain('inside-content')
  }, 90_000)

  it('unattended runs: deny, skip and fail refuse a write; pause asks the host', async () => {
    for (const approval of [{ policy: 'unattended_deny' as const }, { unattendedBehavior: 'skip' as const }, { unattendedBehavior: 'fail' as const }]) {
      const { project, results } = await run((root) => ({ policy: policy(root, { source: 'schedule', approval }), grants: grants(...ALL) }), [
        { name: 'write', args: { path: 'unattended.txt', content: 'x' } }
      ])
      expect(existsSync(join(project, 'unattended.txt')), JSON.stringify(approval)).toBe(false)
      expect(results.map(refused)).toEqual([true])
    }
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const { project } = await run((root) => ({
      policy: policy(root, { source: 'schedule', approval: { unattendedBehavior: 'pause' } }),
      grants: grants(...ALL),
      approve: async (request) => (asked.push(request), { status: 'denied', reason: 'not now' })
    }), [{ name: 'write', args: { path: 'paused.txt', content: 'x' } }])
    expect(asked.map((request) => request.canonicalToolName)).toEqual(['write'])
    expect(existsSync(join(project, 'paused.txt'))).toBe(false)
  }, 180_000)

  it('approval: a stale digest is refused; an approved call runs exactly the approved arguments', async () => {
    const stale = await run((root) => ({
      policy: policy(root, { approval: { policy: 'always' } }),
      grants: grants(...ALL),
      approve: async () => ({ status: 'approved', digest: 'not-the-digest' })
    }), [{ name: 'write', args: { path: 'stale.txt', content: 'x' } }])
    expect(existsSync(join(stale.project, 'stale.txt'))).toBe(false)
    expect(String(stale.results[0].response)).toContain('stale')

    const approved: AgentRuntimeToolApprovalRequest[] = []
    const { project, starts } = await run((root) => ({
      policy: policy(root, { approval: { policy: 'always' } }),
      grants: grants(...ALL),
      approve: async (request) => (approved.push(request), { status: 'approved', digest: request.argumentDigest })
    }), [{ name: 'write', args: { path: '@approved.txt', content: 'exact content' } }])
    expect(approved).toHaveLength(1)
    // Approved on the path Pi opens, and run there with the approved content.
    expect(approved[0].arguments).toEqual({ path: join(project, 'approved.txt'), content: 'exact content' })
    expect(readFileSync(join(project, 'approved.txt'), 'utf8')).toBe('exact content')
    // Nothing else was written: the call ran once, on the approved path.
    expect(readdirSync(project)).toEqual(['approved.txt'])
    expect(starts).toHaveLength(1)
  }, 120_000)

  it('an app tool the definition does not grant is not offered and costs no tool call, as an ungranted built-in', async () => {
    const { engine, recorder, project } = await setup(cleanups, {
      mousseTools: () => [{ name: 'create_task', description: 'Create a task', inputSchema: { type: 'object', properties: { description: { type: 'string' } } }, class: 'mutation' }]
    })
    recorder.respond(script([
      { tool: { name: 'create_task', args: { description: 'not granted' } } },
      { tool: { name: 'write', args: { path: 'granted.txt', content: 'ok' } } },
      { text: 'done' }
    ]))
    const counters = new RunCounters()
    const turn = harness(project, {}, {
      definition: { policy: policy(project), grants: grants('write') },
      budget: new TurnBudget({ maxToolCalls: 1 }, counters),
      // Nothing listens here: a refused call never reaches the Mousse MCP server.
      bridge: { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused' }, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' }
    })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result.text).toBe('done')
    const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(String(results[0].response)).toBe('Tool create_task not found')
    // The refused app tool cost nothing: the one allowed call was the granted write.
    expect(readFileSync(join(project, 'granted.txt'), 'utf8')).toBe('ok')
    expect(counters.toolCalls).toBe(1)
  }, 90_000)

  /**
   * A definition run whose app tool `create_task` runs through the real Mousse tool registry behind
   * a local MCP endpoint, with `maxToolCalls: 1`. The model calls `create_task`, then `write`.
   */
  async function appToolRun(approve: (request: AgentRuntimeToolApprovalRequest) => { status: 'approved' | 'denied'; digest?: string; reason?: string }, appArgs: Record<string, unknown> = { description: 'a task' }) {
    const { engine, recorder, project } = await setup(cleanups, {
      mousseTools: () => [{ name: 'create_task', description: 'Create a task', inputSchema: { type: 'object', properties: { description: { type: 'string' } } }, class: 'mutation' }]
    })
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const definition: DefinitionAuthority = {
      policy: policy(project, { approval: { policy: 'always' } }),
      grants: grants('create_task', 'write'),
      approve: async (request) => (asked.push(request), approve(request))
    }
    const turns = new AppToolTurns()
    turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', projectPath: project, definition }))
    const ran: unknown[] = []
    const registry = new ToolRegistry({ activeRunId: () => 'r1', turns })
    registry.register({ name: 'create_task', description: 'Create a task', inputSchema: {}, access: 'actsAsCaller', class: 'mutation', handler: async (args) => (ran.push(args), { text: 'created' }) } as unknown as MousseTool)
    // A minimal MCP endpoint: the call id as the MCP server derives it from `clientRequestId`.
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const call = JSON.parse(body) as { id: string; params: { name: string; arguments: Record<string, unknown> } }
      const { clientRequestId, ...args } = call.params.arguments
      const outcome = await registry.call(call.params.name, args, {
        credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', binding: 'per_call', current: () => true },
        toolCallId: `mcp:${String(clientRequestId)}`,
        signal: new AbortController().signal
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError } }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    recorder.respond(script([
      { tool: { name: 'create_task', args: appArgs } },
      { tool: { name: 'write', args: { path: 'allowed.txt', content: 'ok' } } },
      { text: 'done' }
    ]))
    const counters = new RunCounters()
    const turn = harness(project, {}, {
      definition,
      budget: new TurnBudget({ maxToolCalls: 1 }, counters),
      bridge: { mcp: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: 'fake' }, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' }
    })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    return { result, asked, ran, counters, project }
  }

  it('the browser: Pi is sent the granted browser tools as the turn’s binding offers them, and they run on the browser over MCP, each costing a tool call', async () => {
    // A local browser stand-in: it records what reached it and loads no page.
    const dispatched: Array<{ name: string; args: unknown; runId?: string }> = []
    const runtime: BrowserRuntimePort = {
      resolveTarget: () => ({ backend: 'managed-chromium' }),
      dispatch: async (context, name, args) => (dispatched.push({ name, args, ...(context.execution.runId ? { runId: context.execution.runId } : {}) }), { observationId: 'obs-1' })
    }
    const turns = new AppToolTurns()
    const registry = new ToolRegistry({ activeRunId: () => 'r1', turns })
    for (const tool of browserTools({ browserRuntime: () => runtime } as unknown as AppToolHost)) registry.register(tool)
    // The Pi driver's own wiring (`piProfileInputs`): a definition turn's tools as its loop sends them.
    const { engine, recorder, project } = await setup(cleanups, { mousseTools: (threadId, runId) => registry.listForTurn(threadId, runId) })
    const granted = ['browser_open', 'browser_observe', 'browser_screenshot']
    const definition: DefinitionAuthority = { policy: policy(project), grants: grants(...granted) }
    const browser = createDefinitionBrowserBinding({
      request: { profileId: 'default', threadId: 't1', source: 'editor' } as never,
      runId: 'definition-run',
      resolved: { definitionId: 'def-1', revision: 'rev-1', settings: { browser: { mode: 'structured' }, limits: { maxToolCalls: 10, maxElapsedMs: 60_000 } }, grants: grants(...granted) } as never
    })!
    turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', projectPath: project, definition, browser }))
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const call = JSON.parse(body) as { id: string; params: { name: string; arguments: Record<string, unknown> } }
      const { clientRequestId, ...args } = call.params.arguments
      const outcome = await registry.call(call.params.name, args, {
        credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage', binding: 'per_call', current: () => true },
        toolCallId: `mcp:${String(clientRequestId)}`,
        signal: new AbortController().signal
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError } }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    recorder.respond(script([
      { tool: { name: 'browser_open', args: { url: 'http://127.0.0.1:9/local-page' } } },
      { tool: { name: 'browser_act', args: { sessionId: 's', tabId: 't', generation: 1, observationId: 'o', controlLeaseId: 'l', action: { type: 'reload' } } } },
      { text: 'done' }
    ]))
    const counters = new RunCounters()
    const turn = harness(project, {}, {
      definition,
      budget: new TurnBudget({ maxToolCalls: 5 }, counters),
      bridge: { mcp: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: 'fake' }, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' }
    })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result.text).toBe('done')
    // Sent exactly the granted tools the binding offers (no screenshot for a model without vision),
    // with the turn's schema, and nothing of Mousse's browser instructions besides it.
    const sent = ((JSON.parse(recorder.requests[0]!.body) as { tools?: Array<{ function: { name: string; description: string; parameters: unknown } }> }).tools ?? []).map((tool) => tool.function)
    expect(sent.map((tool) => tool.name).sort()).toEqual(['browser_observe', 'browser_open'])
    expect(sent.find((tool) => tool.name === 'browser_observe')!.description).toContain('Do not request screenshots')
    expect(recorder.requests[0]!.body).toContain('You are a test agent.')
    // The granted call ran on the browser under the definition run's binding; the ungranted one was
    // never offered, so Pi had no such tool, and it cost nothing.
    expect(dispatched).toEqual([{ name: 'browser_open', args: { url: 'http://127.0.0.1:9/local-page' }, runId: 'definition-run' }])
    const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(String(results[1]!.response)).toBe('Tool browser_act not found')
    expect(counters.toolCalls).toBe(1)
  }, 90_000)

  it('an app tool whose approval is denied costs no tool call, and is asked once', async () => {
    const { result, asked, ran, counters, project } = await appToolRun((request) =>
      request.toolName === 'create_task' ? { status: 'denied', reason: 'No task please' } : { status: 'approved', digest: request.argumentDigest })
    expect(asked.map((request) => request.toolName)).toEqual(['create_task', 'write'])
    expect(ran).toEqual([])
    // The one allowed call was the approved write.
    expect(readFileSync(join(project, 'allowed.txt'), 'utf8')).toBe('ok')
    expect(counters.toolCalls).toBe(1)
    expect(result).toMatchObject({ text: 'done' })
  }, 90_000)

  it('an app tool approved with a stale digest costs no tool call', async () => {
    const { result, ran, counters, project } = await appToolRun((request) =>
      request.toolName === 'create_task' ? { status: 'approved', digest: 'stale' } : { status: 'approved', digest: request.argumentDigest })
    expect(ran).toEqual([])
    expect(readFileSync(join(project, 'allowed.txt'), 'utf8')).toBe('ok')
    expect(counters.toolCalls).toBe(1)
    expect(result).toMatchObject({ text: 'done' })
  }, 90_000)

  it('an approved app tool is asked once, runs once with the approved arguments, and uses the call', async () => {
    const { result, asked, ran, counters, project } = await appToolRun((request) => ({ status: 'approved', digest: request.argumentDigest }))
    // Each call was asked once, at the gate (the registry took that authorization at dispatch);
    // the write was approved and then refused by the limit, before it ran.
    expect(asked.map((request) => request.toolName)).toEqual(['create_task', 'write'])
    expect(asked[0].arguments).toEqual({ description: 'a task' })
    expect(ran).toEqual([{ description: 'a task' }])
    expect(counters.toolCalls).toBe(1)
    // The write past the limit never ran, and the run ended on the limit.
    expect(existsSync(join(project, 'allowed.txt'))).toBe(false)
    expect(result).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'tool_calls', limit: 1, actual: 1 } } })
  }, 90_000)

  it('a model-supplied clientRequestId is not part of the approved call: asked once, run once', async () => {
    const { asked, ran, counters } = await appToolRun((request) => ({ status: 'approved', digest: request.argumentDigest }), { description: 'a task', clientRequestId: 'model-chosen-id' })
    // The approver saw the call as the tool runs it; the registry did not ask again after the charge.
    expect(asked.map((request) => [request.toolName, request.arguments])).toEqual([['create_task', { description: 'a task' }], ['write', expect.anything()]])
    expect(ran).toEqual([{ description: 'a task' }])
    expect(counters.toolCalls).toBe(1)
  }, 90_000)

  it('the run stops being the thread’s active run while a built-in waits for approval: it is refused and nothing is written', async () => {
    let active = true
    const { project, results } = await run((root) => ({
      policy: policy(root, { approval: { policy: 'always' } }),
      grants: grants(...ALL),
      // The run ends elsewhere (or another takes the thread) during the approval, which then says yes.
      approve: async (request) => { active = false; return { status: 'approved', digest: request.argumentDigest } }
    }), [{ name: 'write', args: { path: 'late.txt', content: 'x' } }], { tools: { runActive: () => active } })
    expect(existsSync(join(project, 'late.txt'))).toBe(false)
    expect(results.map(refused)).toEqual([true])
  }, 90_000)

  it('a built-in has a started ledger row before it runs, settled after: committed when it succeeds, failed when it fails', async () => {
    const rows: Array<{ id: string; name: string; idempotent: boolean | undefined; outcome?: string }> = []
    const toolLedger = {
      start: (call: { id: string; name: string }, options?: { idempotent?: boolean }) => {
        const id = `row-${rows.length + 1}`
        rows.push({ id, name: call.name, idempotent: options?.idempotent })
        return id
      },
      commit: (id: string) => void (rows.find((row) => row.id === id)!.outcome = 'committed'),
      failed: (id: string) => void (rows.find((row) => row.id === id)!.outcome = 'failed')
    }
    const { project } = await run((root) => ({ policy: policy(root), grants: grants(...ALL) }), [
      { name: 'write', args: { path: 'ledgered.txt', content: 'ok' } },
      { name: 'read', args: { path: 'missing.txt' } }
    ], { tools: { toolLedger: toolLedger as never } })
    expect(readFileSync(join(project, 'ledgered.txt'), 'utf8')).toBe('ok')
    expect(rows).toEqual([
      { id: 'row-1', name: 'write', idempotent: false, outcome: 'committed' },
      { id: 'row-2', name: 'read', idempotent: true, outcome: 'failed' }
    ])
  }, 90_000)

  it('a tool offered beyond the grants is still refused by the gate itself (not granted), and nothing is written', async () => {
    const { project, results } = await run((root) => ({ policy: policy(root), grants: grants('read') }), [
      { name: 'write', args: { path: 'beyond.txt', content: 'x' } }
    ], { bridge: { mcp: null, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy', toolPolicy: { allow: ['read', 'write'] } } })
    expect(existsSync(join(project, 'beyond.txt'))).toBe(false)
    expect(String(results[0].response)).toContain('not granted')
  }, 90_000)
})

// #299: where Pi's shell is not contained (a no-shell record: `weak` containment, the fixture's
// default), a definition's shell command asks a person first whatever its grants say, the approval
// bound to the exact command, and an unattended run runs none. Where it is contained, grants decide.
describe('a definition’s shell where Pi’s shell is not contained (Pi RPC engine, real child)', () => {
  const scripts = { enabled: true, allowFilesystem: true }
  const shell = (file: string) => ({ name: 'bash', args: { command: `echo ran > ${file}` } })

  it('asks a person before every command, even under grants that ask nothing; the approval is bound to the exact command', async () => {
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const approved = await run((root) => ({
      policy: policy(root, { script: scripts }),
      grants: grants(...ALL),
      approve: async (request) => (asked.push(request), { status: 'approved', digest: request.argumentDigest })
    }), [shell('approved.txt')])
    expect(asked.map((request) => [request.canonicalToolName, request.classification, request.arguments])).toEqual([['bash', 'script', { command: 'echo ran > approved.txt' }]])
    expect(readFileSync(join(approved.project, 'approved.txt'), 'utf8').trim()).toBe('ran')

    const denied = await run((root) => ({
      policy: policy(root, { script: scripts }),
      grants: grants(...ALL),
      approve: async () => ({ status: 'denied', reason: 'not this one' })
    }), [shell('denied.txt')])
    expect(existsSync(join(denied.project, 'denied.txt'))).toBe(false)
    expect(String(denied.results[0].response)).toContain('not this one')

    // An approval of another command (its digest) never runs this one.
    const other = await run((root) => ({
      policy: policy(root, { script: scripts }),
      grants: grants(...ALL),
      approve: async () => ({ status: 'approved', digest: 'digest-of-another-command' })
    }), [shell('other.txt')])
    expect(existsSync(join(other.project, 'other.txt'))).toBe(false)
    expect(String(other.results[0].response)).toContain('stale')
  }, 180_000)

  it('an unattended run (a workflow node, a schedule, a dispatch) runs no shell command, and nobody is asked', async () => {
    for (const unattended of [{ source: 'cli' as const, unattended: true as const }, { source: 'workflow' as const, unattended: true as const }]) {
      const asked: AgentRuntimeToolApprovalRequest[] = []
      const { project, results } = await run((root) => ({
        policy: policy(root, { script: scripts, ...unattended }),
        grants: grants(...ALL),
        approve: async (request) => (asked.push(request), { status: 'approved', digest: request.argumentDigest })
      }), [shell('unattended.txt'), { name: 'write', args: { path: 'written.txt', content: 'x' } }])
      expect(asked.map((request) => request.canonicalToolName), JSON.stringify(unattended)).toEqual([])
      expect(existsSync(join(project, 'unattended.txt'))).toBe(false)
      expect(String(results[0].response)).toContain("Shell commands can't run in an unattended agent run")
      // Its other tools still run under its grants.
      expect(readFileSync(join(project, 'written.txt'), 'utf8')).toBe('x')
    }
  }, 180_000)

  it('a run with no way to ask a person is refused, saying why', async () => {
    const { project, results } = await run((root) => ({ policy: policy(root, { script: scripts }), grants: grants(...ALL) }), [shell('unasked.txt')])
    expect(existsSync(join(project, 'unasked.txt'))).toBe(false)
    expect(String(results[0].response)).toContain('Shell commands ask a person first on this platform')
  }, 90_000)

  it('where the shell is contained (strong), the same command runs under its grants without asking', async () => {
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const { project } = await run((root) => ({
      policy: policy(root, { script: scripts }),
      grants: grants(...ALL),
      approve: async (request) => (asked.push(request), { status: 'denied' })
    }), [shell('contained.txt')], {}, { capabilities: PI_RPC_EXACT_CAPS })
    expect(asked).toEqual([])
    expect(readFileSync(join(project, 'contained.txt'), 'utf8').trim()).toBe('ran')
  }, 90_000)
})
