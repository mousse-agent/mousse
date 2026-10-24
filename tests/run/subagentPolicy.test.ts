/**
 * Issue #142: what a delegated child may do. `delegate_task` refuses a target that cannot keep a
 * child to its policy (as a value, with no thread created), every turn of a child carries its
 * policy (first and resumed), and a read-only child's Mousse tools cannot write threads.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegateTaskInput, DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import { ANTIGRAVITY_CAPABILITIES } from '../../src/mms/run/adapters/antigravity/AntigravityAdapter'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { createMousseToolRegistry, ToolRegistry } from '../../src/mms/run/mcp/toolRegistry'
import { subagentTargetRefusal } from '../../src/mms/run/policy/featureGates'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { phase6Daemon, waitFor } from './phase6Fixture'

type Script = (input: TurnInput, host: AdapterHost) => Promise<string>

class ScriptedAdapter implements ProviderAdapter {
  readonly turns: Array<{ input: TurnInput; delegation: DelegationToolHost | undefined; toolAccess: AdapterHost['tools']['toolAccess'] }> = []
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push({ input, delegation: host.tools.delegation, toolAccess: host.tools.toolAccess })
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const native = this.capabilities.historyInjection === 'native'
    if (!native) host.context.nativeHistoryAfterTurn(text)
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: native ? [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never] : [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('subagent target preflight table', () => {
  it.each([
    ['pi', PI_LOOP_CAPABILITIES, null],
    ['claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, null],
    ['codex', CODEX_CAPABILITIES, null],
    ['antigravity', ANTIGRAVITY_CAPABILITIES, 'provider_unsupported_for_subagents']
  ] as const)('%s', (driver, capabilities, code) => {
    expect(subagentTargetRefusal(capabilities, driver)?.code ?? null).toBe(code)
  })
})

describe('delegated child policy', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** A pi parent in a project; `onParent` runs inside its first turn with the delegation tools. */
  const daemon = (onParent: (delegation: DelegationToolHost, threadId: string) => Promise<void>, onChild: Script = async () => 'Looked.') => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-policy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const parent = new ScriptedAdapter('pi', PI_LOOP_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return 'unexpected pi turn'
      await onParent(host.tools.delegation!, input.threadId)
      return 'Delegated.'
    })
    const claude = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, onChild)
    const antigravity = new ScriptedAdapter('antigravity', ANTIGRAVITY_CAPABILITIES, async () => 'should never run')
    const d = phase6Daemon(home, [parent, claude, antigravity])
    stops.push(d.stop)
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Parent', project.id)
    return { d, parent, claude, antigravity, thread, projectDir }
  }

  const delegate = (delegation: DelegationToolHost, patch: Partial<DelegateTaskInput>, id: string) =>
    delegation.delegateTask({ prompt: 'Look at it', workspace: 'shared', role: 'research', instanceId: 'claude', ...patch }, { toolCallId: id }) as Promise<Record<string, unknown>>

  it.each([
    ['shared', { workspace: 'shared', role: 'research' }],
    ['isolated', { workspace: 'isolated', role: 'implement' }]
  ] as const)('refuses an Antigravity target for a %s child with a value, creating no thread', async (_workspace, patch) => {
    const outcomes: Record<string, unknown> = {}
    const { d, thread, antigravity } = daemon(async (delegation) => {
      outcomes.explicit = await delegate(delegation, { ...patch, instanceId: 'antigravity' }, 'explicit')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    expect(outcomes.explicit).toMatchObject({ started: false, code: 'provider_unsupported_for_subagents', message: expect.stringContaining('antigravity') })
    expect(d.engine.delegations.listForParentThread(thread.id)).toEqual([])
    expect(d.store.listAllThreads().map((entry) => entry.id)).toEqual([thread.id])
    expect(antigravity.turns).toEqual([])
  }, 30_000)

  it('refuses a child that would inherit an Antigravity parent selection', () => {
    const { d, thread } = daemon(async () => undefined)
    const refusalFor = (instanceId?: string) =>
      (d.orch as unknown as { delegationRefusal(parent: string, instanceId: string | undefined): unknown }).delegationRefusal(thread.id, instanceId)
    d.orch.setThreadModelOverride(thread.id, { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'agent' })
    expect(refusalFor()).toMatchObject({ started: false, code: 'provider_unsupported_for_subagents' })
    // An explicit instance wins over the parent's selection, in both directions.
    expect(refusalFor('claude')).toBeNull()
    d.orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    expect(refusalFor()).toBeNull()
    expect(refusalFor('antigravity')).toMatchObject({ code: 'provider_unsupported_for_subagents' })
  })

  it('starts a Claude child and carries its policy on the first and on a resumed turn', async () => {
    const started: Record<string, { childThreadId: string; childRunId: string }> = {}
    const { d, claude, thread, projectDir } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')
    const turnsOf = (threadId: string) => claude.turns.filter((turn) => turn.input.threadId === threadId)

    expect(turnsOf(started.shared.childThreadId)[0].input).toMatchObject({ child: { readOnly: true }, cwd: projectDir })
    expect(turnsOf(started.isolated.childThreadId)[0].input.child).toEqual({ readOnly: false })

    // A later message to each child (the session is rebuilt from storage, as after a restart).
    for (const [name, child] of Object.entries(started)) {
      ;(d.orch as unknown as { sessions: Map<string, unknown> }).sessions.delete(child.childThreadId)
      await d.orch.send('Look again', false, { threadId: child.childThreadId, clientRequestId: `again-${name}` })
    }
    expect(turnsOf(started.shared.childThreadId)).toHaveLength(2)
    expect(turnsOf(started.shared.childThreadId)[1].input).toMatchObject({ child: { readOnly: true }, cwd: projectDir })
    expect(turnsOf(started.isolated.childThreadId)[1].input.child).toEqual({ readOnly: false })
    // The parent is not a subagent.
    expect(claude.turns.every((turn) => turn.input.threadId !== thread.id)).toBe(true)
  }, 30_000)

  it('a shared child gets no delegation tools; an isolated one does', async () => {
    const started: Record<string, { childThreadId: string; childRunId: string }> = {}
    const { d, claude, thread } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')
    const turn = (threadId: string) => claude.turns.find((entry) => entry.input.threadId === threadId)!
    expect(turn(started.shared.childThreadId).delegation).toBeUndefined()
    expect(turn(started.isolated.childThreadId).delegation).toBeDefined()
  }, 30_000)

  it('a shared pi child can only read: no write, shell, thread or delegation tools, first turn and resumed', async () => {
    let started: { childThreadId: string; childRunId: string } | undefined
    const { d, parent, thread } = daemon(async (delegation) => {
      started = await delegate(delegation, { workspace: 'shared', role: 'research', instanceId: 'pi:openai' }, 'pi-child') as never
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    await waitFor(() => d.engine.getRun(started!.childRunId)?.status === 'completed', 'the child run')
    ;(d.orch as unknown as { sessions: Map<string, unknown> }).sessions.delete(started!.childThreadId)
    await d.orch.send('Look again', false, { threadId: started!.childThreadId, clientRequestId: 'again' })
    const childTurns = parent.turns.filter((turn) => turn.input.threadId === started!.childThreadId)
    expect(childTurns).toHaveLength(2)
    for (const turn of childTurns) {
      expect(turn.input.child).toEqual({ readOnly: true })
      expect(turn.delegation).toBeUndefined()
      for (const tool of ['write_file', 'edit_file', 'bash', 'delegate_task', 'integrate_delegation', 'create_task', 'queue_enqueue', 'thread_fork', 'thread_merge_back'])
        expect(turn.toolAccess?.allows(tool), tool).toBe(false)
      expect(turn.toolAccess?.allows('read_file')).toBe(true)
    }
  }, 30_000)

  it("a read-only child's Mousse tools cannot write threads, start work or integrate; read tools still work", async () => {
    const started: Record<string, { childThreadId: string; childRunId: string }> = {}
    const results: Record<string, Record<string, unknown>> = { shared: {}, isolated: {} }
    let registryReady: ((registry: ToolRegistry) => void) | undefined
    const registry = new Promise<ToolRegistry>((resolve) => (registryReady = resolve))
    const probed = new Set<string>()
    let engine: ReturnType<typeof phase6Daemon>['engine'] | undefined
    const probe = async (input: TurnInput) => {
      // The child's turn can start before `delegate_task` returns, so name it by its delegation row.
      const name = engine?.delegations.listForChildThread(input.threadId).at(-1)?.workspace ?? undefined
      // The isolated child's queued message runs another turn on it; probe each child once.
      if (!name || probed.has(name)) return 'Looked.'
      probed.add(name)
      const tools = await registry
      const caller = { threadId: input.threadId, runId: input.runId, provider: 'claude', modeCeiling: 'default' as const }
      for (const [tool, args] of [
        ['thread_read', {}],
        ['queue_list', {}],
        ['queue_enqueue', { content: 'write more' }],
        ['thread_fork', {}],
        ['thread_merge_back', {}],
        ['delegate_task', { prompt: 'x', workspace: 'isolated', role: 'implement' }],
        ['integrate_delegation', { delegationId: 'delegation:any' }],
        ['create_task', { title: 't' }]
      ] as const) {
        results[name][tool] = await tools.call(tool, { ...args }, { caller, toolCallId: `${name}-${tool}`, signal: new AbortController().signal })
          .then(() => 'allowed', (error: { code?: string }) => error.code ?? 'error')
      }
      return 'Probed.'
    }
    const { d, thread } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    }, async (input) => probe(input))
    engine = d.engine
    registryReady!(createMousseToolRegistry({ engine: d.engine, host: d.orch.mcpToolHost() }))
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')

    expect(results.shared).toEqual({
      thread_read: 'allowed',
      queue_list: 'allowed',
      queue_enqueue: 'mousse_read_only',
      thread_fork: 'mousse_read_only',
      thread_merge_back: 'mousse_read_only',
      delegate_task: 'mousse_read_only',
      integrate_delegation: 'mousse_read_only',
      create_task: 'mousse_read_only'
    })
    // The same calls are not refused by the policy for an isolated child.
    expect(Object.values(results.isolated)).not.toContain('mousse_read_only')
    expect(results.isolated.queue_enqueue).toBe('allowed')
  }, 30_000)
})

