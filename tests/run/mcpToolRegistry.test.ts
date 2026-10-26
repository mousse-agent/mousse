import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ATTEMPT_TOKEN_KEY,
  McpToolError,
  ToolRegistry,
  TURN_TOKEN_KEY,
  type McpCallRequest,
  type ToolOutcome
} from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

/** The tools a credential lists before the app tools joined (still listed, still these classes). */
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

describe('Mousse tool registry (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const setup = async (modeCeiling: 'plan' | 'default' = 'default', hostOverrides: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const fake = fakeAppToolHost(hostOverrides)
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    const registered = turns.register(appTurn({ threadId: 'parent', runId: run.runId, modeCeiling }))
    const ctx = (overrides: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'parent', runId: run.runId, modeCeiling, ...overrides })
    return { fx, run, registry, turns, registered, ctx, request, ...fake }
  }

  it('refuses a tool registered without an access class or a class', () => {
    const registry = new ToolRegistry({ activeRunId: () => 'run-1' })
    const tool = { name: 'x', description: 'x', inputSchema: { type: 'object' }, class: 'read', handler: () => ({ text: '' }) }
    expect(() => registry.register(tool as never)).toThrow(/no access class/)
    expect(() => registry.register({ ...tool, access: 'admin' } as never)).toThrow(/no access class/)
    expect(() => registry.register({ ...tool, access: 'reads', class: 'other' } as never)).toThrow(/no class/)
    registry.register({ ...tool, access: 'reads', class: 'read' })
    expect(() => registry.register({ ...tool, access: 'reads', class: 'read' })).toThrow(/already registered/)
  })

  it('lists every Phase 5 tool with its access class and a plain JSON schema', async () => {
    const { registry } = await setup()
    const listed = registry.listFor({ readOnly: false, modeCeiling: 'default' })
    const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool.access]))
    for (const [name, access] of Object.entries(PHASE5_TOOLS)) expect(byName[name], name).toBe(access)
    for (const tool of listed) {
      expect(tool.inputSchema.type).toBe('object')
      expect(Object.getOwnPropertySymbols(tool.inputSchema)).toEqual([])
    }
    expect((registry.get('delegate_task')!.inputSchema.properties as Record<string, unknown>).modeCeiling).toBeTruthy()
    // The older delegation names stay dispatchable in process but are never listed.
    for (const hidden of ['create_subagent', 'create_subagents', 'recall_subagent', 'integrate_subagent', 'list_delegations', 'show_document'])
      expect(listed.some((tool) => tool.name === hidden), hidden).toBe(false)
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
    const { fx, registry, run, turns, request } = await setup()
    const mine = await fx.delegate(run.runId, 'call-mine', { prompt: 'parent prompt for me' })
    const sibling = await fx.delegate(run.runId, 'call-sibling', { prompt: 'parent prompt for the sibling' })
    fx.finish(sibling.childRunId, 'sibling secret result')
    fx.engine.markStarting(mine.childRunId)
    fx.engine.markRunning(mine.childRunId)
    turns.register(appTurn({ threadId: mine.childThreadId, runId: mine.childRunId }))
    const read = JSON.parse((await registry.call('thread_read', { threadId: 'parent' }, request({ threadId: mine.childThreadId, runId: mine.childRunId }))).text) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>; nextAfterSeq: number; maxSeq: number
    }
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
    turns.register(appTurn({ threadId: mine.childThreadId, runId: next.runId }))
    const own = await registry.call('thread_read', { threadId: 'parent' }, request({ threadId: mine.childThreadId, runId: next.runId }))
    expect(own.text).toContain('my own result')
    expect(own.text).not.toContain('sibling secret result')
  })

  describe('caller authority (PR 2 §2)', () => {
    it('a credential acts only for its own run: never re-pointed to another one, and closed once its run ends', async () => {
      const { fx, registry, run, ctx, host, delegation } = await setup()
      // The credential names an older run: refused, the handler is never reached.
      const stale = await registry.call('list_subagents', {}, ctx({ runId: 'run:stale' })).catch((error) => error)
      expect(stale).toBeInstanceOf(McpToolError)
      expect(stale.code).toBe('mousse_caller_not_live')
      expect(host.delegation).not.toHaveBeenCalled()
      await registry.call('list_subagents', {}, ctx())
      expect(host.delegation).toHaveBeenLastCalledWith(expect.objectContaining({ runId: run.runId }))
      expect(delegation.listSubagents).toHaveBeenCalledTimes(1)
      fx.engine.markTerminal(run.runId, 'completed')
      const ended = await registry.call('list_tasks', {}, ctx()).catch((err) => err)
      expect(ended.code).toBe('mousse_caller_not_live')
    })

    it('a credential of an older epoch, or of a run with no registered turn, reaches no handler', async () => {
      const { registry, ctx, registered, enqueued } = await setup()
      const old = await registry.call('queue_enqueue', { content: 'x' }, ctx({ current: () => false })).catch((error) => error)
      expect(old.code).toBe('mousse_caller_not_live')
      registered.drop()
      const dropped = await registry.call('queue_enqueue', { content: 'x' }, ctx()).catch((error) => error)
      expect(dropped.code).toBe('mousse_caller_not_live')
      expect(enqueued).toEqual([])
    })

    it('a call that waited for a turn the runtime started acts as that run once it is active', async () => {
      fx = delegationFixture()
      const first = await fx.runningRun('parent')
      fx.engine.markTerminal(first.runId, 'completed')
      const fake = fakeAppToolHost()
      let release!: (gate: { runId: string | null }) => void
      const gate = new Promise<{ runId: string | null }>((resolve) => { release = resolve })
      fake.host.awaitLiveRun = () => gate
      const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
      const previous = turns.register(appTurn({ threadId: 'parent', runId: first.runId }))
      const call = registry.call('ask_user', { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], [TURN_TOKEN_KEY]: previous.turn.turnToken },
        request({ threadId: 'parent', runId: first.runId, binding: 'per_call', provider: 'claude' }))
      const continuation = await fx.runningRun('parent')
      // The continuation keeps the token of the turn it continues.
      const next = turns.register(appTurn({ threadId: 'parent', runId: continuation.runId }), { continuation: true })
      expect(next.turn.turnToken).toBe(previous.turn.turnToken)
      release({ runId: continuation.runId })
      expect(JSON.parse((await call).text)).toEqual({ q1: 'a' })
    })

    it('per_call: a Claude call must carry the active turn token, which is stripped before the handler', async () => {
      const { registry, ctx, registered, host } = await setup()
      const claude = (args: Record<string, unknown>) => registry.call('present_plan', args, ctx({ binding: 'per_call', provider: 'claude' }))
      await expect(claude({ title: 'P', markdown: '1.' })).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      await expect(claude({ title: 'P', markdown: '1.', [TURN_TOKEN_KEY]: 'an-earlier-turn' })).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(host.presentPlan).not.toHaveBeenCalled()
      await claude({ title: 'P', markdown: '1.', [TURN_TOKEN_KEY]: registered.turn.turnToken })
      expect(host.presentPlan).toHaveBeenCalledWith('parent', { title: 'P', markdown: '1.' })
    })

    it('per_call: a runtime that tags calls by attempt must carry the active attempt token', async () => {
      const { registry, ctx, turns, run, host } = await setup()
      turns.register(appTurn({ threadId: 'parent', runId: run.runId, attemptToken: 'attempt-2' }))
      const pi = (token: string) => registry.call('present_plan', { title: 'P', markdown: '1.', [ATTEMPT_TOKEN_KEY]: token }, ctx({ binding: 'per_call', provider: 'pi:openai' }))
      await expect(pi('attempt-1')).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(host.presentPlan).not.toHaveBeenCalled()
      await pi('attempt-2')
      expect(host.presentPlan).toHaveBeenCalledTimes(1)
    })
  })

  describe('same-epoch delayed calls: a held turn-N call released during turn N+1', () => {
    /** A browser tool whose port records every dispatch: the N+1 browser must stay untouched. */
    const browserSetup = async (binding: 'per_call' | 'drained_turn') => {
      const dispatched: string[] = []
      const port = {
        dispatch: vi.fn(async (_context: unknown, name: string) => { dispatched.push(name); return { text: 'ok' } }),
        resolveTarget: () => ({ backend: 'managed-chromium' as const }),
        requestAccess: async () => 'allowed' as const
      }
      const s = await setup('default', { browserRuntime: () => port as never })
      const browser = { mode: 'structured', execution: { source: 'gui', threadId: 'parent' }, policy: { allowedTools: ['browser_open'] } } as never
      s.turns.register(appTurn({ threadId: 'parent', runId: s.run.runId, browser }))
      return { ...s, dispatched, binding }
    }

    it('Claude (turn token): refused, no handler reached, the browser untouched', async () => {
      const s = await browserSetup('per_call')
      const turnN = s.turns.get(s.run.runId)!.turnToken
      s.fx.engine.markTerminal(s.run.runId, 'completed')
      const next = await s.fx.runningRun('parent')
      s.turns.register(appTurn({ threadId: 'parent', runId: next.runId, browser: s.turns.get(s.run.runId)!.browser }))
      // The bearer was kept and re-bound to N+1 (per_call keeps warm reuse); the stamp is N's.
      const held = await s.registry.call('browser_open', { url: 'https://example.com', [TURN_TOKEN_KEY]: turnN },
        s.request({ threadId: 'parent', runId: next.runId, binding: 'per_call', provider: 'claude' })).catch((error) => error)
      expect(held.code).toBe('mousse_caller_not_live')
      expect(s.dispatched).toEqual([])
    })

    it('Pi (attempt token): refused, no handler reached, the browser untouched', async () => {
      const s = await browserSetup('per_call')
      s.turns.register(appTurn({ threadId: 'parent', runId: s.run.runId, attemptToken: 'a-1', browser: s.turns.get(s.run.runId)!.browser }))
      s.fx.engine.markTerminal(s.run.runId, 'completed')
      const next = await s.fx.runningRun('parent')
      s.turns.register(appTurn({ threadId: 'parent', runId: next.runId, attemptToken: 'a-2', browser: s.turns.get(s.run.runId)!.browser }))
      const held = await s.registry.call('browser_open', { [ATTEMPT_TOKEN_KEY]: 'a-1' },
        s.request({ threadId: 'parent', runId: next.runId, binding: 'per_call', provider: 'pi:openai' })).catch((error) => error)
      expect(held.code).toBe('mousse_caller_not_live')
      expect(s.dispatched).toEqual([])
    })

    it('Codex/ACP (bearer) after a Stop: the bearer was rotated, so the call is refused before any handler', async () => {
      const s = await browserSetup('drained_turn')
      s.fx.engine.markTerminal(s.run.runId, 'interrupted')
      const next = await s.fx.runningRun('parent')
      s.turns.register(appTurn({ threadId: 'parent', runId: next.runId, browser: s.turns.get(s.run.runId)!.browser }))
      // Stop rotated the epoch: turn N's bearer is no longer current, and it was bound to run N.
      const held = await s.registry.call('browser_open', {}, s.request({ threadId: 'parent', runId: s.run.runId, current: () => false })).catch((error) => error)
      expect(held.code).toBe('mousse_caller_not_live')
      expect(s.dispatched).toEqual([])
    })
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

  it('a read-only child calls only reads and readOnlySafe tools', async () => {
    const { registry, ctx, enqueued } = await setup('default', { readOnlyThread: () => true })
    const refused = await registry.call('queue_enqueue', { content: 'x' }, ctx()).catch((error) => error)
    expect(refused.code).toBe('mousse_read_only')
    expect(enqueued).toEqual([])
    await expect(registry.call('create_quick_action', { label: 'x', kind: 'bash', payload: 'ls' }, ctx())).rejects.toMatchObject({ code: 'mousse_read_only' })
    expect((await registry.call('queue_list', {}, ctx())).isError).toBeUndefined()
    const listed = registry.listForThread('parent', 'default').map((tool) => tool.name)
    expect(listed).toContain('ask_user')
    expect(listed).not.toContain('queue_enqueue')
    expect(listed).not.toContain('integrate_delegation')
  })

  it('a tool Settings turned off is refused at call time with the reason, and writes no ledger row', async () => {
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const { registry, ctx, turns, run, host } = await setup('default', { toolLedger: () => ledger })
    turns.register(appTurn({ threadId: 'parent', runId: run.runId, settingsEnabled: (name) => name !== 'present_plan' }))
    const outcome = await registry.call('present_plan', { title: 'P', markdown: '1.' }, ctx())
    expect(outcome).toEqual({ text: 'Tool "present_plan" is disabled in Settings → Skills & MCP.', isError: true })
    expect(host.presentPlan).not.toHaveBeenCalled()
    expect(ledger.start).not.toHaveBeenCalled()
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
    const plainRegistry = (forRun: ReturnType<typeof ledgerFor>['forRun'], active: () => string | null) => {
      const fixture = appToolRegistryWithoutEngine(forRun, active)
      return fixture
    }
    const call = (registry: ToolRegistry, request: (runId: string, id?: string) => McpCallRequest, name: string, args: Record<string, unknown> = {}, id = 'call-1', runId = 'run:active'): Promise<ToolOutcome> =>
      registry.call(name, args, request(runId, id))

    it('writes start then commit for a result, failed for an error result and for a throw, under the credential run', async () => {
      const { rows, forRun } = ledgerFor()
      const { registry, request } = plainRegistry(forRun, () => 'run:active')
      registry.register({ name: 'ok', description: '', inputSchema: { type: 'object' }, access: 'reads', class: 'read', handler: () => ({ text: 'fine' }) })
      registry.register({ name: 'soft', description: '', inputSchema: { type: 'object' }, access: 'reads', class: 'read', handler: () => ({ text: 'no', isError: true }) })
      registry.register({ name: 'throws', description: '', inputSchema: { type: 'object' }, access: 'reads', class: 'read', handler: () => { throw new Error('boom') } })
      registry.register({ name: 'refuses', description: '', inputSchema: { type: 'object' }, access: 'reads', class: 'read', handler: () => { throw new McpToolError('mousse_scope_denied', 'no') } })
      await call(registry, request, 'ok', { a: 1 }, 'c1')
      await call(registry, request, 'soft', {}, 'c2')
      expect(await call(registry, request, 'throws', {}, 'c3')).toEqual({ text: 'boom', isError: true })
      await expect(call(registry, request, 'refuses', {}, 'c4')).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      expect(rows).toEqual([
        'start:ok:c1', 'commit:inv:c1',
        'start:soft:c2', 'failed:inv:c2',
        'start:throws:c3', 'failed:inv:c3',
        'start:refuses:c4', 'failed:inv:c4'
      ])
      expect(forRun).toHaveBeenCalledWith('run:active')
    })

    it('records the call arguments, and writes no row for a call refused before it starts', async () => {
      const { rows, ledger, forRun } = ledgerFor()
      let active: string | null = 'run:active'
      const { registry, request } = plainRegistry(forRun, () => active)
      registry.register({ name: 'write', description: '', inputSchema: { type: 'object' }, access: 'writesThreads', class: 'mutation', handler: () => ({ text: 'ok' }) })
      registry.register({ name: 'spawn', description: '', inputSchema: { type: 'object' }, access: 'startsThreads', class: 'mutation', handler: () => ({ text: 'ok' }) })
      await call(registry, request, 'write', { text: 'x' })
      expect(ledger.start).toHaveBeenCalledWith({ type: 'toolCall', id: 'call-1', name: 'write', arguments: { text: 'x' } })
      rows.length = 0
      await expect(call(registry, request, 'missing')).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
      await expect(call(registry, request, 'write', { threadId: 'other' })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
      const plan = request('run:active')
      await expect(registry.call('spawn', {}, { ...plan, credential: { ...plan.credential, modeCeiling: 'plan' } })).rejects.toMatchObject({ code: 'mousse_ceiling_exceeded' })
      await expect(call(registry, request, 'write', {}, 'call-1', 'run:stale')).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      active = null
      await expect(call(registry, request, 'write')).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(rows).toEqual([])
    })
  })

  describe('thread_fork and thread_merge_back (SPEC §16.2)', () => {
    /** A finished child run on `child-1`, so `parent` has a lineage thread to fork. */
    const withFinishedChild = async (modeCeiling: 'plan' | 'default' = 'default') => {
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

/** A bare registry (no run engine) whose single thread `t` runs `active()`, with a turn for each run asked about. */
function appToolRegistryWithoutEngine(forRun: (runId: string) => { start: (call: never) => string | undefined; commit: (id: string) => void; failed: (id: string) => void }, active: () => string | null) {
  const turns = new Map<string, ReturnType<typeof appTurn>>()
  const registry = new ToolRegistry({
    activeRunId: () => active(),
    toolLedger: forRun as never,
    turns: { get: (runId: string) => turns.get(runId) ?? { ...appTurn({ threadId: 't', runId }), turnToken: 'tok' } } as never
  })
  const request = (runId: string, id = 'call-1'): McpCallRequest => ({
    credential: { threadId: 't', runId, provider: 'p', modeCeiling: 'default', binding: 'drained_turn', current: () => true },
    toolCallId: id,
    signal: new AbortController().signal
  })
  return { registry, request }
}
