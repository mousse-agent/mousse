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
import { harness, script, setup } from './piRpcEngineFixture'

// PR 4 4b2: a definition's authority over Pi's built-in tools, at the gate (`/pi/gate`), on the real
// pinned Pi child. Every refusal is proven by the file system (a write that never happened, a read
// whose content never reached the model's tool result). Fake key, local mock only.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function policy(project: string, overrides: { workspace?: Partial<AgentRuntimePolicy['workspace']>; script?: Partial<AgentRuntimePolicy['script']>; approval?: Partial<AgentRuntimePolicy['approval']>; source?: AgentRuntimePolicy['source'] } = {}): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1',
    source: overrides.source ?? 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [project], ...overrides.workspace },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [], ...overrides.script },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause', ...overrides.approval },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

function grants(...tools: string[]): EffectiveAgentGrants {
  return { skills: [], mcpTools: [], builtinTools: tools.map((id) => ({ id, source: 'definition' as never })), denied: [] }
}

const ALL = ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find']

/** One turn whose model calls `calls` in order, under `definition`; returns the tool results. */
async function run(definition: (project: string) => DefinitionAuthority, calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const { engine, recorder, project } = await setup(cleanups)
  recorder.respond(script([...calls.map((tool) => ({ tool })), { text: 'done' }]))
  const turn = harness(project, {}, { definition: definition(project) })
  const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
  expect(result.text).toBe('done')
  const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
  const starts = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'start')
  return { project, results, starts }
}

const refused = (event: { summary?: unknown }) => event.summary === 'The tool returned an error.'

describe('a definition’s authority over Pi’s built-in tools (Pi RPC engine, real child)', () => {
  it('read-only denies write; scripts off deny bash; a tool outside the grants is refused', async () => {
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
    expect(String(notGranted.results[0].response)).toContain('not granted')
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

  it('an app tool the definition refuses is refused at the gate and costs no tool call, as a refused built-in does', async () => {
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
    expect(String(results[0].response)).toContain('not granted')
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
})
