/**
 * Old tool names as hidden aliases (docs/plans/tool-api.md §4): an old name is not listed, but a call under it is the
 * new name's call from the first step, over the Mousse MCP server. It meets the same checks and keeps the same receipt,
 * so a retry under either name is the same request.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { claudeChildToolDenial } from '../../src/mms/harness/vendors/claude/childPolicy'
import { StaticAgentIntegrationLookup } from '../../src/mms/agentDefinitions/lookups'
import { resolveBuiltinToolGrants } from '../../src/shared/agents/grants'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import { definitionToolGranted, recordAuthorizedCall, takeAuthorizedCall, type DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { readRefusal } from '../../src/mms/run/mcp/appTools'
import type { AppToolTurn } from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

type RpcBody = { result?: { tools?: Array<{ name: string }>; content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: { code: number } }

describe('an old tool name', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async (turn: Partial<AppToolTurn> = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns } = appToolRegistry(fx.engine, fake.host)
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, ...turn }))
    const token = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, modeCeiling: 'default', binding: 'drained_turn', generation: 'g' })!.token
    const rpc = async (method: string, params: Record<string, unknown>): Promise<RpcBody> => {
      const response = await fetch(server!.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      return (await response.json()) as RpcBody
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const body = await rpc('tools/call', { name, arguments: args })
      expect(body.error).toBeUndefined()
      return { isError: body.result!.isError === true, text: body.result!.content![0].text }
    }
    return { rpc, call, tasks: fake.tasks }
  }

  it('is not listed, but is callable', async () => {
    const { rpc, call, tasks } = await setup()
    const listed = (await rpc('tools/list', {})).result!.tools!.map((tool) => tool.name)
    expect(listed).toContain('task_create')
    expect(listed).not.toContain('create_task')

    const created = await call('create_task', { description: 'Write the release notes' })
    expect(created.isError).toBe(false)
    expect(tasks.list().map((task) => task.description)).toEqual(['Write the release notes'])
  })

  it('and its new name are one request under the same clientRequestId: the retry replays the first result', async () => {
    const { call, tasks } = await setup()
    const first = await call('create_task', { description: 'Check the build', clientRequestId: 'retry-1' })
    const retried = await call('task_create', { description: 'Check the build', clientRequestId: 'retry-1' })
    expect(retried).toEqual(first)
    expect(tasks.list()).toHaveLength(1)
    // A new request key is a new task.
    await call('task_create', { description: 'Check the build', clientRequestId: 'retry-2' })
    expect(tasks.list()).toHaveLength(2)
  })

  it('gets the refusal its new name gets in a turn that lacks the tool', async () => {
    const { call, tasks } = await setup({ settingsEnabled: (name) => name !== 'task_create' })
    const refusedNew = await call('task_create', { description: 'One' })
    const refusedOld = await call('create_task', { description: 'One' })
    expect(readRefusal(refusedNew.text)).not.toBeNull()
    expect(refusedOld).toEqual(refusedNew)
    expect(tasks.list()).toEqual([])
  })
})

describe("an agent definition's saved grant of an old tool name", () => {
  const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: ['skill_list', 'read'] })

  it('grants the new tool when the definition lists its tools', () => {
    const { grants } = resolveBuiltinToolGrants({ mode: 'explicit', allowlist: ['list_skills'] }, lookup)
    expect(grants.map((grant) => grant.id)).toEqual(['skill_list'])
  })

  it('keeps the new tool when the definition narrows the tools it inherits', () => {
    const { grants } = resolveBuiltinToolGrants({ mode: 'inherit', allowlist: ['list_skills'] }, lookup)
    expect(grants.map((grant) => grant.id)).toEqual(['skill_list'])
  })
})

describe("an agent definition's grant of an old queue tool", () => {
  const holding = (...ids: string[]): EffectiveAgentGrants => ({ skills: [], mcpTools: [], builtinTools: ids.map((id) => ({ id, source: 'explicit' as const })), denied: [] })

  it('holds the one op of queue_update that tool was, and a grant of queue_update holds every op', () => {
    const rows: Array<[grant: string, called: string, args: Record<string, unknown>, held: boolean]> = [
      ['queue_edit', 'queue_update', { op: 'edit' }, true],
      ['queue_edit', 'queue_update', { op: 'send_now' }, false],
      ['queue_edit', 'queue_update', {}, false],
      ['queue_reorder', 'queue_update', { op: 'move' }, true],
      ['queue_reorder', 'queue_update', { op: 'remove' }, false],
      ['queue_promote_to_steer', 'queue_update', { op: 'send_now' }, true],
      // Called under the old name, the call is that op whatever op it names.
      ['queue_edit', 'queue_edit', { op: 'send_now' }, true],
      ['queue_edit', 'queue_promote_to_steer', {}, false],
      ['queue_update', 'queue_update', { op: 'send_now' }, true],
      ['queue_update', 'queue_remove', {}, true]
    ]
    for (const [grant, called, args, held] of rows) expect(definitionToolGranted(called, holding(grant), [], args), `${grant} → ${called} ${JSON.stringify(args)}`).toBe(held)
  })

  it('stays that op when the definition is resolved: it never becomes all of queue_update', () => {
    const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: ['queue_update'] })
    for (const mode of ['explicit', 'inherit'] as const) {
      const { grants } = resolveBuiltinToolGrants({ mode, allowlist: ['queue_edit'] }, lookup)
      expect(definitionToolGranted('queue_update', { skills: [], mcpTools: [], builtinTools: grants, denied: [] }, [], { op: 'send_now' }), mode).toBe(false)
    }
  })

  it("a runtime gate's approval of a call under the old name is taken by the registry's call under the new one, and only for that op", () => {
    const authority = { grants: holding('queue_edit') } as DefinitionAuthority
    const call = { turnToken: 't', callId: 'c1', args: { itemId: 'i1', content: 'x', expectedRevision: 'r1' } }
    recordAuthorizedCall(authority, { ...call, toolName: 'queue_edit' })
    expect(takeAuthorizedCall(authority, { ...call, toolName: 'queue_update', args: { ...call.args, op: 'send_now' } })).toBe(false)
    recordAuthorizedCall(authority, { ...call, toolName: 'queue_edit' })
    expect(takeAuthorizedCall(authority, { ...call, toolName: 'queue_update', args: { ...call.args, op: 'edit' } })).toBe(true)
  })
})

describe("a read-only Claude subagent's call under an old name", () => {
  it('passes the gate its new name passes', () => {
    for (const [old, renamed] of [['list_models', 'model_list'], ['load_skill', 'skill_load'], ['list_skills', 'skill_list'], ['list_computers', 'computer_list']]) {
      expect(claudeChildToolDenial({ readOnly: true }, `mcp__mousse__${renamed}`), renamed).toBeUndefined()
      expect(claudeChildToolDenial({ readOnly: true }, `mcp__mousse__${old}`), old).toBeUndefined()
    }
  })
})
