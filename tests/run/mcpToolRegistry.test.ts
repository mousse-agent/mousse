import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import {
  createMousseToolRegistry,
  McpToolError,
  ToolRegistry,
  type McpCaller,
  type MousseToolHost,
  type ToolCallContext
} from '../../src/mms/run/mcp/toolRegistry'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const PHASE5_TOOLS: Record<string, string> = {
  delegate_task: 'actsAsCaller',
  task_status: 'actsAsCaller',
  task_cancel: 'actsAsCaller',
  list_delegations: 'actsAsCaller',
  integrate_delegation: 'actsAsCaller',
  ask_user: 'actsAsCaller',
  present_plan: 'actsAsCaller',
  create_task: 'actsAsCaller',
  update_task: 'actsAsCaller',
  list_tasks: 'actsAsCaller',
  thread_read: 'reads',
  queue_list: 'reads',
  queue_enqueue: 'writesThreads',
  // Phase 6 (SPEC §16.2).
  thread_fork: 'startsThreads',
  thread_merge_back: 'writesThreads'
}

function fakeHost() {
  const delegation: DelegationToolHost = {
    delegateTask: vi.fn(async (input) => ({ delegationId: 'd1', input })),
    taskStatus: vi.fn(() => ({ status: 'running' })),
    taskCancel: vi.fn(async () => ({ cancelled: [] })),
    listDelegations: vi.fn(() => []),
    integrateDelegation: vi.fn(async () => ({ status: 'queued' })),
    named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn(), integrate: vi.fn(), list: vi.fn() }
  }
  const tasks = new TaskQueue()
  const enqueued: Array<{ threadId: string; input: unknown }> = []
  const host: MousseToolHost = {
    delegation: vi.fn(() => delegation),
    askUser: vi.fn(async () => ({ q1: 'a' })),
    presentPlan: vi.fn(),
    tasks: () => tasks,
    listQueue: () => [],
    enqueue: (threadId, input) => {
      enqueued.push({ threadId, input })
      return { id: 'item-1' }
    }
  }
  return { host, delegation, tasks, enqueued }
}