describe('ToolRegistry read-only gate', () => {
  const tool = (name: string, access: 'reads' | 'actsAsCaller' | 'writesThreads' | 'startsThreads', readOnlySafe = false) => ({
    name, description: name, inputSchema: {}, access, ...(readOnlySafe ? { readOnlySafe } : {}), handler: () => ({ text: 'ok' })
  })
  const registry = new ToolRegistry({ activeRunId: () => 'run-1', readOnlyThread: (threadId) => threadId === 'child' })
    .register(tool('reads', 'reads'))
    .register(tool('safe', 'actsAsCaller', true))
    .register(tool('acts', 'actsAsCaller'))
    .register(tool('writes', 'writesThreads'))
    .register(tool('starts', 'startsThreads'))
  const call = (name: string, threadId: string) =>
    registry.call(name, {}, { caller: { threadId, runId: 'run-1', provider: 'claude', modeCeiling: 'default' }, toolCallId: 'c', signal: new AbortController().signal })

  it.each([
    ['reads', true], ['safe', true], ['acts', false], ['writes', false], ['starts', false]
  ])('%s is %s for a read-only caller', async (name, allowed) => {
    if (allowed) await expect(call(name, 'child')).resolves.toMatchObject({ text: 'ok' })
    else await expect(call(name, 'child')).rejects.toMatchObject({ code: 'mousse_read_only' })
  })

  it.each(['reads', 'safe', 'acts', 'writes', 'starts'])('%s works for any other caller', async (name) => {
    await expect(call(name, 'parent')).resolves.toMatchObject({ text: 'ok' })
  })
})
