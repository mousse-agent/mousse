import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessLevel, AgentAccessSettings } from '../../src/shared/settings'
import type { ChatMessage, PendingUserQuestions, Thread } from '../../src/shared/types'
import {
  ATTEMPT_TOKEN_KEY,
  McpToolError,
  ToolRegistry,
  TURN_TOKEN_KEY,
  type McpCallRequest,
  type ThreadSearchHit,
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
  integrate_delegation: 'editsWorkspace',
  ask_user: 'actsAsCaller',
  present_plan: 'actsAsCaller',
  create_task: 'actsAsCaller',
  update_task: 'actsAsCaller',
  list_tasks: 'actsAsCaller',
  thread_read: 'readsOthers',
  queue_list: 'reads',
  queue_enqueue: 'writesThreads',
  // Phase 6 (SPEC §16.2).
  thread_fork: 'startsThreads',
  thread_merge_back: 'editsWorkspace'
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

describe('agent access level (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const NOW = '2026-10-12T00:00:00.000Z'
  const thread = (id: string, patch: Partial<Thread> = {}): Thread =>
    ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
  const profile = (patch: Partial<AgentAccessSettings> = {}): AgentAccessSettings => ({ level: 'manage', projectIds: [], answerApprovals: false, ...patch })

  /**
   * `parent` (the caller) and `stranger` hold live runs; `elsewhere` (another project) and `loose` (no project)
   * are known to the host. `state.profile` is the setting as it is now, read at every call.
   */
  const world = async (initial: Partial<AgentAccessSettings> = {}, extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const parentRun = await fx.runningRun('parent')
    const strangerRun = await fx.runningRun('stranger')
    const state = { profile: profile(initial) }
    const threads = new Map<string, Thread>([
      ['parent', thread('parent')],
      ['stranger', thread('stranger', { name: 'Stranger work' })],
      ['elsewhere', thread('elsewhere', { projectId: 'p2', name: 'Elsewhere work' })],
      ['loose', thread('loose', { projectId: undefined, name: 'Loose notes' })]
    ])
    const messages = new Map<string, ChatMessage[]>()
    const activity = new Map<string, { queuedCount: number; pendingQuestions: PendingUserQuestions[] }>()
    const hits: ThreadSearchHit[] = []
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const fake = fakeAppToolHost({
      agentAccess: () => state.profile,
      threadMeta: (id) => threads.get(id),
      listThreads: () => [...threads.values()],
      listProjects: () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
      searchThreads: (query, limit, options) =>
        hits
          .filter((hit) => !options?.allow || options.allow(threads.get(hit.threadId) ?? thread(hit.threadId, { projectId: hit.projectId })))
          .filter((hit) => !options?.titlesOnly || hit.matchType !== 'message')
          .filter((hit) => hit.threadName.toLowerCase().includes(query.toLowerCase()) || hit.snippet?.includes(query))
          .slice(0, limit),
      threadMessages: (id) => messages.get(id) ?? [],
      threadActivity: (id) => activity.get(id) ?? { queuedCount: 0, pendingQuestions: [] },
      toolLedger: () => ledger,
      ...extraHost
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: parentRun.runId }))
    turns.register(appTurn({ threadId: 'stranger', runId: strangerRun.runId }))
    const runs: Record<string, string> = { parent: parentRun.runId, stranger: strangerRun.runId }
    /** A call as `who`, whose credential was granted `granted` (an absent or unknown grant is passed through as is). */
    const as = (who: string, granted: unknown): McpCallRequest => {
      const built = request({ threadId: who, runId: runs[who] })
      return { ...built, credential: { ...built.credential, accessLevel: granted as AgentAccessLevel } }
    }
    const call = (who: string, granted: unknown, name: string, args: Record<string, unknown> = {}) => registry.call(name, args, as(who, granted))
    const read = async (who: string, granted: unknown, args: Record<string, unknown>) => JSON.parse((await call(who, granted, 'thread_read', args)).text)
    const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)
    return { fx, registry, turns, request, as, state, threads, messages, activity, hits, ledger, runs, call, read, denied, parentRun, strangerRun, ...fake }
  }

  const message = (index: number, content: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id: `m${index}`, role, content, timestamp: NOW })

  it('lists thread_list and thread_search only for a caller whose effective level is read or manage', async () => {
    const { registry, state } = await world()
    const names = (granted: AgentAccessLevel) => registry.listForThread('parent', 'default', granted).map((tool) => tool.name)
    expect(names('lineage')).not.toContain('thread_list')
    expect(names('lineage')).not.toContain('thread_search')
    expect(names('lineage')).toContain('thread_read')
    for (const level of ['read', 'manage'] as const) expect(names(level)).toEqual(expect.arrayContaining(['thread_list', 'thread_search', 'thread_read']))
    // The level on the credential is narrowed by the profile as it is now.
    state.profile = profile({ level: 'lineage' })
    expect(names('manage')).not.toContain('thread_list')
    state.profile = profile({ level: 'read' })
    expect(names('manage')).toContain('thread_list')
    // An unknown or absent grant lists nothing extra.
    expect(registry.listForThread('parent', 'default', 'root' as never).map((tool) => tool.name)).not.toContain('thread_list')
    expect(registry.listForThread('parent').map((tool) => tool.name)).not.toContain('thread_list')
  })

  describe('registration guard for tools that take a thread id', () => {
    const tool = (name: string, access: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ name, description: name, inputSchema: { type: 'object', properties }, access, class: 'read', handler: () => ({ text: '' }), ...extra }) as never
    const id = { type: 'string' }

    it.each([
      ['a reads tool with threadId', 'reads', { threadId: id }],
      ['an actsAsCaller tool with threadId', 'actsAsCaller', { threadId: id }],
      ['a startsThreads tool with sourceThreadId', 'startsThreads', { sourceThreadId: id }],
      ['a readsOthers tool with a second thread id', 'readsOthers', { threadId: id, otherThreadId: id }],
      ['a managesOthers tool with threadIds', 'managesOthers', { threadIds: { type: 'array', items: id } }],
      ['a writesThreads tool with forkThreadId', 'writesThreads', { threadId: id, forkThreadId: id }],
      ['a thread id nested in an array of objects', 'reads', { targets: { type: 'array', items: { type: 'object', properties: { parentThreadId: id } } } }]
    ])('refuses %s', (_name, access, properties) => {
      const registry = new ToolRegistry({ activeRunId: () => 'run-1' })
      expect(() => registry.register(tool('t', access, properties))).toThrow(/takes a thread id .* the access check does not cover/)
    })

    it('accepts the tools the check covers, a tool that says where it checks, and a tool with no thread input', () => {
      const registry = new ToolRegistry({ activeRunId: () => 'run-1' })
      registry.register(tool('reads_others', 'readsOthers', { threadId: id }))
      registry.register(tool('manages_others', 'managesOthers', { threadId: id }))
      registry.register(tool('writes_own', 'writesThreads', { threadId: id }))
      registry.register(tool('declared', 'reads', { threadId: id, sourceThreadId: id }, { threadArgChecked: 'the handler accepts the caller\'s own thread only' }))
      registry.register(tool('plain', 'reads', { query: id, projectId: id }))
      expect(() => registry.register(tool('blank', 'reads', { threadId: id }, { threadArgChecked: '  ' }))).toThrow(/does not cover/)
    })

    it('every tool of the Mousse registry passes it, so a new one must declare how it checks a thread', async () => {
      const { registry } = await world()
      for (const registered of registry.list()) {
        const names = JSON.stringify(registered.inputSchema).match(/"\w*[tT]hreadIds?"\s*:/g) ?? []
        if (names.length) expect(['readsOthers', 'managesOthers', 'writesThreads'].includes(registered.access) || Boolean(registered.threadArgChecked), registered.name).toBe(true)
      }
      expect(registry.get('queue_list')!.threadArgChecked).toBeTruthy()
      expect(registry.get('thread_fork')!.threadArgChecked).toBeTruthy()
    })
  })

  it('every access class registers, and the new tools carry the class and level the plan names', async () => {
    const { registry } = await world()
    expect(registry.get('thread_list')).toMatchObject({ access: 'readsOthers', minLevel: 'read', class: 'read' })
    expect(registry.get('thread_search')).toMatchObject({ access: 'readsOthers', minLevel: 'read', class: 'read' })
    expect(registry.get('thread_read')).toMatchObject({ access: 'readsOthers' })
    const bare = new ToolRegistry({ activeRunId: () => 'run-1' })
    const tool = { name: 'x', description: 'x', inputSchema: { type: 'object' }, class: 'read', handler: () => ({ text: '' }) }
    bare.register({ ...tool, access: 'readsOthers' } as never)
    bare.register({ ...tool, name: 'y', access: 'managesOthers', class: 'mutation' } as never)
  })

  it('a lineage caller is refused an unrelated thread, naming the level it needs, with no ledger row and no handler run', async () => {
    const { call, denied, ledger, threads } = await world()
    for (const [name, args] of [
      ['thread_read', { threadId: 'stranger' }],
      ['thread_read', { threadId: 'stranger', view: 'messages' }],
      ['thread_list', {}],
      ['thread_search', { query: 'work' }]
    ] as const) {
      const error = await denied(call('parent', 'lineage', name, { ...args }))
      expect(error, name).toBeInstanceOf(McpToolError)
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/needs the "read" agent access level \(yours is "lineage"\)/)
    }
    expect(ledger.start).not.toHaveBeenCalled()
    // Its own thread is always readable.
    expect((await call('parent', 'lineage', 'thread_read', {})).isError).toBeUndefined()
    expect((await call('parent', 'lineage', 'thread_read', { threadId: 'parent' })).isError).toBeUndefined()
    expect(threads.size).toBe(4)
  })

  it('a thread that does not exist is refused like one the caller may not reach', async () => {
    const { call, denied, state } = await world({ projectIds: ['p1'] })
    const unknown = await denied(call('parent', 'manage', 'thread_read', { threadId: 'no-such-thread' }))
    const outside = await denied(call('parent', 'manage', 'thread_read', { threadId: 'elsewhere' }))
    expect(unknown!.code).toBe('mousse_scope_denied')
    expect(outside!.code).toBe('mousse_scope_denied')
    expect(unknown!.message.replace('no-such-thread', 'X')).toBe(outside!.message.replace('elsewhere', 'X'))
    // A thread that is known but whose project is not listed is the same as an unknown one for a manager too.
    state.profile = profile({ projectIds: [] })
    expect(JSON.parse((await call('parent', 'manage', 'thread_read', { threadId: 'elsewhere' })).text).threadId).toBe('elsewhere')
    expect((await denied(call('parent', 'manage', 'thread_read', { threadId: 'no-such-thread' })))!.code).toBe('mousse_scope_denied')
  })

  it('read sees the run lifecycle and metadata of another thread; manage sees every event and the messages', async () => {
    const { fx, call, read, denied, messages, threads, state, strangerRun } = await world({ level: 'read' })
    const child = await fx.delegate(strangerRun.runId, 'call-1', { prompt: 'a private prompt' })
    threads.set(child.childThreadId, thread(child.childThreadId))
    fx.finish(child.childRunId, 'a private child result')
    messages.set('stranger', [message(0, 'hello'), message(1, 'x'.repeat(5000), 'assistant'), message(2, 'last')])

    const lifecycle = await read('parent', 'read', { threadId: 'stranger' })
    expect(lifecycle).toMatchObject({ threadId: 'stranger', view: 'events', scope: 'read' })
    const types = new Set((lifecycle.events as Array<{ type: string }>).map((event) => event.type))
    expect(types.has('run.status')).toBe(true)
    for (const hidden of ['inbox.status', 'effect.status', 'tool.status']) expect(types.has(hidden), hidden).toBe(false)
    expect(JSON.stringify(lifecycle.events)).not.toContain('a private child result')
    expect(JSON.stringify(lifecycle.events)).not.toContain('a private prompt')
    // A subagent's final text is not part of the read level's view either.
    const subagent = await read('parent', 'read', { threadId: child.childThreadId })
    expect(JSON.stringify(subagent.events)).not.toContain('a private child result')
    // The messages need manage.
    const refused = await denied(call('parent', 'read', 'thread_read', { threadId: 'stranger', view: 'messages' }))
    expect(refused!.code).toBe('mousse_scope_denied')
    expect(refused!.message).toMatch(/needs the "manage" agent access level/)

    // The same manage credential under a read profile still sees only the read view.
    expect((await read('parent', 'manage', { threadId: 'stranger' })).scope).toBe('read')
    state.profile = profile({ level: 'manage' })
    const everything = await read('parent', 'manage', { threadId: 'stranger' })
    expect(everything.scope).toBe('manage')
    expect(everything.events.length).toBeGreaterThan(lifecycle.events.length)
    expect(JSON.stringify(everything.events)).toContain('a private child result')
    expect(JSON.stringify((await read('parent', 'manage', { threadId: child.childThreadId })).events)).toContain('a private child result')
  })

  it('thread_read messages: paged by afterIndex and limit, each text cut at 4 KB, manage only', async () => {
    const { call, read, messages } = await world({ level: 'manage' })
    messages.set('stranger', [message(0, 'one'), message(1, 'y'.repeat(5000), 'assistant'), message(2, 'three'), message(3, 'four')])
    const first = await read('parent', 'manage', { threadId: 'stranger', view: 'messages', limit: 2 })
    expect(first).toMatchObject({ view: 'messages', scope: 'manage', total: 4, nextAfterIndex: 2 })
    expect(first.messages.map((entry: { index: number; text: string }) => [entry.index, entry.text.length])).toEqual([[0, 3], [1, 4096]])
    expect(first.messages[1].truncated).toBe(true)
    expect(first.messages[0].truncated).toBeUndefined()
    const second = await read('parent', 'manage', { threadId: 'stranger', view: 'messages', afterIndex: first.nextAfterIndex, limit: 50 })
    expect(second.messages.map((entry: { id: string }) => entry.id)).toEqual(['m2', 'm3'])
    // The caller's own transcript is its own at any level.
    messages.set('parent', [message(0, 'mine')])
    expect((await read('parent', 'lineage', { view: 'messages' })).messages[0].text).toBe('mine')
    expect((await call('parent', 'manage', 'thread_read', { threadId: 'stranger', view: 'transcript' })).isError).toBe(true)
    expect((await call('parent', 'manage', 'thread_read', { threadId: 'stranger', view: 'messages', limit: 201 })).isError).toBe(true)
  })

  it('the messages of an ancestor are refused at read, and a sibling is refused outright under lineage', async () => {
    const { fx, registry, turns, request, denied, messages, threads, state, parentRun } = await world({ level: 'read' })
    const a = await fx.delegate(parentRun.runId, 'call-a')
    const b = await fx.delegate(parentRun.runId, 'call-b')
    threads.set(a.childThreadId, thread(a.childThreadId))
    threads.set(b.childThreadId, thread(b.childThreadId))
    messages.set('parent', [message(0, 'the parent transcript')])
    messages.set(a.childThreadId, [message(0, 'sibling transcript')])
    fx.engine.markStarting(a.childRunId)
    fx.engine.markRunning(a.childRunId)
    turns.register(appTurn({ threadId: a.childThreadId, runId: a.childRunId }))
    const asChild = (granted: AgentAccessLevel, name: string, args: Record<string, unknown>) =>
      registry.call(name, args, request({ threadId: a.childThreadId, runId: a.childRunId, accessLevel: granted }))
    // The child may read its parent's lifecycle through lineage at any level, never its transcript below manage.
    expect(JSON.parse((await asChild('lineage', 'thread_read', { threadId: 'parent' })).text).scope).toBe('ancestor_or_sibling')
    const refused = await denied(asChild('read', 'thread_read', { threadId: 'parent', view: 'messages' }))
    expect(refused!.code).toBe('mousse_scope_denied')
    expect(await denied(asChild('lineage', 'thread_read', { threadId: 'parent', view: 'messages' }))).toBeInstanceOf(McpToolError)
    // A sibling is not lineage: refused at lineage; at read the lifecycle only; messages need manage.
    expect((await denied(asChild('lineage', 'thread_read', { threadId: b.childThreadId })))!.code).toBe('mousse_scope_denied')
    expect(JSON.parse((await asChild('read', 'thread_read', { threadId: b.childThreadId })).text).scope).toBe('read')
    expect((await denied(asChild('read', 'thread_read', { threadId: b.childThreadId, view: 'messages' })))!.code).toBe('mousse_scope_denied')
    // A manager reads the parent transcript.
    state.profile = profile({ level: 'manage' })
    expect(JSON.parse((await asChild('manage', 'thread_read', { threadId: 'parent', view: 'messages' })).text).messages[0].text).toBe('the parent transcript')
  })

  it('a thread the caller launched is readable at lineage', async () => {
    const { call, threads, read } = await world({ level: 'lineage' })
    threads.set('stranger', thread('stranger', { createdByThreadId: 'parent' }))
    expect((await read('parent', 'lineage', { threadId: 'stranger' })).scope).toBe('launched')
    // The launched relation is the caller's alone.
    threads.set('stranger', thread('stranger', { createdByThreadId: 'someone-else' }))
    await expect(call('parent', 'lineage', 'thread_read', { threadId: 'stranger' })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
  })

  it('the effective level is the narrower of the grant and the profile now; an absent or invalid grant is lineage', async () => {
    const { call, state, denied } = await world({ level: 'manage' })
    const reach = async (granted: unknown) => {
      const error = await denied(call('parent', granted, 'thread_read', { threadId: 'stranger', view: 'messages' }))
      if (!error) return 'manage'
      const events = await denied(call('parent', granted, 'thread_read', { threadId: 'stranger' }))
      return events ? 'lineage' : 'read'
    }
    expect(await reach('manage')).toBe('manage')
    expect(await reach('read')).toBe('read')
    expect(await reach('lineage')).toBe('lineage')
    // Whatever the profile says, a credential without a valid grant gets the most restrictive level.
    for (const bad of [undefined, null, 'root', 'MANAGE', 3, {}]) expect(await reach(bad), String(bad)).toBe('lineage')
    // A grant higher than the profile is held down to it.
    state.profile = profile({ level: 'read' })
    expect(await reach('manage')).toBe('read')
    state.profile = profile({ level: 'lineage' })
    expect(await reach('manage')).toBe('lineage')
    // A profile read that is invalid is lineage too.
    state.profile = { level: 'root' } as never
    expect(await reach('manage')).toBe('lineage')
  })

  it('a host that cannot say what the profile allows grants lineage, whatever the credential holds', async () => {
    const { registry, call, denied } = await world({}, { agentAccess: undefined })
    const error = await denied(call('parent', 'manage', 'thread_read', { threadId: 'stranger' }))
    expect(error!.code).toBe('mousse_scope_denied')
    expect(registry.effectiveLevel('manage')).toBe('lineage')
  })

  it('a settings read that fails is lineage, never the credential\'s level', async () => {
    const { registry, call, denied } = await world({}, { agentAccess: () => { throw new Error('settings unreadable') } })
    expect(registry.effectiveLevel('manage')).toBe('lineage')
    expect((await denied(call('parent', 'manage', 'thread_list')))!.code).toBe('mousse_scope_denied')
  })

  it('revocation: lowering the level, or removing the project, refuses the next call of a running manage turn', async () => {
    const { call, state, denied, registry } = await world({ level: 'manage', projectIds: ['p1'] })
    expect(JSON.parse((await call('parent', 'manage', 'thread_list')).text).threads.map((row: { id: string }) => row.id)).toContain('stranger')
    expect((await call('parent', 'manage', 'thread_read', { threadId: 'stranger' })).isError).toBeUndefined()
    // The project leaves the list: the same credential is refused that project at once.
    state.profile = profile({ level: 'manage', projectIds: ['p2'] })
    expect((await denied(call('parent', 'manage', 'thread_read', { threadId: 'stranger' })))!.code).toBe('mousse_scope_denied')
    expect((await denied(call('parent', 'manage', 'thread_list', { projectId: 'p1' })))!.code).toBe('mousse_scope_denied')
    // The level drops to lineage: thread_list is refused, and no longer listed.
    state.profile = profile({ level: 'lineage' })
    const error = await denied(call('parent', 'manage', 'thread_list'))
    expect(error!.code).toBe('mousse_scope_denied')
    expect(error!.message).toMatch(/yours is "lineage"/)
    expect(registry.listForThread('parent', 'default', 'manage').map((tool) => tool.name)).not.toContain('thread_list')
    // Raising it again applies to the same credential only up to what it was granted.
    state.profile = profile({ level: 'manage' })
    expect((await call('parent', 'manage', 'thread_list')).isError).toBeUndefined()
    expect((await denied(call('parent', 'read', 'thread_read', { threadId: 'stranger', view: 'messages' })))!.code).toBe('mousse_scope_denied')
  })

  it('the project list allows only its projects; a thread without a project is allowed only by an empty list', async () => {
    const { call, state, denied, read } = await world({ level: 'manage', projectIds: ['p1'] })
    expect((await read('parent', 'manage', { threadId: 'stranger' })).threadId).toBe('stranger')
    expect((await denied(call('parent', 'manage', 'thread_read', { threadId: 'elsewhere' })))!.code).toBe('mousse_scope_denied')
    expect((await denied(call('parent', 'manage', 'thread_read', { threadId: 'loose' })))!.code).toBe('mousse_scope_denied')
    state.profile = profile({ level: 'manage', projectIds: [] })
    expect((await read('parent', 'manage', { threadId: 'loose' })).threadId).toBe('loose')
    expect((await read('parent', 'manage', { threadId: 'elsewhere' })).threadId).toBe('elsewhere')
  })

  it('thread_list: allow-listed projects only, started and unsettled by default, filters and limits, questions for managers only', async () => {
    const { call, fx, state, threads, activity, denied, strangerRun } = await world({ level: 'read', projectIds: ['p1'] })
    threads.set('draft', thread('draft', { startedAt: undefined }))
    threads.set('old', thread('old', { settledAt: NOW }))
    threads.set('quiet', thread('quiet', { updatedAt: '2026-10-11T00:00:00.000Z' }))
    const sub = await fx.delegate(strangerRun.runId, 'call-sub')
    threads.set(sub.childThreadId, thread(sub.childThreadId, { lineage: { parentThreadId: 'stranger', rootThreadId: 'stranger', relationship: 'subagent' } }))
    activity.set('stranger', {
      queuedCount: 2,
      pendingQuestions: [{ requestId: 'req-1', threadId: 'stranger', questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] } as never]
    })
    const list = async (granted: AgentAccessLevel, args: Record<string, unknown> = {}) => JSON.parse((await call('parent', granted, 'thread_list', args)).text) as { threads: Array<Record<string, unknown>>; projects: unknown[] }
    const ids = (value: { threads: Array<Record<string, unknown>> }) => value.threads.map((row) => row.id)

    const base = await list('read')
    expect(ids(base)).toEqual(['parent', 'stranger', 'quiet'])
    expect(ids(base)).not.toEqual(expect.arrayContaining(['elsewhere', 'loose', 'draft', 'old', sub.childThreadId]))
    expect(base.projects).toEqual([{ id: 'p1', name: 'One' }])
    const stranger = base.threads.find((row) => row.id === 'stranger')!
    expect(stranger).toMatchObject({ projectId: 'p1', projectName: 'One', queuedCount: 2, pendingQuestionCount: 1, status: 'awaiting_input', activeRunId: strangerRun.runId })
    // The questions themselves, with their request ids, are for a manager.
    expect(stranger.pendingQuestions).toBeUndefined()
    expect(JSON.stringify(base)).not.toContain('req-1')
    state.profile = profile({ level: 'manage', projectIds: ['p1'] })
    const managed = await list('manage')
    expect(managed.threads.find((row) => row.id === 'stranger')!.pendingQuestions).toEqual([expect.objectContaining({ requestId: 'req-1' })])

    expect(ids(await list('manage', { includeUnstarted: true }))).toContain('draft')
    expect(ids(await list('manage', { includeSettled: true }))).toContain('old')
    expect(ids(await list('manage', { includeSubagents: true }))).toContain(sub.childThreadId)
    expect(ids(await list('manage', { status: 'awaiting_input' }))).toEqual(['stranger'])
    expect(ids(await list('manage', { status: 'active' }))).toEqual(['parent'])
    expect(ids(await list('manage', { status: 'idle' }))).toContain('quiet')
    expect(ids(await list('manage', { limit: 1 }))).toHaveLength(1)
    expect((await call('parent', 'manage', 'thread_list', { limit: 0 })).isError).toBe(true)
    expect((await call('parent', 'manage', 'thread_list', { status: 'busy' })).isError).toBe(true)
    // Subagents are listed only for a manager.
    state.profile = profile({ level: 'read', projectIds: ['p1'] })
    expect((await denied(call('parent', 'read', 'thread_list', { includeSubagents: true })))!.code).toBe('mousse_scope_denied')
    // A thread the caller launched is listed whatever the project list says (a draft and a settled one too).
    threads.set('mine', thread('mine', { projectId: 'p2', startedAt: undefined, settledAt: NOW, createdByThreadId: 'parent' }))
    expect(ids(await list('read'))).toContain('mine')
    expect(ids(await list('read', { projectId: 'p1' }))).not.toContain('mine')
  })

  it('thread_search: titles and projects at read, message matches and snippets only for manage, inside the project list', async () => {
    const { call, hits, state } = await world({ level: 'read', projectIds: ['p1'] })
    hits.push(
      { threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'thread' },
      { threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'message', snippet: 'the work: secret plan', messageId: 'm1' },
      { threadId: 'elsewhere', threadName: 'Elsewhere work', projectId: 'p2', projectName: 'Two', matchType: 'thread' }
    )
    const search = async (granted: AgentAccessLevel, args: Record<string, unknown>) => JSON.parse((await call('parent', granted, 'thread_search', args)).text).results as Array<Record<string, unknown>>
    const asRead = await search('read', { query: 'work' })
    expect(asRead).toEqual([{ threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'thread' }])
    expect(JSON.stringify(asRead)).not.toContain('secret plan')
    state.profile = profile({ level: 'manage', projectIds: ['p1'] })
    const asManage = await search('manage', { query: 'work' })
    expect(asManage.map((hit) => hit.matchType)).toEqual(['thread', 'message'])
    expect(asManage[1].snippet).toBe('the work: secret plan')
    expect(JSON.stringify(asManage)).not.toContain('Elsewhere')
    state.profile = profile({ level: 'manage' })
    expect((await search('manage', { query: 'work', limit: 2 }))).toHaveLength(2)
    expect((await call('parent', 'manage', 'thread_search', { query: '  ' })).isError).toBe(true)
    expect((await call('parent', 'manage', 'thread_search', { query: 'x'.repeat(513) })).isError).toBe(true)
    expect((await call('parent', 'manage', 'thread_search', { query: 'work', limit: 201 })).isError).toBe(true)
  })

  it('thread_search hands the caller\'s project list and titles-only to the host, to apply before its limit', async () => {
    const seen: Array<{ limit: number; titlesOnly?: boolean; maxMessageThreads?: number; allow?: (thread: Thread) => boolean }> = []
    const { call, state } = await world({ level: 'read', projectIds: ['p1'] }, { searchThreads: (_query, limit, options) => { seen.push({ limit, ...options }); return [] } })
    await call('parent', 'read', 'thread_search', { query: 'work', limit: 5 })
    expect(seen[0]).toMatchObject({ limit: 5, titlesOnly: true })
    const allow = seen[0].allow!
    expect(allow(thread('in-list', { projectId: 'p1' }))).toBe(true)
    expect(allow(thread('elsewhere', { projectId: 'p2' }))).toBe(false)
    expect(allow(thread('loose', { projectId: undefined }))).toBe(false)
    // A thread the caller launched is searchable whatever the list says.
    expect(allow(thread('mine', { projectId: 'p2', createdByThreadId: 'parent' }))).toBe(true)
    state.profile = profile({ level: 'manage', projectIds: ['p1'] })
    await call('parent', 'manage', 'thread_search', { query: 'work' })
    expect(seen[1]).toMatchObject({ limit: 50, titlesOnly: false, maxMessageThreads: 100 })
  })

  it('what read returns of a thread is a trimmed copy: no error text, request ids, provider sessions, homes or prompts', async () => {
    const { fx, read, state, threads, strangerRun } = await world({ level: 'read' })
    const child = await fx.delegate(strangerRun.runId, 'call-1', { prompt: 'a private prompt', instanceId: 'claude', model: 'secret-model' })
    threads.set(child.childThreadId, thread(child.childThreadId))
    fx.store.appendEvent({
      threadId: 'stranger',
      runId: strangerRun.runId,
      type: 'attempt.created',
      payload: {
        attemptId: 'attempt-1', runId: strangerRun.runId, ordinal: 1, reason: 'initial', status: 'running', startedAt: '2026-10-12T00:00:00.000Z', completedAt: null,
        providerRef: { provider: 'claude', sessionId: 'sess-secret' },
        executionBinding: { homeId: 'C:\\Users\\someone\\.claude', accountGeneration: 'acct-secret' }
      }
    })
    fx.store.appendEvent({ threadId: 'stranger', runId: strangerRun.runId, type: 'restart.note', payload: { note: 'secret restart detail' } })
    fx.store.appendEvent({ threadId: 'stranger', runId: strangerRun.runId, type: 'agent.action', payload: { action: 'sent_message', actorThreadId: 'other', actorRunId: 'r', toolCallId: 'tc-secret', summary: 'a summary' } })
    fx.engine.markTerminal(strangerRun.runId, 'failed', { error: 'boom at C:\\Users\\someone\\project\\secret.ts' })
    const trimmed = await read('parent', 'read', { threadId: 'stranger' })
    const text = JSON.stringify(trimmed.events)
    for (const secret of ['sess-secret', 'someone', 'acct-secret', 'boom at', 'secret restart detail', 'tc-secret', 'a summary', 'a private prompt', 'secret-model', 'claude', 'promptDigest']) expect(text, secret).not.toContain(secret)
    // What it keeps: which run, in what state, when.
    const statuses = (trimmed.events as Array<{ type: string; payload: Record<string, unknown> }>).filter((event) => event.type === 'run.status')
    expect(statuses.at(-1)!.payload).toMatchObject({ runId: strangerRun.runId, ordinal: 1, status: 'failed' })
    expect(statuses.at(-1)!.payload).not.toHaveProperty('clientRequestId')
    expect(trimmed.events.find((event: { type: string; payload: { attemptId?: string } }) => event.type === 'attempt.created' && event.payload.attemptId === 'attempt-1').payload).toEqual({
      attemptId: 'attempt-1', runId: strangerRun.runId, ordinal: 1, reason: 'initial', status: 'running', startedAt: '2026-10-12T00:00:00.000Z', completedAt: null
    })
    expect(trimmed.events.find((event: { type: string }) => event.type === 'agent.action').payload).toEqual({ action: 'sent_message', actorThreadId: 'other', actorRunId: 'r' })
    // A manager still sees the whole record.
    state.profile = profile({ level: 'manage' })
    const full = JSON.stringify((await read('parent', 'manage', { threadId: 'stranger' })).events)
    for (const secret of ['sess-secret', 'boom at', 'secret restart detail']) expect(full, secret).toContain(secret)
  })

  it('a call during a provider-started continuation run is accepted for another thread at the granted level, and refused below it', async () => {
    const state = { profile: profile({ level: 'manage' }) }
    fx = delegationFixture()
    const first = await fx.runningRun('parent')
    await fx.runningRun('stranger')
    fx.engine.markTerminal(first.runId, 'completed')
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const fake = fakeAppToolHost({ agentAccess: () => state.profile, threadMeta: (id) => thread(id), toolLedger: () => ledger })
    let release!: (gate: { runId: string | null }) => void
    const gate = new Promise<{ runId: string | null }>((resolve) => { release = resolve })
    fake.host.awaitLiveRun = () => gate
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    const previous = turns.register(appTurn({ threadId: 'parent', runId: first.runId }))
    const asCredential = (accessLevel: AgentAccessLevel) => {
      const built = request({ threadId: 'parent', runId: first.runId, binding: 'per_call', provider: 'claude' })
      return { ...built, credential: { ...built.credential, accessLevel } }
    }
    const args = { threadId: 'stranger', [TURN_TOKEN_KEY]: previous.turn.turnToken }
    // The credential still names the run that ended; the provider's own turn is about to become active.
    const manager = registry.call('thread_read', { ...args }, asCredential('manage'))
    const reader = registry.call('thread_read', { ...args, view: 'messages' }, asCredential('read'))
    const lineage = registry.call('thread_list', { [TURN_TOKEN_KEY]: previous.turn.turnToken }, asCredential('lineage')).catch((error) => error)
    const continuation = await fx.runningRun('parent')
    turns.register(appTurn({ threadId: 'parent', runId: continuation.runId }), { continuation: true })
    release({ runId: continuation.runId })
    const read = JSON.parse((await manager).text)
    expect(read).toMatchObject({ threadId: 'stranger', scope: 'manage' })
    // The same continuation run: a credential granted read is still refused the transcript, and lineage the listing.
    await expect(reader).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect((await lineage).code).toBe('mousse_scope_denied')
    // The listing refused by the central check never reached the ledger; the two thread_read calls did, under the continuation run.
    expect(ledger.start).toHaveBeenCalledTimes(2)
  })

  it('a definition run is held to the access level before its approval is asked, so a refused call never prompts a person', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    await fx.runningRun('stranger')
    const state = { profile: profile({ level: 'manage' }) }
    const asked: string[] = []
    const policy = {
      profileId: 'default', threadId: 'parent', runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
      workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
      script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
      approval: { askUser: true, policy: 'always', unattendedBehavior: 'pause' },
      memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
      fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
      fallbackModels: []
    }
    const definition = {
      policy,
      grants: { skills: [], mcpTools: [], builtinTools: ['thread_read', 'thread_list'].map((id) => ({ id, source: 'definition' })), denied: [] },
      approve: async (request: { argumentDigest: string }) => (asked.push('asked'), { status: 'approved', digest: request.argumentDigest })
    }
    const fake = fakeAppToolHost({ agentAccess: () => state.profile, threadMeta: (id) => thread(id), listThreads: () => [thread('stranger')], listProjects: () => [] })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: run.runId, definition: definition as never }))
    const as = (accessLevel: AgentAccessLevel) => {
      const built = request({ threadId: 'parent', runId: run.runId })
      return { ...built, credential: { ...built.credential, accessLevel } }
    }
    // A lineage grant: refused by the access check, which comes before the definition's approval.
    for (const [name, args] of [['thread_read', { threadId: 'stranger' }], ['thread_list', {}]] as const)
      await expect(registry.call(name, { ...args }, as('lineage'))).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(asked).toEqual([])
    // A manage grant passes the access check and then meets the definition's own approval, as before.
    expect((await registry.call('thread_read', { threadId: 'stranger' }, as('manage'))).isError).toBeFalsy()
    expect(asked).toEqual(['asked'])
    // Lowering the setting refuses the same grant again without asking.
    state.profile = profile({ level: 'lineage' })
    await expect(registry.call('thread_read', { threadId: 'stranger' }, as('manage'))).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(asked).toEqual(['asked'])
  })

  it('a tool whose host method is absent answers "not available in this host"', async () => {
    const { call } = await world({ level: 'manage' }, { listThreads: undefined, searchThreads: undefined, threadMessages: undefined })
    expect(await call('parent', 'manage', 'thread_list')).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
    expect(await call('parent', 'manage', 'thread_search', { query: 'a' })).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
    expect(await call('parent', 'manage', 'thread_read', { threadId: 'stranger', view: 'messages' })).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
  })

  it('a read-only subagent may call the read-others tools, at its own level', async () => {
    const { registry, request, runs, read } = await world({ level: 'read' }, { readOnlyThread: (id) => id === 'parent' })
    expect((await read('parent', 'read', { threadId: 'stranger' })).scope).toBe('read')
    expect((await registry.call('thread_list', {}, request({ threadId: 'parent', runId: runs.parent, accessLevel: 'read' }))).isError).toBeUndefined()
    expect(registry.listForThread('parent', 'default', 'read').map((tool) => tool.name)).toEqual(expect.arrayContaining(['thread_read', 'thread_list', 'thread_search']))
  })

  it('an in-process call of a tool that reaches other threads is held to the same check', async () => {
    const { registry, turns, parentRun } = await world({ level: 'manage' })
    const turn = turns.get(parentRun.runId)!
    const inProcess = (args: Record<string, unknown>, accessLevel?: AgentAccessLevel) =>
      registry.callInProcess('thread_read', args, { kind: 'run', runId: parentRun.runId }, { turn: { ...turn, ...(accessLevel ? { accessLevel } : {}) }, toolCallId: 'c', signal: new AbortController().signal })
    expect(await inProcess({ threadId: 'stranger' })).toMatchObject({ isError: true, text: expect.stringContaining('needs the "read" agent access level') })
    expect((await inProcess({ threadId: 'stranger' }, 'manage')).isError).toBeUndefined()
    expect((await inProcess({})).isError).toBeUndefined()
  })

  it('the model cannot choose the level of a task it delegates: the host works it out from the caller', async () => {
    const { call, host, delegation } = await world({ level: 'manage' })
    await call('parent', 'lineage', 'delegate_task', { prompt: 'Look', title: 'Looker', workspace: 'shared', role: 'research', accessLevel: 'manage' })
    expect(delegation.delegateTask).toHaveBeenCalledWith(expect.not.objectContaining({ accessLevel: expect.anything() }), expect.anything())
    // The host is built for the caller, whose granted level it narrows by the profile when it starts the child.
    expect(host.delegation).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'parent', accessLevel: 'lineage' }))
    await call('parent', 'manage', 'delegate_task', { prompt: 'Look again', title: 'Looker 2', workspace: 'shared', role: 'research' })
    expect(host.delegation).toHaveBeenLastCalledWith(expect.objectContaining({ accessLevel: 'manage' }))
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
    credential: { threadId: 't', runId, provider: 'p', modeCeiling: 'default', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
    toolCallId: id,
    signal: new AbortController().signal
  })
  return { registry, request }
}