describe('Mousse tool registry (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const setup = async (modeCeiling: McpCaller['modeCeiling'] = 'default') => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const fake = fakeHost()
    const registry = createMousseToolRegistry({ engine: fx.engine, host: fake.host })
    const caller: McpCaller = { threadId: 'parent', runId: run.runId, provider: 'claude-subscription', modeCeiling }
    const ctx = (overrides: Partial<ToolCallContext> = {}): ToolCallContext => ({
      caller, toolCallId: `mcp:${Math.random()}`, signal: new AbortController().signal, ...overrides
    })
    return { fx, run, registry, caller, ctx, ...fake }
  }

  it('refuses a tool registered without an access class', () => {
    const registry = new ToolRegistry({ activeRunId: () => 'run-1' })
    const tool = { name: 'x', description: 'x', inputSchema: { type: 'object' }, handler: () => ({ text: '' }) }
    expect(() => registry.register(tool as never)).toThrow(/no access class/)
    expect(() => registry.register({ ...tool, access: 'admin' } as never)).toThrow(/no access class/)
    registry.register({ ...tool, access: 'reads' })
    expect(() => registry.register({ ...tool, access: 'reads' })).toThrow(/already registered/)
  })

  it('registers every Phase 5 tool with its access class and a JSON schema', async () => {
    const { registry } = await setup()
    const tools = registry.list()
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.access]))).toEqual(PHASE5_TOOLS)
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(Object.getOwnPropertySymbols(tool.inputSchema)).toEqual([])
    }
    expect((registry.get('delegate_task')!.inputSchema.properties as Record<string, unknown>).modeCeiling).toBeTruthy()
  })

  it('refuses writesThreads to another thread with mousse_scope_denied', async () => {
    const { registry, ctx, enqueued } = await setup()
    const denied = await registry.call('queue_enqueue', { content: 'hi', threadId: 'other' }, ctx()).catch((error) => error)
    expect(denied).toBeInstanceOf(McpToolError)
    expect(denied.code).toBe('mousse_scope_denied')
    expect(enqueued).toEqual([])
    const ok = await registry.call('queue_enqueue', { content: 'hi' }, ctx())
    expect(ok.isError).toBeUndefined()
    expect(enqueued).toEqual([{ threadId: 'parent', input: { content: 'hi', mode: 'agent' } }])
  })

  it('limits thread_read to the caller and its lineage', async () => {
    const { fx, registry, run, ctx } = await setup()
    await fx.delegate(run.runId, 'call-1')
    const own = JSON.parse((await registry.call('thread_read', {}, ctx())).text)
    expect(own.threadId).toBe('parent')
    expect(own.events.length).toBeGreaterThan(0)
    const child = JSON.parse((await registry.call('thread_read', { threadId: 'child-1' }, ctx())).text)
    expect(child.events.some((event: { type: string }) => event.type === 'thread.lineage')).toBe(true)
    await fx.runningRun('stranger')
    const denied = await registry.call('thread_read', { threadId: 'stranger' }, ctx()).catch((error) => error)
    expect(denied.code).toBe('mousse_scope_denied')
    const badLimit = await registry.call('thread_read', { limit: 0 }, ctx())
    expect(badLimit.isError).toBe(true)
  })

  it('assertLiveCaller: the call acts as the thread\'s active run; none gives mousse_caller_not_live', async () => {
    const { fx, registry, run, ctx, host, delegation } = await setup()
    // The credential still names an older run; the call acts as the active one.
    await registry.call('list_delegations', {}, ctx({ caller: { threadId: 'parent', runId: 'run:stale', provider: 'p', modeCeiling: 'default' } }))
    expect(host.delegation).toHaveBeenLastCalledWith(expect.objectContaining({ runId: run.runId }))
    expect(delegation.listDelegations).toHaveBeenCalled()
    fx.engine.markTerminal(run.runId, 'completed')
    const error = await registry.call('list_tasks', {}, ctx()).catch((err) => err)
    expect(error).toBeInstanceOf(McpToolError)
    expect(error.code).toBe('mousse_caller_not_live')
  })

  it('children inherit the caller ceiling and cannot exceed it; a plan ceiling cannot integrate', async () => {
    const { registry, ctx, delegation } = await setup('plan')
    await registry.call('delegate_task', { prompt: 'Look', workspace: 'shared', role: 'research' }, ctx({ toolCallId: 'mcp:a' }))
    expect(delegation.delegateTask).toHaveBeenCalledWith(expect.objectContaining({ modeCeiling: 'plan' }), { toolCallId: 'mcp:a' })
    const broader = await registry.call('delegate_task', { prompt: 'Edit', workspace: 'isolated', modeCeiling: 'default' }, ctx()).catch((error) => error)
    expect(broader.code).toBe('mousse_ceiling_exceeded')
    const integrate = await registry.call('integrate_delegation', { delegationId: 'd1' }, ctx()).catch((error) => error)
    expect(integrate.code).toBe('mousse_ceiling_exceeded')
    expect(delegation.integrateDelegation).not.toHaveBeenCalled()
    const agentTurn = await registry.call('queue_enqueue', { content: 'go', mode: 'agent' }, ctx()).catch((error) => error)
    expect(agentTurn.code).toBe('mousse_ceiling_exceeded')
  })

  it('runs ask_user, present_plan and the task tools through the shared handlers for the caller thread', async () => {
    const { registry, ctx, host, tasks } = await setup()
    const asked = await registry.call('ask_user', { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }, ctx())
    expect(JSON.parse(asked.text)).toEqual({ q1: 'a' })
    expect(host.askUser).toHaveBeenCalledWith('parent', expect.any(Array), expect.objectContaining({ timeoutMs: 60 * 60 * 1000 }))
    await registry.call('present_plan', { title: 'Plan', markdown: '1. do' }, ctx())
    expect(host.presentPlan).toHaveBeenCalledWith('parent', { title: 'Plan', markdown: '1. do' })
    const created = JSON.parse((await registry.call('create_task', { description: 'Write tests' }, ctx())).text)
    expect(tasks.list().map((task) => task.id)).toEqual([created.id])
    const failed = await registry.call('update_task', { id: '' }, ctx())
    expect(failed.isError).toBe(true)
  })
})
