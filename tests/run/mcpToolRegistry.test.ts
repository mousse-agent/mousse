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
  continue_subagent: 'actsAsCaller',
  answer_subagent: 'actsAsCaller',
  task_status: 'actsAsCaller',
  task_cancel: 'actsAsCaller',
  list_subagents: 'actsAsCaller',
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
    continueSubagent: vi.fn(async (input) => ({ delegationId: 'd2', input })),
    answerSubagent: vi.fn((input) => ({ answered: true, input })),
    taskStatus: vi.fn(() => ({ status: 'running' })),
    taskCancel: vi.fn(async () => ({ cancelled: [] })),
    listDelegations: vi.fn(() => []),
    listSubagents: vi.fn(() => []),
    integrateDelegation: vi.fn(async () => ({ status: 'queued' })),
    named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn(), integrate: vi.fn() }
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

  it('thread_read of a lineage thread shows run lifecycle only, and a delegation result only to its own child (M7)', async () => {
    const { fx, registry, run, caller } = await setup()
    const mine = await fx.delegate(run.runId, 'call-mine', { prompt: 'parent prompt for me' })
    const sibling = await fx.delegate(run.runId, 'call-sibling', { prompt: 'parent prompt for the sibling' })
    fx.finish(sibling.childRunId, 'sibling secret result')
    fx.engine.markStarting(mine.childRunId)
    fx.engine.markRunning(mine.childRunId)
    const childCaller: McpCaller = { ...caller, threadId: mine.childThreadId, runId: mine.childRunId }
    const read = JSON.parse((await registry.call('thread_read', { threadId: 'parent' }, {
      caller: childCaller, toolCallId: 'mcp:read', signal: new AbortController().signal
    })).text) as { events: Array<{ type: string; payload: Record<string, unknown> }>; nextAfterSeq: number; maxSeq: number }
    const types = new Set(read.events.map((event) => event.type))
    expect(types.has('run.status')).toBe(true)
    for (const hidden of ['inbox.status', 'effect.status', 'tool.status', 'transfer.status'])
      expect(types.has(hidden)).toBe(false)
    const text = JSON.stringify(read.events)
    expect(text).not.toContain('sibling secret result')
    expect(text).not.toContain('parent prompt for')
    const delegationEvents = read.events.filter((event) => event.type === 'delegation.status')
    expect(delegationEvents.filter((event) => event.payload.childThreadId === sibling.childThreadId).every((event) => event.payload.result === null)).toBe(true)
    expect(read.nextAfterSeq).toBeGreaterThan(0)
    // The caller's own child result is visible to it once it is published.
    fx.finish(mine.childRunId, 'my own result')
    const next = await fx.runningRun(mine.childThreadId)
    const own = await registry.call('thread_read', { threadId: 'parent' }, {
      caller: { ...childCaller, runId: next.runId }, toolCallId: 'mcp:read-2', signal: new AbortController().signal
    })
    expect(own.text).toContain('my own result')
    expect(own.text).not.toContain('sibling secret result')
  })

  it('assertLiveCaller: the call acts as the thread\'s active run; none gives mousse_caller_not_live', async () => {
    const { fx, registry, run, ctx, host, delegation } = await setup()
    // The credential still names an older run; the call acts as the active one.
    await registry.call('list_subagents', {}, ctx({ caller: { threadId: 'parent', runId: 'run:stale', provider: 'p', modeCeiling: 'default' } }))
    expect(host.delegation).toHaveBeenLastCalledWith(expect.objectContaining({ runId: run.runId }))
    expect(delegation.listSubagents).toHaveBeenCalled()
    fx.engine.markTerminal(run.runId, 'completed')
    const error = await registry.call('list_tasks', {}, ctx()).catch((err) => err)
    expect(error).toBeInstanceOf(McpToolError)
    expect(error.code).toBe('mousse_caller_not_live')
  })

  it('children inherit the caller ceiling and cannot exceed it; a plan ceiling cannot integrate', async () => {
    const { registry, ctx, delegation } = await setup('plan')
    await registry.call('delegate_task', { prompt: 'Look', title: 'Looker', workspace: 'shared', role: 'research' }, ctx({ toolCallId: 'mcp:a' }))
    expect(delegation.delegateTask).toHaveBeenCalledWith(expect.objectContaining({ modeCeiling: 'plan' }), { toolCallId: 'mcp:a' })
    const broader = await registry.call('delegate_task', { prompt: 'Edit', title: 'Editor', workspace: 'isolated', modeCeiling: 'default' }, ctx()).catch((error) => error)
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

  describe('tool ledger (SPEC §12.6)', () => {
    const ledgerFor = () => {
      const rows: string[] = []
      const ledger = {
        start: vi.fn((call: { id: string; name: string }) => { rows.push(`start:${call.name}:${call.id}`); return `inv:${call.id}` }),
        commit: vi.fn((id: string) => { rows.push(`commit:${id}`) }),
        failed: vi.fn((id: string) => { rows.push(`failed:${id}`) })
      }
      const forRun = vi.fn((_runId: string) => ledger)
      return { rows, ledger, forRun }
    }
    const caller: McpCaller = { threadId: 't', runId: 'run:stale', provider: 'p', modeCeiling: 'default' }
    const call = (registry: ToolRegistry, name: string, args: Record<string, unknown> = {}, id = 'call-1') =>
      registry.call(name, args, { caller, toolCallId: id, signal: new AbortController().signal })

    it('writes start then commit for a result, failed for an error result and for a throw, under the active run', async () => {
      const { rows, forRun } = ledgerFor()
      const registry = new ToolRegistry({ activeRunId: () => 'run:active', toolLedger: forRun })
      registry.register({ name: 'ok', description: '', inputSchema: { type: 'object' }, access: 'reads', handler: () => ({ text: 'fine' }) })
      registry.register({ name: 'soft', description: '', inputSchema: { type: 'object' }, access: 'reads', handler: () => ({ text: 'no', isError: true }) })
      registry.register({ name: 'throws', description: '', inputSchema: { type: 'object' }, access: 'reads', handler: () => { throw new Error('boom') } })
      registry.register({ name: 'refuses', description: '', inputSchema: { type: 'object' }, access: 'reads', handler: () => { throw new McpToolError('mousse_scope_denied', 'no') } })
      await call(registry, 'ok', { a: 1 }, 'c1')
      await call(registry, 'soft', {}, 'c2')
      expect(await call(registry, 'throws', {}, 'c3')).toEqual({ text: 'boom', isError: true })
      await expect(call(registry, 'refuses', {}, 'c4')).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      expect(rows).toEqual([
        'start:ok:c1', 'commit:inv:c1',
        'start:soft:c2', 'failed:inv:c2',
        'start:throws:c3', 'failed:inv:c3',
        'start:refuses:c4', 'failed:inv:c4'
      ])
      expect(forRun).toHaveBeenCalledWith('run:active')
      expect(forRun).not.toHaveBeenCalledWith('run:stale')
    })

    it('records the call arguments, and writes no row for a call refused before it starts', async () => {
      const { rows, ledger, forRun } = ledgerFor()
      let active: string | null = 'run:active'
      const registry = new ToolRegistry({ activeRunId: () => active, toolLedger: forRun })
      registry.register({ name: 'write', description: '', inputSchema: { type: 'object' }, access: 'writesThreads', handler: () => ({ text: 'ok' }) })
      registry.register({ name: 'spawn', description: '', inputSchema: { type: 'object' }, access: 'startsThreads', handler: () => ({ text: 'ok' }) })
      await call(registry, 'write', { text: 'x' })
      expect(ledger.start).toHaveBeenCalledWith({ type: 'toolCall', id: 'call-1', name: 'write', arguments: { text: 'x' } })
      rows.length = 0
      await expect(call(registry, 'missing')).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
      await expect(call(registry, 'write', { threadId: 'other' })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      await expect(registry.call('spawn', {}, { caller: { ...caller, modeCeiling: 'plan' }, toolCallId: 'c', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'mousse_ceiling_exceeded' })
      active = null
      await expect(call(registry, 'write')).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(rows).toEqual([])
    })
  })

  describe('thread_fork and thread_merge_back (SPEC §16.2)', () => {
    /** A finished child run on `child-1`, so `parent` has a lineage thread to fork. */
    const withFinishedChild = async (modeCeiling: McpCaller['modeCeiling'] = 'default') => {
      const s = await setup(modeCeiling)
      const child = await s.fx.delegate(s.run.runId, 'call-child')
      s.fx.finish(child.childRunId, 'child answer')
      return { ...s, child }
    }

    it('thread_fork refuses a plan ceiling and a thread outside the caller lineage, creating nothing', async () => {
      const plan = await withFinishedChild('plan')
      await expect(plan.registry.call('thread_fork', { sourceThreadId: 'child-1' }, plan.ctx())).rejects.toMatchObject({ code: 'mousse_ceiling_exceeded' })
      expect([...plan.fx.threads]).toEqual(['child-1'])
      fx?.dispose()
      const open = await withFinishedChild()
      await open.fx.runningRun('stranger')
      await expect(open.registry.call('thread_fork', { sourceThreadId: 'stranger' }, open.ctx())).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      expect([...open.fx.threads]).toEqual(['child-1'])
    })

    it('thread_fork forks a lineage thread, and a retry with the same clientRequestId returns the same fork', async () => {
      const { fx, registry, ctx, run } = await withFinishedChild()
      const first = JSON.parse((await registry.call('thread_fork', { sourceThreadId: 'child-1', clientRequestId: 'try-b' }, ctx({ toolCallId: 'mcp:1' }))).text) as { threadId: string; transferId: string }
      const retry = JSON.parse((await registry.call('thread_fork', { sourceThreadId: 'child-1', clientRequestId: 'try-b' }, ctx({ toolCallId: 'mcp:2' }))).text)
      expect(retry).toEqual(first)
      expect(fx.store.getReceipt(`thread_fork:${run.runId}:try-b`)).toMatchObject({ commandKind: 'thread.fork', status: 'accepted' })
      expect(fx.engine.delegations.getLineage(first.threadId)).toMatchObject({ parentThreadId: 'child-1', relationship: 'fork' })
      // Without a clientRequestId each call is its own action.
      const second = JSON.parse((await registry.call('thread_fork', { sourceThreadId: 'child-1' }, ctx({ toolCallId: 'mcp:3' }))).text)
      const third = JSON.parse((await registry.call('thread_fork', { sourceThreadId: 'child-1' }, ctx({ toolCallId: 'mcp:4' }))).text)
      expect(new Set([first.threadId, second.threadId, third.threadId]).size).toBe(3)
      expect(fx.store.getReceipt(`thread_fork:${run.runId}:mcp:3`)).not.toBeNull()
    })

    it.each([
      [{ atRunOrdinal: 0 }, /atRunOrdinal/],
      [{ title: 5 }, /title must be a string/],
      [{ seedFrom: 'tomorrow' }, /seedFrom must be/],
      [{ clientRequestId: '' }, /clientRequestId must be a non-empty string/]
    ])('thread_fork reports invalid input %j as a tool error', async (args, message) => {
      const { registry, ctx, fx } = await withFinishedChild()
      const outcome = await registry.call('thread_fork', { sourceThreadId: 'child-1', ...args }, ctx())
      expect(outcome).toMatchObject({ isError: true, text: expect.stringMatching(message) })
      expect([...fx.threads]).toEqual(['child-1'])
    })

    it('thread_merge_back acts for the caller\'s own fork only, and derives its clientRequestId from the run and call', async () => {
      const { fx, registry, ctx, run } = await setup()
      const mergeBack = vi.spyOn(fx.engine, 'mergeBack')
      await expect(registry.call('thread_merge_back', { forkThreadId: 'someone-else' }, ctx())).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      await expect(registry.call('thread_merge_back', { threadId: 'someone-else' }, ctx())).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      expect(mergeBack).not.toHaveBeenCalled()
      // `parent` is not a fork, so the engine refuses; the request id shows what the tool sent.
      const derived = await registry.call('thread_merge_back', {}, ctx({ toolCallId: 'mcp:merge' }))
      expect(derived.isError).toBe(true)
      expect(mergeBack).toHaveBeenLastCalledWith({ forkThreadId: 'parent', clientRequestId: `thread_merge_back:${run.runId}:mcp:merge` })
      await registry.call('thread_merge_back', { forkThreadId: 'parent', clientRequestId: 'retry-1' }, ctx({ toolCallId: 'mcp:other' }))
      expect(mergeBack).toHaveBeenLastCalledWith({ forkThreadId: 'parent', clientRequestId: `thread_merge_back:${run.runId}:retry-1` })
    })
  })
})