describe('workspace-changing tools and the permission mode', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const setup = async (mode: 'ask' | 'accept_edits' | 'full' | undefined, answer: 'allow' | 'reject' | 'throw' = 'allow') => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const asked: Array<{ threadId: string; approval: unknown }> = []
    const fake = fakeAppToolHost({
      ...(mode ? { permissionModeFor: () => mode } : {}),
      askApproval: async (threadId, _questions, options) => {
        asked.push({ threadId, approval: options.approval })
        if (answer === 'throw') throw new Error('dismissed')
        return { permission: answer }
      }
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: run.runId }))
    const call = (name = 'integrate_delegation', args: Record<string, unknown> = { delegationId: 'd1' }) =>
      registry.call(name, args, request({ threadId: 'parent', runId: run.runId }))
    return { call, asked, registry, run, turns, ...fake }
  }

  it('asks under Ask before the handler runs, and a rejection leaves the workspace untouched', async () => {
    const { call, asked, delegation } = await setup('ask', 'reject')
    await expect(call()).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(delegation.integrateDelegation).not.toHaveBeenCalled()
    expect(asked).toEqual([{ threadId: 'parent', approval: expect.objectContaining({ action: 'edit', permissionKey: 'mousse:integrate' }) }])
  })

  it('runs after the user allows it once, and counts a dismissed question as a rejection', async () => {
    const allowed = await setup('ask', 'allow')
    await allowed.call()
    expect(allowed.delegation.integrateDelegation).toHaveBeenCalledTimes(1)
    const dismissed = await setup('ask', 'throw')
    await expect(dismissed.call()).resolves.toMatchObject({ isError: true })
    expect(dismissed.delegation.integrateDelegation).not.toHaveBeenCalled()
  })

  it.each(['accept_edits', 'full'] as const)('runs without asking under %s', async (mode) => {
    const { call, asked, delegation } = await setup(mode)
    await call()
    expect(delegation.integrateDelegation).toHaveBeenCalledTimes(1)
    expect(asked).toEqual([])
  })

  it('refuses a call that names another thread before it asks the user anything', async () => {
    const { call, asked } = await setup('ask')
    await expect(call('thread_merge_back', { threadId: 'someone-else' })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(asked).toEqual([])
  })

  it('asks a merge-back under Ask and refuses it without a way to ask', async () => {
    const { call, asked } = await setup('ask', 'reject')
    await expect(call('thread_merge_back', {})).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(asked).toEqual([{ threadId: 'parent', approval: expect.objectContaining({ permissionKey: 'mousse:merge_back' }) }])

    fx?.dispose()
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const fake = fakeAppToolHost({ permissionModeFor: () => 'ask' })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: run.runId }))
    await expect(registry.call('integrate_delegation', { delegationId: 'd1' }, request({ threadId: 'parent', runId: run.runId })))
      .resolves.toMatchObject({ isError: true })
    expect(fake.delegation.integrateDelegation).not.toHaveBeenCalled()
  })

  it('asks an in-process run by the turn\'s own mode, and a trusted caller does not ask', async () => {
    const { registry, asked, delegation, run } = await setup(undefined, 'reject')
    const turn = { ...appTurn({ threadId: 'parent', runId: run.runId }), turnToken: 't', permissionMode: 'ask' as const, delegation }
    const call = { turn, toolCallId: 'c1', signal: new AbortController().signal }
    await expect(registry.callInProcess('integrate_delegation', { delegationId: 'd1' }, { kind: 'run', runId: run.runId, active: () => true }, call))
      .resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(asked).toHaveLength(1)
    expect(delegation.integrateDelegation).not.toHaveBeenCalled()

    await registry.callInProcess('integrate_delegation', { delegationId: 'd1' }, { kind: 'trusted' }, { ...call, turn: { ...turn, trusted: true } })
    expect(asked).toHaveLength(1)
  })
})
