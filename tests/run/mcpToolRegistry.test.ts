import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, PendingUserQuestions, Thread } from '../../src/shared/types'
import {
  ATTEMPT_TOKEN_KEY,
  checkedInHandler,
  McpToolError,
  refused,
  ToolRegistry,
  TURN_TOKEN_KEY,
  type McpCallRequest,
  type ThreadSearchHit,
  type ToolOutcome
} from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, denied as refusalIn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { THREAD_MESSAGE_MAX_CHARS, THREAD_READ_MAX_BYTES, THREAD_RESULT_MAX_CHARS } from '../../src/mms/run/mcp/appTools/thread'
import { AGENT_MESSAGE_END, AGENT_MESSAGE_PREFIX, agentMessage } from '../../src/mms/run/mcp/appTools/agentMessage'

/** The tools a credential lists before the app tools joined (still listed, still these classes). */
const PHASE5_TOOLS: Record<string, string> = {
  continue_subagent: 'actsAsCaller',
  answer_subagent: 'actsAsCaller',
  task_status: 'actsAsCaller',
  task_cancel: 'actsAsCaller',
  list_subagents: 'actsAsCaller',
  question_ask: 'actsAsCaller',
  task_create: 'actsAsCaller',
  task_update: 'actsAsCaller',
  task_list: 'actsAsCaller',
  thread_read: 'readsOthers',
  thread_wait: 'readsOthers',
  thread_send: 'managesOthers',
  // Listed as its widest kind, the subagent (`delegate_task`'s): a call of kind thread is held to `managesOthers`.
  thread_create: 'actsAsCaller',
  thread_stop: 'managesOthers',
  approval_respond: 'managesOthers',
  queue_list: 'readsOthers',
  queue_enqueue: 'managesOthers',
  queue_update: 'managesOthers',
  // Phase 6 (SPEC §16.2).
  thread_fork: 'startsThreads',
  thread_return: 'editsWorkspace'
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
    for (const hidden of ['create_subagent', 'create_subagents', 'recall_subagent', 'integrate_delegation', 'integrate_subagent', 'list_delegations'])
      expect(listed.some((tool) => tool.name === hidden), hidden).toBe(false)
  })

  it('refuses a queue tool on a thread the host does not know with mousse_scope_denied, and queues on its own', async () => {
    const { registry, ctx, enqueued } = await setup()
    const denied = await refusalIn(registry.call('queue_enqueue', { content: 'hi', threadId: 'other', expectedRevision: 'rev-0' }, ctx()))
    expect(denied?.refused.code).toBe('scope_denied')
    expect(denied?.code).toBe('mousse_scope_denied')
    expect(enqueued).toEqual([])
    const ok = await registry.call('queue_enqueue', { content: 'hi' }, ctx())
    expect(ok.isError).toBeUndefined()
    expect(enqueued).toEqual([{ threadId: 'parent', input: { content: 'hi', mode: 'agent' } }])
  })

  it('thread_read reaches the caller and its lineage, and refuses a thread the host does not know', async () => {
    const { fx, registry, run, ctx } = await setup()
    await fx.delegate(run.runId, 'call-1')
    const own = JSON.parse((await registry.call('thread_read', {}, ctx())).text)
    expect(own.threadId).toBe('parent')
    expect(own.events.length).toBeGreaterThan(0)
    const child = JSON.parse((await registry.call('thread_read', { threadId: 'child-1' }, ctx())).text)
    expect(child.events.some((event: { type: string }) => event.type === 'thread.lineage')).toBe(true)
    await fx.runningRun('stranger')
    const denied = await refusalIn(registry.call('thread_read', { threadId: 'stranger' }, ctx()))
    expect(denied?.code).toBe('mousse_scope_denied')
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
      const ended = await registry.call('task_list', {}, ctx()).catch((err) => err)
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
      const call = registry.call('question_ask', { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], [TURN_TOKEN_KEY]: previous.turn.turnToken },
        request({ threadId: 'parent', runId: first.runId, binding: 'per_call', provider: 'claude' }))
      const continuation = await fx.runningRun('parent')
      // The continuation keeps the token of the turn it continues.
      const next = turns.register(appTurn({ threadId: 'parent', runId: continuation.runId }), { continuation: true })
      expect(next.turn.turnToken).toBe(previous.turn.turnToken)
      release({ runId: continuation.runId })
      expect(JSON.parse((await call).text)).toEqual({ q1: 'a' })
    })

    it('per_call: a Claude call must carry the active turn token, which is stripped before the handler', async () => {
      const { registry, ctx, registered, tasks } = await setup()
      const claude = (args: Record<string, unknown>) => registry.call('task_create', args, ctx({ binding: 'per_call', provider: 'claude' }))
      await expect(claude({ description: 'P' })).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      await expect(claude({ description: 'P', [TURN_TOKEN_KEY]: 'an-earlier-turn' })).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(tasks.list()).toHaveLength(0)
      const created = await claude({ description: 'P', [TURN_TOKEN_KEY]: registered.turn.turnToken })
      expect(created.isError).toBeFalsy()
      expect(tasks.list()).toHaveLength(1)
    })

    it('per_call: a runtime that tags calls by attempt must carry the active attempt token', async () => {
      const { registry, ctx, turns, run, tasks } = await setup()
      turns.register(appTurn({ threadId: 'parent', runId: run.runId, attemptToken: 'attempt-2' }))
      const pi = (token: string) => registry.call('task_create', { description: 'P', [ATTEMPT_TOKEN_KEY]: token }, ctx({ binding: 'per_call', provider: 'pi:openai' }))
      await expect(pi('attempt-1')).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
      expect(tasks.list()).toHaveLength(0)
      await pi('attempt-2')
      expect(tasks.list()).toHaveLength(1)
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

  it('children inherit the caller ceiling and cannot exceed it; the retired integrate_delegation only reports, even under plan', async () => {
    const { registry, ctx, delegation } = await setup('plan')
    await registry.call('delegate_task', { prompt: 'Look', title: 'Looker', workspace: 'shared', role: 'research' }, ctx({ toolCallId: 'mcp:a' }))
    expect(delegation.delegateTask).toHaveBeenCalledWith(expect.objectContaining({ modeCeiling: 'plan' }), { toolCallId: 'mcp:a' })
    const broader = await refusalIn(registry.call('delegate_task', { prompt: 'Edit', title: 'Editor', workspace: 'isolated', modeCeiling: 'default' }, ctx()))
    expect(broader?.code).toBe('mousse_ceiling_exceeded')
    // The retired merge tool is not offered over MCP any more.
    await expect(registry.call('integrate_delegation', { delegationId: 'd1' }, ctx())).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
    expect(delegation.reportResult).not.toHaveBeenCalled()
    const agentTurn = await refusalIn(registry.call('queue_enqueue', { content: 'go', mode: 'agent' }, ctx()))
    expect(agentTurn?.code).toBe('mousse_ceiling_exceeded')
  })

  it('a read-only child calls only reads and readOnlySafe tools', async () => {
    const { registry, ctx, enqueued } = await setup('default', { readOnlyThread: () => true })
    const refused = await refusalIn(registry.call('queue_enqueue', { content: 'x' }, ctx()))
    expect(refused?.code).toBe('mousse_read_only')
    expect(enqueued).toEqual([])
    expect(await refusalIn(registry.call('create_quick_action', { label: 'x', kind: 'bash', payload: 'ls' }, ctx()))).toMatchObject({ code: 'mousse_read_only' })
    expect((await registry.call('queue_list', {}, ctx())).isError).toBeUndefined()
    const listed = registry.listForThread('parent', 'default').map((tool) => tool.name)
    expect(listed).toContain('question_ask')
    expect(listed).not.toContain('queue_enqueue')
    expect(listed).not.toContain('integrate_delegation')
  })

  it('a tool Settings turned off is refused at call time with the reason, and writes no ledger row', async () => {
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const { registry, ctx, turns, run, host } = await setup('default', { toolLedger: () => ledger })
    turns.register(appTurn({ threadId: 'parent', runId: run.runId, settingsEnabled: (name) => name !== 'question_ask' }))
    const outcome = await registry.call('question_ask', { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }, ctx())
    expect(outcome).toEqual(refused('unavailable', 'Tool "question_ask" is disabled in Settings → Skills & MCP.'))
    expect(host.askUser).not.toHaveBeenCalled()
    expect(ledger.start).not.toHaveBeenCalled()
  })

  it('runs question_ask and the task tools through the shared handlers for the caller thread, and no plan tool exists', async () => {
    const { registry, ctx, host, tasks } = await setup()
    const asked = await registry.call('question_ask', { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }, ctx())
    expect(JSON.parse(asked.text)).toEqual({ q1: 'a' })
    expect(host.askUser).toHaveBeenCalledWith('parent', expect.any(Array), expect.objectContaining({ timeoutMs: 60 * 60 * 1000 }))
    for (const removed of ['present_plan', 'show_document']) expect(registry.get(removed), removed).toBeUndefined()
    const created = JSON.parse((await registry.call('task_create', { description: 'Write tests' }, ctx())).text)
    expect(tasks.list().map((task) => task.id)).toEqual([created.id])
    const failed = await registry.call('task_update', { id: '' }, ctx())
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
      expect(await call(registry, request, 'throws', {}, 'c3')).toEqual(refused('failed', 'boom'))
      expect(await refusalIn(call(registry, request, 'refuses', {}, 'c4'))).toMatchObject({ code: 'mousse_scope_denied' })
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
      expect(await refusalIn(call(registry, request, 'write', { threadId: 'other' }))).toMatchObject({ code: 'mousse_scope_denied' })
      const plan = request('run:active')
      expect(await refusalIn(registry.call('spawn', {}, { ...plan, credential: { ...plan.credential, modeCeiling: 'plan' } }))).toMatchObject({ code: 'mousse_ceiling_exceeded' })
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
      expect(await refusalIn(plan.registry.call('thread_fork', { sourceThreadId: 'child-1' }, plan.ctx()))).toMatchObject({ code: 'mousse_ceiling_exceeded' })
      expect([...plan.fx.threads]).toEqual(['child-1'])
      fx?.dispose()
      const open = await withFinishedChild()
      await open.fx.runningRun('stranger')
      expect(await refusalIn(open.registry.call('thread_fork', { sourceThreadId: 'stranger' }, open.ctx()))).toMatchObject({ code: 'mousse_scope_denied' })
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
      // Accept edits, so the call reaches the tool without asking (the asking is covered below).
      const { fx, registry, ctx, run } = await setup('default', { permissionModeFor: () => 'accept_edits' })
      const mergeBack = vi.spyOn(fx.engine, 'mergeBack')
      expect(await refusalIn(registry.call('thread_merge_back', { forkThreadId: 'someone-else' }, ctx()))).toMatchObject({ code: 'mousse_scope_denied' })
      expect(await refusalIn(registry.call('thread_merge_back', { threadId: 'someone-else' }, ctx()))).toMatchObject({ code: 'mousse_scope_denied' })
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

describe('reading and managing other threads (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const NOW = '2026-10-12T00:00:00.000Z'
  const thread = (id: string, patch: Partial<Thread> = {}): Thread =>
    ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

  /** `parent` (the caller) and `stranger` hold live runs; `elsewhere` (another project) and `loose` (no project) are known to the host. */
  const world = async (extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const parentRun = await fx.runningRun('parent')
    const strangerRun = await fx.runningRun('stranger')
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
    const call = (who: string, name: string, args: Record<string, unknown> = {}) => registry.call(name, args, request({ threadId: who, runId: runs[who] }))
    const read = async (who: string, args: Record<string, unknown>) => JSON.parse((await call(who, 'thread_read', args)).text)
    const denied = refusalIn
    return { fx, registry, turns, request, threads, messages, activity, hits, ledger, runs, call, read, denied, parentRun, strangerRun, ...fake }
  }

  const message = (index: number, content: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id: `m${index}`, role, content, timestamp: NOW })

  it('lists the tools that read and manage other threads for every caller', async () => {
    const { registry } = await world()
    expect(registry.listForThread('parent').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['thread_read', 'thread_list', 'thread_search', 'thread_wait', 'thread_send', 'thread_stop', 'thread_create', 'approval_respond'])
    )
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
      registry.register(tool('declared', 'reads', { threadId: id, sourceThreadId: id }, { authorize: checkedInHandler('the handler accepts the caller\'s own thread only') }))
      registry.register(tool('plain', 'reads', { query: id, projectId: id }))
      expect(() => registry.register(tool('blank', 'reads', { threadId: id }, { authorize: checkedInHandler('  ') }))).toThrow(/does not cover/)
    })

    it('every tool of the Mousse registry passes it, so a new one must declare how it checks a thread', async () => {
      const { registry } = await world()
      for (const registered of registry.list()) {
        const names = JSON.stringify(registered.inputSchema).match(/"\w*[tT]hreadIds?"\s*:/g) ?? []
        if (names.length) expect(['readsOthers', 'managesOthers', 'writesThreads'].includes(registered.access) || Boolean(registered.authorize?.where), registered.name).toBe(true)
      }
      expect(registry.get('thread_fork')!.authorize?.where).toBeTruthy()
    })
  })

  it('every access class registers, and the thread tools carry the class the plan names', async () => {
    const { registry } = await world()
    expect(registry.get('thread_list')).toMatchObject({ access: 'readsOthers', class: 'read' })
    expect(registry.get('thread_search')).toMatchObject({ access: 'readsOthers', class: 'read' })
    expect(registry.get('thread_read')).toMatchObject({ access: 'readsOthers' })
    const bare = new ToolRegistry({ activeRunId: () => 'run-1' })
    const tool = { name: 'x', description: 'x', inputSchema: { type: 'object' }, class: 'read', handler: () => ({ text: '' }) }
    bare.register({ ...tool, access: 'readsOthers' } as never)
    bare.register({ ...tool, name: 'y', access: 'managesOthers', class: 'mutation' } as never)
  })

  it('a thread that does not exist is refused like a private one, with no ledger row and no handler run', async () => {
    const { call, denied, ledger, threads } = await world()
    threads.set('secret', thread('secret', { localOnly: true }))
    for (const args of [{}, { view: 'messages' }]) {
      const unknown = await denied(call('parent', 'thread_read', { threadId: 'no-such-thread', ...args }))
      const hidden = await denied(call('parent', 'thread_read', { threadId: 'secret', ...args }))
      expect(unknown!.code).toBe('mousse_scope_denied')
      expect(hidden!.code).toBe('mousse_scope_denied')
      expect(unknown!.message.replace('no-such-thread', 'X')).toBe(hidden!.message.replace('secret', 'X'))
    }
    expect(ledger.start).not.toHaveBeenCalled()
  })

  it('any caller reads another thread in full: every event, a subagent\'s result and the messages', async () => {
    const { fx, read, messages, threads, strangerRun } = await world()
    const child = await fx.delegate(strangerRun.runId, 'call-1', { prompt: 'a prompt' })
    threads.set(child.childThreadId, thread(child.childThreadId))
    fx.finish(child.childRunId, 'the child result')
    messages.set('stranger', [message(0, 'hello')])
    const events = await read('parent', { threadId: 'stranger' })
    expect(events).toMatchObject({ threadId: 'stranger', view: 'events', scope: 'manage' })
    expect(JSON.stringify(events.events)).toContain('the child result')
    expect(JSON.stringify((await read('parent', { threadId: child.childThreadId })).events)).toContain('the child result')
    expect((await read('parent', { threadId: 'stranger', view: 'messages' })).messages[0].text).toBe('hello')
  })

  it('thread_read messages: paged by afterIndex and limit, each text cut at 4 KB', async () => {
    const { call, read, messages } = await world()
    messages.set('stranger', [message(0, 'one'), message(1, 'y'.repeat(5000), 'assistant'), message(2, 'three'), message(3, 'four')])
    const first = await read('parent', { threadId: 'stranger', view: 'messages', limit: 2 })
    expect(first).toMatchObject({ view: 'messages', scope: 'manage', total: 4, nextAfterIndex: 2 })
    expect(first.messages.map((entry: { index: number; text: string }) => [entry.index, entry.text.length])).toEqual([[0, 3], [1, 4096]])
    expect(first.messages[1].truncated).toBe(true)
    expect(first.messages[0].truncated).toBeUndefined()
    const second = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: first.nextAfterIndex, limit: 50 })
    expect(second.messages.map((entry: { id: string }) => entry.id)).toEqual(['m2', 'm3'])
    messages.set('parent', [message(0, 'mine')])
    expect((await read('parent', { view: 'messages' })).messages[0].text).toBe('mine')
    expect((await call('parent', 'thread_read', { threadId: 'stranger', view: 'transcript' })).isError).toBe(true)
    expect((await call('parent', 'thread_read', { threadId: 'stranger', view: 'messages', limit: 201 })).isError).toBe(true)
  })

  it('thread_read messages: system rows with no text are left out; rows keep their transcript index and the pages read on to the end', async () => {
    const { read, messages } = await world()
    // Rows: user, an empty system marker, a reply, two empty markers, a system row with text, a reply, two empty markers at the end.
    const long = 'z'.repeat(THREAD_MESSAGE_MAX_CHARS + 10)
    messages.set('stranger', [
      message(0, 'ask'), message(1, '', 'system'), message(2, 'one', 'assistant'), message(3, '', 'system'), message(4, '', 'system'),
      message(5, long, 'system'), message(6, 'two', 'assistant'), message(7, '', 'system'), message(8, '', 'system')
    ])
    const indices = (page: { messages: Array<{ index: number }> }) => page.messages.map((entry) => entry.index)
    // The limit counts the rows a reader gets, not the markers passed over.
    const first = await read('parent', { threadId: 'stranger', view: 'messages', limit: 2 })
    expect(indices(first)).toEqual([0, 2])
    expect(first).toMatchObject({ total: 9, nextAfterIndex: 3 })
    // A system row with text is read like any other, and read on with textOffset.
    const second = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: first.nextAfterIndex, limit: 1 })
    expect(second.messages[0]).toMatchObject({ index: 5, role: 'system', truncated: true })
    const rest = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: 5, textOffset: second.messages[0].nextTextOffset, limit: 2 })
    expect(rest.messages.map((entry: { index: number; text: string }) => [entry.index, entry.text])).toEqual([[5, 'z'.repeat(10)], [6, 'two']])
    // Following the pages from there reaches the end of the transcript, past the markers it ends with.
    let at = rest.nextAfterIndex
    for (let pages = 0; pages < 3 && at < 9; pages += 1) {
      const page = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: at })
      expect(page.messages).toEqual([])
      expect(page.nextAfterIndex).toBeGreaterThan(at)
      at = page.nextAfterIndex
    }
    expect(at).toBe(9)
  })

  it('thread_read messages: a message marked truncated is read on with textOffset to its end, never splitting a character', async () => {
    const { call, read, messages } = await world()
    // A character outside the BMP sits on the cut: the first part stops before it rather than halving it.
    const long = `${'a'.repeat(THREAD_MESSAGE_MAX_CHARS - 1)}😀${Array.from({ length: 6000 }, (_, at) => String.fromCharCode(98 + (at % 24))).join('')}`
    messages.set('stranger', [message(0, 'before'), message(1, long, 'assistant'), message(2, 'after')])
    const first = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: 1, limit: 1 })
    expect(first.messages[0]).toMatchObject({ index: 1, truncated: true, totalChars: long.length, nextTextOffset: THREAD_MESSAGE_MAX_CHARS - 1 })
    expect(first.hint).toContain('textOffset')
    let text = first.messages[0].text as string
    let next: number | undefined = first.messages[0].nextTextOffset
    const offsets: number[] = []
    while (next !== undefined) {
      offsets.push(next)
      const page = await read('parent', { threadId: 'stranger', view: 'messages', afterIndex: 1, textOffset: next, limit: 2 })
      expect(page.messages[0]).toMatchObject({ index: 1, textOffset: next })
      // The offset applies to the message at afterIndex only; the next one starts at its beginning.
      expect(page.messages[1]).toMatchObject({ index: 2, text: 'after' })
      text += page.messages[0].text
      next = page.messages[0].nextTextOffset
    }
    expect(text).toBe(long)
    expect(offsets).toHaveLength(Math.ceil((long.length - (THREAD_MESSAGE_MAX_CHARS - 1)) / THREAD_MESSAGE_MAX_CHARS))
    expect((await call('parent', 'thread_read', { threadId: 'stranger', view: 'messages', afterIndex: 1, textOffset: long.length })).isError).toBe(true)
  })

  it('thread_read messages: an agent\'s long message reads on over its stored text, label and closing line included', async () => {
    const { read, messages } = await world()
    const words = Array.from({ length: 9000 }, (_, at) => String.fromCharCode(65 + (at % 26))).join('')
    const envelope = agentMessage('sender-thread', 'Sender', words)
    messages.set('stranger', [{ ...message(0, envelope.text), origin: { kind: 'agent', threadId: 'sender-thread', runId: 'r', body: { head: envelope.head, tail: envelope.tail } } } as ChatMessage])
    let page = (await read('parent', { threadId: 'stranger', view: 'messages' })).messages[0]
    // The offsets count the stored text: the first part starts with the label, and the agent's words start after it.
    expect(page.text.startsWith(AGENT_MESSAGE_PREFIX)).toBe(true)
    expect(page.totalChars).toBe(envelope.text.length)
    let text = page.text as string
    while (page.nextTextOffset !== undefined) {
      page = (await read('parent', { threadId: 'stranger', view: 'messages', textOffset: page.nextTextOffset })).messages[0]
      text += page.text
    }
    expect(text).toBe(envelope.text)
    expect(text.endsWith(AGENT_MESSAGE_END)).toBe(true)
    expect(text.slice(envelope.head, text.length - envelope.tail)).toBe(words)
  })

  /** Every page a reader gets by following the continuation, until it says there is no more. */
  const allPages = async (read: (args: Record<string, unknown>) => Promise<Record<string, any>>, args: Record<string, unknown>, cursor: 'afterIndex' | 'afterSeq') => {
    const pages: Array<Record<string, any>> = []
    let at = 0
    for (;;) {
      const page = await read({ ...args, [cursor]: at })
      pages.push(page)
      const next = cursor === 'afterIndex' ? page.nextAfterIndex : page.nextAfterSeq
      if (!page.capped || next === at) return pages
      at = next
    }
  }

  it(`thread_read holds a response to ${THREAD_READ_MAX_BYTES / 1024} KB in the messages view, counted in bytes, and continues where it stopped`, async () => {
    const { call, messages } = await world()
    // Two bytes a character: a cap counted in characters would let twice as much through.
    const all = Array.from({ length: 50 }, (_, index) => message(index, `${index}:${'é'.repeat(3_000)}`))
    messages.set('stranger', all)
    const raw = async (args: Record<string, unknown>) => (await call('parent', 'thread_read', { threadId: 'stranger', view: 'messages', ...args })).text
    const pages = await allPages(async (args) => {
      const text = await raw(args)
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(THREAD_READ_MAX_BYTES)
      return JSON.parse(text)
    }, { limit: 50 }, 'afterIndex')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]).toMatchObject({ capped: true, hint: expect.stringContaining(`afterIndex ${pages[0].messages.length}`) })
    // Every message once, in order, none cut: the pages fit whole messages and the next page starts at the first left out.
    expect(pages.flatMap((page) => page.messages.map((entry: { id: string }) => entry.id))).toEqual(all.map((entry) => entry.id))
    expect(pages.flatMap((page) => page.messages).some((entry: { truncated?: boolean }) => entry.truncated)).toBe(false)
    expect(pages.at(-1)!.capped).toBeUndefined()
  })

  it(`thread_read holds a response to ${THREAD_READ_MAX_BYTES / 1024} KB in the events view, continues after the last event it holds, and previews an event too big for a response`, async () => {
    const { call, fx, strangerRun } = await world()
    const from = fx.engine.maxSeq('stranger')
    for (let index = 0; index < 120; index += 1)
      fx.engine.store.appendEvent({ threadId: 'stranger', runId: strangerRun.runId, type: 'tool.call', payload: { index, text: 'é'.repeat(1_000) } })
    fx.engine.store.appendEvent({ threadId: 'stranger', runId: strangerRun.runId, type: 'tool.call', payload: { index: 'huge', text: 'z'.repeat(THREAD_READ_MAX_BYTES * 2) } })
    fx.engine.store.appendEvent({ threadId: 'stranger', runId: strangerRun.runId, type: 'tool.call', payload: { index: 'last', text: 'end' } })
    const pages = await allPages(async (args) => {
      const text = (await call('parent', 'thread_read', { threadId: 'stranger', limit: 500, ...args })).text
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(THREAD_READ_MAX_BYTES)
      return JSON.parse(text)
    }, {}, 'afterSeq')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]).toMatchObject({ capped: true, nextAfterSeq: pages[0].events.at(-1).seq })
    const seqs = pages.flatMap((page) => page.events.map((event: { seq: number }) => event.seq))
    expect(seqs).toEqual(fx.engine.listEvents('stranger', { limit: 1000 }).map((event) => event.seq))
    const ours = pages.flatMap((page) => page.events).filter((event: { seq: number }) => event.seq > from)
    expect(ours.slice(0, 120).map((event: { payload: { index: number } }) => event.payload.index)).toEqual(Array.from({ length: 120 }, (_, index) => index))
    expect(ours[120].payload).toMatchObject({ truncated: true, bytes: expect.any(Number), preview: expect.stringContaining('"index":"huge"') })
    expect(ours[120].payload.bytes).toBeGreaterThan(THREAD_READ_MAX_BYTES)
    expect(ours[121].payload).toEqual({ index: 'last', text: 'end' })
  })

  it(`thread_read cuts a run\'s final text in the events to ${THREAD_RESULT_MAX_CHARS} characters with a pointer to the messages`, async () => {
    const { read, fx, threads, strangerRun } = await world()
    const long = `${'w'.repeat(THREAD_RESULT_MAX_CHARS)}-the rest`
    const child = await fx.delegate(strangerRun.runId, 'call-long')
    threads.set(child.childThreadId, thread(child.childThreadId))
    fx.finish(child.childRunId, long)
    const result = (await read('parent', { threadId: child.childThreadId })).events.find((event: { type: string }) => event.type === 'run.result')
    expect(result.payload).toMatchObject({ runId: child.childRunId, text: `${'w'.repeat(THREAD_RESULT_MAX_CHARS)}…`, truncated: true, totalChars: long.length, hint: expect.stringContaining('view "messages"') })
  })

  it('thread_list: every project, started and unarchived by default, filters and limits, with the pending questions', async () => {
    const { call, fx, threads, activity, strangerRun } = await world()
    threads.set('draft', thread('draft', { startedAt: undefined }))
    threads.set('old', thread('old', { archivedAt: NOW }))
    threads.set('quiet', thread('quiet', { updatedAt: '2026-10-11T00:00:00.000Z' }))
    const sub = await fx.delegate(strangerRun.runId, 'call-sub')
    threads.set(sub.childThreadId, thread(sub.childThreadId, { lineage: { parentThreadId: 'stranger', rootThreadId: 'stranger', relationship: 'subagent' } }))
    activity.set('stranger', {
      queuedCount: 2,
      pendingQuestions: [{ requestId: 'req-1', threadId: 'stranger', questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] } as never]
    })
    const list = async (args: Record<string, unknown> = {}) => JSON.parse((await call('parent', 'thread_list', args)).text) as { threads: Array<Record<string, unknown>>; projects: unknown[] }
    const ids = (value: { threads: Array<Record<string, unknown>> }) => value.threads.map((row) => row.id)

    const base = await list()
    expect(ids(base)).toEqual(['parent', 'stranger', 'elsewhere', 'loose', 'quiet'])
    expect(base.projects).toEqual([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }])
    expect(base.threads.find((row) => row.id === 'stranger')).toMatchObject({
      projectId: 'p1', projectName: 'One', queuedCount: 2, pendingQuestionCount: 1, status: 'awaiting_input', activeRunId: strangerRun.runId,
      pendingQuestions: [expect.objectContaining({ requestId: 'req-1' })]
    })

    expect(ids(await list({ includeUnstarted: true }))).toContain('draft')
    expect(ids(await list({ includeArchived: true }))).toContain('old')
    // The name an agent learned before archived threads were called archived still works.
    expect(ids(await list({ includeSettled: true }))).toContain('old')
    expect((await call('parent', 'thread_list', { includeSettled: 'yes' })).isError).toBe(true)
    // Archived and hidden rows say so; open, shown rows carry neither.
    threads.set('tucked', thread('tucked', { hidden: true }))
    const archived = (await list({ includeArchived: true })).threads
    expect(archived.find((row) => row.id === 'old')).toMatchObject({ archived: true, archivedAt: NOW })
    expect(archived.find((row) => row.id === 'tucked')).toMatchObject({ hidden: true })
    expect(archived.find((row) => row.id === 'quiet')).not.toHaveProperty('archived')
    expect(archived.find((row) => row.id === 'quiet')).not.toHaveProperty('hidden')
    threads.delete('tucked')
    expect(ids(await list({ includeSubagents: true }))).toContain(sub.childThreadId)
    expect(ids(await list({ projectId: 'p2' }))).toEqual(['elsewhere'])
    expect(ids(await list({ status: 'awaiting_input' }))).toEqual(['stranger'])
    expect(ids(await list({ status: 'active' }))).toEqual(['parent'])
    expect(ids(await list({ status: 'idle' }))).toContain('quiet')
    expect(ids(await list({ limit: 1 }))).toHaveLength(1)
    expect((await call('parent', 'thread_list', { limit: 0 })).isError).toBe(true)
    expect((await call('parent', 'thread_list', { status: 'busy' })).isError).toBe(true)
    // A thread the caller launched is listed even unstarted; a private one is not listed for a shared caller.
    threads.set('mine', thread('mine', { projectId: 'p2', startedAt: undefined, createdByThreadId: 'parent' }))
    threads.set('secret', thread('secret', { localOnly: true }))
    expect(ids(await list())).toContain('mine')
    expect(ids(await list())).not.toContain('secret')
    expect(ids(await list({ projectId: 'p1' }))).not.toContain('mine')
    // Once archived it leaves the default list like any other, and comes back marked with includeArchived.
    threads.set('mine', { ...threads.get('mine')!, archivedAt: NOW })
    expect(ids(await list())).not.toContain('mine')
    expect((await list({ includeArchived: true })).threads.find((row) => row.id === 'mine')).toMatchObject({ archived: true, archivedAt: NOW })
  })

  it('thread_search: titles, projects and message matches with snippets in every project, private threads left out before the limit', async () => {
    const seen: Array<{ limit: number; titlesOnly?: boolean; maxMessageThreads?: number; allow?: (thread: Thread) => boolean }> = []
    const { call, hits, host } = await world()
    hits.push(
      { threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'thread' },
      { threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'message', snippet: 'the work: a plan', messageId: 'm1' },
      { threadId: 'elsewhere', threadName: 'Elsewhere work', projectId: 'p2', projectName: 'Two', matchType: 'thread' }
    )
    const search = host.searchThreads!
    host.searchThreads = (query, limit, options) => (seen.push({ limit, ...options }), search(query, limit, options))
    const results = JSON.parse((await call('parent', 'thread_search', { query: 'work' })).text).results as Array<Record<string, unknown>>
    expect(results.map((hit) => [hit.threadId, hit.matchType])).toEqual([['stranger', 'thread'], ['stranger', 'message'], ['elsewhere', 'thread']])
    expect(results[1]).toMatchObject({ snippet: 'the work: a plan', link: 'mousse://thread/stranger' })
    expect(seen[0]).toMatchObject({ limit: 50, titlesOnly: false, maxMessageThreads: 100 })
    const allow = seen[0].allow!
    expect(allow(thread('elsewhere', { projectId: 'p2' }))).toBe(true)
    expect(allow(thread('loose', { projectId: undefined }))).toBe(true)
    expect(allow(thread('secret', { localOnly: true }))).toBe(false)
    expect(allow(thread('a-bot', { botOwned: true } as Partial<Thread>))).toBe(false)
    expect(JSON.parse((await call('parent', 'thread_search', { query: 'work', limit: 2 })).text).results).toHaveLength(2)
    expect((await call('parent', 'thread_search', { query: '  ' })).isError).toBe(true)
    expect((await call('parent', 'thread_search', { query: 'x'.repeat(513) })).isError).toBe(true)
    expect((await call('parent', 'thread_search', { query: 'work', limit: 201 })).isError).toBe(true)
  })

  it('thread_search finds subagents, labelled with their parent, under the visibility of the thread at the top of their chain', async () => {
    const seen: Array<{ hideSubagents?: boolean; allow?: (thread: Thread) => boolean }> = []
    const { call, hits, host, threads, fx, strangerRun } = await world()
    const sub = await fx.delegate(strangerRun.runId, 'call-sub')
    const lineage = (parentThreadId: string, rootThreadId = parentThreadId) => ({ lineage: { parentThreadId, rootThreadId, relationship: 'subagent' as const } })
    threads.set(sub.childThreadId, thread(sub.childThreadId, { name: 'Reviewer work', ...lineage('stranger') }))
    hits.push({ threadId: sub.childThreadId, threadName: 'Reviewer work', projectId: 'p1', projectName: 'One', matchType: 'thread' })
    const search = host.searchThreads!
    host.searchThreads = (query, limit, options) => (seen.push({ ...options }), search(query, limit, options))
    const results = JSON.parse((await call('parent', 'thread_search', { query: 'reviewer' })).text).results as Array<Record<string, unknown>>
    expect(results).toEqual([expect.objectContaining({ threadId: sub.childThreadId, subagent: true, parentThreadId: 'stranger', link: `mousse://thread/${sub.childThreadId}` })])
    // The store is asked not to fold subagents away, and decides each one by its chain.
    expect(seen[0].hideSubagents).toBe(false)
    const allow = seen[0].allow!
    threads.set('private-root', thread('private-root', { localOnly: true }))
    threads.set('bot-root', thread('bot-root', { botOwned: true } as Partial<Thread>))
    threads.set('manager', thread('manager', { automationManager: true } as Partial<Thread>))
    expect(allow(threads.get(sub.childThreadId)!)).toBe(true)
    expect(allow(thread('under-private', lineage('private-root')))).toBe(false)
    expect(allow(thread('under-bot', lineage('bot-root')))).toBe(false)
    expect(allow(thread('under-manager', lineage('manager')))).toBe(false)
    expect(allow(threads.get('manager')!)).toBe(false)
    // A thread that is no subagent carries no label.
    hits.push({ threadId: 'stranger', threadName: 'Stranger work', projectId: 'p1', projectName: 'One', matchType: 'thread' })
    const plain = JSON.parse((await call('parent', 'thread_search', { query: 'stranger' })).text).results as Array<Record<string, unknown>>
    expect(plain[0]).not.toHaveProperty('subagent')
  })

  it('a definition run is held to the thread check before its approval is asked, so a refused call never prompts a person', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    await fx.runningRun('stranger')
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
    const fake = fakeAppToolHost({ threadMeta: (id) => (id === 'no-such-thread' ? undefined : thread(id)), listThreads: () => [thread('stranger')], listProjects: () => [] })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: run.runId, definition: definition as never }))
    const as = () => request({ threadId: 'parent', runId: run.runId })
    // A thread that does not exist: refused by the thread check, which comes before the definition's approval.
    expect(await refusalIn(registry.call('thread_read', { threadId: 'no-such-thread' }, as()))).toMatchObject({ code: 'mousse_scope_denied' })
    expect(asked).toEqual([])
    // Another thread passes the check and then meets the definition's own approval.
    expect((await registry.call('thread_read', { threadId: 'stranger' }, as())).isError).toBeFalsy()
    expect(asked).toEqual(['asked'])
  })

  it('a tool whose host method is absent answers "not available in this host"', async () => {
    const { call } = await world({ listThreads: undefined, searchThreads: undefined, threadMessages: undefined })
    expect(await call('parent', 'thread_list')).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
    expect(await call('parent', 'thread_search', { query: 'a' })).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
    expect(await call('parent', 'thread_read', { threadId: 'stranger', view: 'messages' })).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
  })

  it('a read-only subagent may call the read-others tools', async () => {
    const { registry, call, read } = await world({ readOnlyThread: (id) => id === 'parent' })
    expect((await read('parent', { threadId: 'stranger' })).threadId).toBe('stranger')
    expect((await call('parent', 'thread_list')).isError).toBeUndefined()
    expect(registry.listForThread('parent').map((tool) => tool.name)).toEqual(expect.arrayContaining(['thread_read', 'thread_list', 'thread_search']))
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
    const call = (name = 'thread_merge_back', args: Record<string, unknown> = {}) =>
      registry.call(name, args, request({ threadId: 'parent', runId: run.runId }))
    return { call, asked, registry, run, turns, ...fake }
  }
  const refused = (result: { isError?: boolean; text: string }) => result.isError === true && result.text.includes('did not approve')

  it('asks under Ask before the handler runs, and a rejection leaves the workspace untouched', async () => {
    const { call, asked } = await setup('ask', 'reject')
    await expect(call()).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(asked).toEqual([{ threadId: 'parent', approval: expect.objectContaining({ action: 'edit', permissionKey: 'mousse:merge_back' }) }])
  })

  it('runs after the user allows it once, and counts a dismissed question as a rejection', async () => {
    const allowed = await setup('ask', 'allow')
    // The handler runs (and refuses on its own: this thread is not a fork), so the approval did not stop it.
    expect(refused(await allowed.call().catch((error) => ({ isError: true, text: String(error) })))).toBe(false)
    expect(allowed.asked).toHaveLength(1)
    const dismissed = await setup('ask', 'throw')
    await expect(dismissed.call()).resolves.toMatchObject({ isError: true })
  })

  it('asks as under Ask when the host knows no permission mode', async () => {
    const { call, asked } = await setup(undefined, 'reject')
    await expect(call()).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(asked).toHaveLength(1)
  })

  it.each(['accept_edits', 'full'] as const)('runs without asking under %s', async (mode) => {
    const { call, asked } = await setup(mode)
    expect(refused(await call().catch((error) => ({ isError: true, text: String(error) })))).toBe(false)
    expect(asked).toEqual([])
  })

  it('the retired integrate_delegation is not offered over MCP and asks nothing', async () => {
    const { call, asked, delegation, registry } = await setup('ask', 'reject')
    await expect(call('integrate_delegation', { delegationId: 'd1' })).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
    expect(delegation.reportResult).not.toHaveBeenCalled()
    expect(asked).toEqual([])
    // In process it stays dispatchable for replayed transcripts, and changes no workspace.
    expect(registry.get('integrate_delegation')).toMatchObject({ callable: 'in_process', access: 'actsAsCaller', readOnlySafe: true })
  })

  it('refuses a call that names another thread before it asks the user anything', async () => {
    const { call, asked } = await setup('ask')
    expect(await refusalIn(call('thread_merge_back', { threadId: 'someone-else' }))).toMatchObject({ code: 'mousse_scope_denied' })
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
    await expect(registry.call('thread_merge_back', {}, request({ threadId: 'parent', runId: run.runId })))
      .resolves.toMatchObject({ isError: true })
  })

})
