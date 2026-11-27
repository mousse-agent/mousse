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
import { canonicalToolCall } from '../../src/shared/toolAliases'
import { definitionToolGranted } from '../../src/mms/agentDefinitions/definitionGate'
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

describe("a read-only Claude subagent's call under an old name", () => {
  it('passes the gate its new name passes', () => {
    for (const [old, renamed] of [['list_models', 'model_list'], ['load_skill', 'skill_load'], ['list_skills', 'skill_list'], ['list_computers', 'computer_list']]) {
      expect(claudeChildToolDenial({ readOnly: true }, `mcp__mousse__${renamed}`), renamed).toBeUndefined()
      expect(claudeChildToolDenial({ readOnly: true }, `mcp__mousse__${old}`), old).toBeUndefined()
    }
  })
})

describe("the thread family's old names", () => {
  it('are one variant of their new tool: the call is translated before anything checks it', () => {
    expect(canonicalToolCall('thread_interrupt', { threadId: 't', runId: 'r' })).toEqual({ name: 'thread_stop', args: { threadId: 't', runId: 'r' } })
    expect(canonicalToolCall('thread_merge_back', { threadId: 't' })).toEqual({ name: 'thread_return', args: { threadId: 't' } })
    expect(canonicalToolCall('thread_hide', { threadId: 't' })).toEqual({ name: 'thread_update', args: { threadId: 't', hidden: true } })
    expect(canonicalToolCall('thread_hide', { threadId: 't', hidden: false })).toEqual({ name: 'thread_update', args: { threadId: 't', hidden: false } })
    expect(canonicalToolCall('thread_steer', { threadId: 't', runId: 'r', text: 'Also check the tests' })).toEqual({ name: 'thread_send', args: { threadId: 't', runId: 'r', content: 'Also check the tests', intent: 'note' } })
    // A new name passes through as it is.
    expect(canonicalToolCall('thread_send', { threadId: 't', content: 'Go', intent: 'work' })).toEqual({ name: 'thread_send', args: { threadId: 't', content: 'Go', intent: 'work' } })
  })

  const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: ['thread_send', 'thread_update', 'thread_stop'] })
  const grantsOf = (allowlist: string[]): EffectiveAgentGrants => ({ skills: [], mcpTools: [], denied: [], builtinTools: resolveBuiltinToolGrants({ mode: 'explicit', allowlist }, lookup).grants })

  it("in a definition's grant hold only their own variant of the new tool", () => {
    const grants = grantsOf(['thread_steer', 'thread_hide'])
    expect(grants.builtinTools.map((grant) => [grant.id, grant.variants])).toEqual([['thread_send', ['thread_steer']], ['thread_update', ['thread_hide']]])
    // A steer grant sends notes, under either name, and never work.
    expect(definitionToolGranted('thread_send', grants, [], { threadId: 't', content: 'Note', intent: 'note' })).toBe(true)
    expect(definitionToolGranted('thread_steer', grants, [], { threadId: 't', runId: 'r', text: 'Note' })).toBe(true)
    expect(definitionToolGranted('thread_send', grants, [], { threadId: 't', content: 'Do this', intent: 'work' })).toBe(false)
    expect(definitionToolGranted('thread_send', grants, [], { threadId: 't', content: 'Do this' })).toBe(false)
    // A hide grant hides and shows, and never changes a subagent's access.
    expect(definitionToolGranted('thread_update', grants, [], { threadId: 't', hidden: true })).toBe(true)
    expect(definitionToolGranted('thread_hide', grants, [], { threadId: 't' })).toBe(true)
    expect(definitionToolGranted('thread_update', grants, [], { threadId: 't', access: { readOnly: false } })).toBe(false)
    expect(definitionToolGranted('thread_stop', grants, [], { threadId: 't', runId: 'r' })).toBe(false)
  })

  it("in a definition's grant beside the new name add nothing: the new name holds every variant", () => {
    const grants = grantsOf(['thread_steer', 'thread_send', 'thread_interrupt'])
    expect(grants.builtinTools.map((grant) => [grant.id, grant.variants])).toEqual([['thread_send', undefined], ['thread_stop', undefined]])
    expect(definitionToolGranted('thread_send', grants, [], { threadId: 't', content: 'Do this', intent: 'work' })).toBe(true)
    expect(definitionToolGranted('thread_stop', grants, [], { threadId: 't', runId: 'r' })).toBe(true)
  })
})
