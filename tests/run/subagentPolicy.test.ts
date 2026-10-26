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
import { ANTIGRAVITY_CAPABILITIES } from '../../src/mms/harness/acp/presets/antigravity'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { READ_ONLY_MOUSSE_TOOLS } from '../../src/mms/run/mcp/attachment'
import { AppToolTurns, ToolRegistry } from '../../src/mms/run/mcp/appTools'
import { appTurn } from './appToolsFixture'
import { subagentTargetRefusal, type ChildPreflightContext, type SubagentRefusal } from '../../src/mms/run/policy/featureGates'
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
    ['pi', PI_LOOP_CAPABILITIES, 'shared', null],
    ['pi', PI_LOOP_CAPABILITIES, 'isolated', null],
    ['claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, 'shared', null],
    ['claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, 'isolated', null],
    ['codex', CODEX_CAPABILITIES, 'shared', null],
    ['codex', CODEX_CAPABILITIES, 'isolated', null],
    // Antigravity rejects plan mode, so it cannot be read-only; an isolated child is fine.
    ['antigravity', ANTIGRAVITY_CAPABILITIES, 'shared', 'shared_unsupported_for_provider'],
    ['antigravity', ANTIGRAVITY_CAPABILITIES, 'isolated', null]
  ] as const)('%s, %s child', (driver, capabilities, workspace, code) => {
    expect(subagentTargetRefusal(capabilities, driver, workspace)?.code ?? null).toBe(code)
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
  const daemon = (onParent: (delegation: DelegationToolHost, threadId: string) => Promise<void>, onChild: Script = async () => 'Looked.', onPiChild?: Script) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-subagent-policy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const parent = new ScriptedAdapter('pi', PI_LOOP_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return onPiChild ? onPiChild(input, host) : 'unexpected pi turn'
      await onParent(host.tools.delegation!, input.threadId)
      return 'Delegated.'
    })
    const claude = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, onChild)
    const antigravity = new ScriptedAdapter('antigravity', ANTIGRAVITY_CAPABILITIES, async () => 'Looked.')
    const d = phase6Daemon(home, [parent, claude, antigravity])
    stops.push(d.stop)
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Parent', project.id)
    return { d, parent, claude, antigravity, thread, projectDir }
  }

  const delegate = (delegation: DelegationToolHost, patch: Partial<DelegateTaskInput>, id: string) =>
    delegation.delegateTask({ prompt: 'Look at it', workspace: 'shared', role: 'research', instanceId: 'claude', ...patch }, { toolCallId: id }) as Promise<Record<string, unknown>>

  it('refuses an Antigravity target for a shared child with a value, creating no thread', async () => {
    const outcomes: Record<string, unknown> = {}
    const { d, thread, antigravity } = daemon(async (delegation) => {
      outcomes.explicit = await delegate(delegation, { workspace: 'shared', role: 'research', instanceId: 'antigravity' }, 'explicit')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    expect(outcomes.explicit).toMatchObject({ started: false, code: 'shared_unsupported_for_provider', message: expect.stringContaining('"isolated"') })
    expect(d.engine.delegations.listForParentThread(thread.id)).toEqual([])
    expect(d.store.listAllThreads().map((entry) => entry.id)).toEqual([thread.id])
    expect(antigravity.turns).toEqual([])
  }, 30_000)

  it('starts an isolated child on Antigravity', async () => {
    const outcomes: Record<string, Record<string, unknown>> = {}
    const { d, thread, antigravity } = daemon(async (delegation) => {
      outcomes.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement', instanceId: 'antigravity' }, 'isolated')
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    expect(outcomes.isolated.started).not.toBe(false)
    await waitFor(() => d.engine.getRun(outcomes.isolated.childRunId as string)?.status === 'completed', 'the child run')
    expect(antigravity.turns).toHaveLength(1)
  }, 30_000)

  it('refuses a child that would inherit an Antigravity parent selection', async () => {
    const { d, thread } = daemon(async () => undefined)
    const refusalFor = (instanceId?: string, workspace: 'shared' | 'isolated' = 'shared') =>
      (d.orch as unknown as { delegationRefusal(parent: string, instanceId: string | undefined, workspace: 'shared' | 'isolated'): Promise<unknown> }).delegationRefusal(thread.id, instanceId, workspace)
    d.orch.setThreadModelOverride(thread.id, { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'agent' })
    expect(await refusalFor()).toMatchObject({ started: false, code: 'shared_unsupported_for_provider' })
    expect(await refusalFor(undefined, 'isolated')).toBeNull()
    // An explicit instance wins over the parent's selection, in both directions.
    expect(await refusalFor('claude')).toBeNull()
    d.orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    expect(await refusalFor()).toBeNull()
    expect(await refusalFor('antigravity')).toMatchObject({ code: 'shared_unsupported_for_provider' })
    expect(await refusalFor('antigravity', 'isolated')).toBeNull()
  })

  it('the read-only Mousse tool list runtimes use matches what the registry lets a read-only child call', () => {
    const { d } = daemon(async () => undefined)
    const registry = d.orch.mcpToolRegistry()
    const callable = registry.list().filter((tool) => !tool.hidden && (tool.access === 'reads' || tool.readOnlySafe)).map((tool) => tool.name)
    expect(new Set(callable)).toEqual(READ_ONLY_MOUSSE_TOOLS)
  })

  describe('an adapter preflight of the user setup (Codex)', () => {
    /** A Codex-shaped adapter whose setup check says what `setup` says. */
    const codexDaemon = (setup: (context: ChildPreflightContext) => SubagentRefusal | null) => {
      const calls: ChildPreflightContext[] = []
      const codex = Object.assign(new ScriptedAdapter('codex', CODEX_CAPABILITIES, async () => 'Looked.'), {
        childPreflight: async (context: ChildPreflightContext) => {
          calls.push(context)
          return setup(context)
        }
      })
      const outcomes: Record<string, Record<string, unknown>> = {}
      home = mkdtempSync(join(tmpdir(), 'mousse-subagent-codex-'))
      previousHome = process.env.MOUSSE_HOME
      process.env.MOUSSE_HOME = home
      const projectDir = join(home, 'project')
      mkdirSync(projectDir)
      const parent = new ScriptedAdapter('pi', PI_LOOP_CAPABILITIES, async (input, host) => {
        if (input.prompt !== 'Delegate it') return 'unexpected pi turn'
        for (const workspace of ['shared', 'isolated'] as const)
          outcomes[workspace] = await delegate(host.tools.delegation!, { workspace, role: workspace === 'shared' ? 'research' : 'implement', instanceId: 'codex' }, workspace)
        return 'Delegated.'
      })
      const d = phase6Daemon(home, [parent, codex])
      stops.push(d.stop)
      const thread = d.store.createThread('Parent', d.projects.openProject(projectDir).id)
      return { d, thread, codex, calls, outcomes, projectDir }
    }

    it('returns the adapter\'s refusal as a value for each workspace, creating no thread', async () => {
      const { d, thread, codex, calls, outcomes, projectDir } = codexDaemon((context) => context.workspace === 'shared'
        ? { code: 'shared_unsupported_for_provider', message: 'use isolated' }
        : { code: 'provider_unsupported_for_subagents', message: 'native subagents are on' })
      await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
      expect(outcomes.shared).toMatchObject({ started: false, code: 'shared_unsupported_for_provider', message: 'use isolated' })
      expect(outcomes.isolated).toMatchObject({ started: false, code: 'provider_unsupported_for_subagents' })
      // The check ran for both, before any child, with the requested workspace and the parent's path.
      expect(calls).toEqual([{ workspace: 'shared', cwd: projectDir }, { workspace: 'isolated', cwd: projectDir }])
      expect(d.engine.delegations.listForParentThread(thread.id)).toEqual([])
      expect(d.store.listAllThreads().map((entry) => entry.id)).toEqual([thread.id])
      expect(codex.turns).toEqual([])
    }, 30_000)

    it("refuses a later turn of a shared child once the user's setup gains an MCP server", async () => {
      let refuse = false
      const { d, thread, codex, outcomes } = codexDaemon(() => refuse
        ? { code: 'shared_unsupported_for_provider', message: 'not possible while your Codex config has MCP servers (ext)' }
        : null)
      await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
      const child = outcomes.shared as unknown as { childThreadId: string; childRunId: string }
      await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'the shared child run')
      const turnsOf = () => codex.turns.filter((turn) => turn.input.threadId === child.childThreadId).length
      expect(turnsOf()).toBe(1)

      await d.orch.send('Look again', false, { threadId: child.childThreadId, clientRequestId: 'ok-again' })
      expect(turnsOf()).toBe(2)

      refuse = true
      await d.orch.send('And again', false, { threadId: child.childThreadId, clientRequestId: 'refused' }).catch(() => undefined)
      expect(turnsOf()).toBe(2)
      expect(d.orch.getMessagesForPersistence(child.childThreadId).map((message) => message.content).join('\n')).toContain('MCP servers (ext)')
    }, 30_000)

    it('starts the child when the adapter finds nothing in the setup', async () => {
      const { d, thread, codex, outcomes } = codexDaemon(() => null)
      await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
      for (const name of ['shared', 'isolated']) await waitFor(() => d.engine.getRun((outcomes[name] as { childRunId: string }).childRunId)?.status === 'completed', 'a child run')
      expect(codex.turns.map((turn) => turn.input.child)).toEqual(expect.arrayContaining([{ readOnly: true }, { readOnly: false }]))
    }, 30_000)
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

  it('a shared child switched to Antigravity is refused on its next turn, and an isolated one is not', async () => {
    const started: Record<string, { childThreadId: string; childRunId: string }> = {}
    const { d, claude, antigravity, thread } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')
    for (const child of Object.values(started))
      d.orch.setThreadModelOverride(child.childThreadId, { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'agent' })

    const shared = await d.orch.send('Look again', false, { threadId: started.shared.childThreadId, clientRequestId: 'again-shared' }).catch((error: Error) => error)
    // Nothing ran on Antigravity (it would have had write access), and the reason is on the thread.
    expect(antigravity.turns.filter((turn) => turn.input.threadId === started.shared.childThreadId)).toEqual([])
    expect(JSON.stringify(shared) + d.orch.getMessagesForPersistence(started.shared.childThreadId).map((message) => message.content).join('\n')).toContain('cannot run a read-only (shared) subagent')
    expect(claude.turns.filter((turn) => turn.input.threadId === started.shared.childThreadId)).toHaveLength(1)

    await d.orch.send('Look again', false, { threadId: started.isolated.childThreadId, clientRequestId: 'again-isolated' })
    expect(antigravity.turns.filter((turn) => turn.input.threadId === started.isolated.childThreadId)).toHaveLength(1)
  }, 30_000)

  it('shared and isolated children both get the delegation tools', async () => {
    const started: Record<string, { childThreadId: string; childRunId: string }> = {}
    const { d, claude, thread } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    })
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')
    const turn = (threadId: string) => claude.turns.find((entry) => entry.input.threadId === threadId)!
    expect(turn(started.shared.childThreadId).delegation).toBeDefined()
    expect(turn(started.isolated.childThreadId).delegation).toBeDefined()
  }, 30_000)

  it('a shared pi child can read and start subagents, but not write, run a shell, write threads or integrate, first turn and resumed', async () => {
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
      expect(turn.delegation).toBeDefined()
      for (const tool of ['write_file', 'edit_file', 'bash', 'integrate_delegation', 'create_task', 'queue_enqueue', 'thread_fork', 'thread_merge_back'])
        expect(turn.toolAccess?.allows(tool), tool).toBe(false)
      for (const tool of ['read_file', 'delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'list_subagents', 'list_delegations']) expect(turn.toolAccess?.allows(tool), tool).toBe(true)
    }
  }, 30_000)

  it('a read-only subagent may start only read-only subagents, through the delegation host and a nested start', async () => {
    let child: { childThreadId: string; childRunId: string } | undefined
    const nested: Record<string, Record<string, unknown>> = {}
    const { d, thread } = daemon(
      async (delegation) => {
        child = await delegate(delegation, { workspace: 'shared', role: 'research', instanceId: 'pi:openai' }, 'pi-child') as never
      },
      async () => 'Looked.',
      async (input, host) => {
        if (input.prompt !== 'Nest') return 'Looked.'
        const delegation = host.tools.delegation!
        nested.shared = await delegate(delegation, { workspace: 'shared', role: 'review', instanceId: 'claude' }, 'nest-shared')
        nested.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement', instanceId: 'claude' }, 'nest-isolated')
        nested.named = await delegation.named.create({ name: 'writer', task: 'edit it', access: 'write' }, { toolCallId: 'nest-named' }) as Record<string, unknown>
        nested.integrate = await delegation.integrateDelegation({ delegationId: 'delegation:any' }, { toolCallId: 'nest-integrate' }).catch((error: { code?: string }) => ({ code: error.code }))
        return 'Nested.'
      }
    )
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    await waitFor(() => d.engine.getRun(child!.childRunId)?.status === 'completed', 'the child run')
    await d.orch.send('Nest', false, { threadId: child!.childThreadId, clientRequestId: 'nest' })
    expect(nested.shared.started).not.toBe(false)
    expect(d.engine.delegations.get(nested.shared.delegationId as string)).toMatchObject({ parentThreadId: child!.childThreadId, workspace: 'shared' })
    for (const key of ['isolated', 'named'])
      expect(nested[key], key).toMatchObject({ started: false, code: 'read_only_caller_requires_shared', message: expect.stringContaining('"shared"') })
    expect(nested.integrate).toEqual({ code: 'mousse_read_only' })
    // Only the read-only grandchild exists.
    expect(d.engine.delegations.listForParentThread(child!.childThreadId)).toHaveLength(1)
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
      const credential = { threadId: input.threadId, runId: input.runId, provider: 'codex', modeCeiling: 'default' as const, binding: 'drained_turn' as const, current: () => true }
      for (const [tool, args] of [
        ['thread_read', {}],
        ['queue_list', {}],
        ['queue_enqueue', { content: 'write more' }],
        ['thread_fork', {}],
        ['thread_merge_back', {}],
        ['delegate_task', { prompt: 'x', title: 'Writer', workspace: 'isolated', role: 'implement', instanceId: 'claude' }],
        ['integrate_delegation', { delegationId: 'delegation:any' }],
        ['create_task', { title: 't' }]
      ] as const) {
        results[name][tool] = await tools.call(tool, { ...args }, { credential, toolCallId: `${name}-${tool}`, signal: new AbortController().signal })
          .then((outcome) => tool === 'delegate_task' ? (JSON.parse(outcome.text).code ?? 'started') : 'allowed', (error: { code?: string }) => error.code ?? 'error')
      }
      // A read-only child may start a read-only subagent through the MCP server.
      const nestedShared = await tools.call('delegate_task', { prompt: 'sub', title: 'Looker', workspace: 'shared', role: 'research', instanceId: 'claude' }, { credential, toolCallId: `${name}-nested`, signal: new AbortController().signal })
      results[name].delegate_shared = JSON.parse(nestedShared.text).code ?? 'started'
      return 'Probed.'
    }
    const { d, thread } = daemon(async (delegation) => {
      started.shared = await delegate(delegation, { workspace: 'shared', role: 'research' }, 'shared') as never
      started.isolated = await delegate(delegation, { workspace: 'isolated', role: 'implement' }, 'isolated') as never
    }, async (input) => probe(input))
    engine = d.engine
    registryReady!(d.orch.mcpToolRegistry())
    await d.orch.send('Delegate it', false, { threadId: thread.id, clientRequestId: 'parent' })
    for (const child of Object.values(started)) await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'a child run')

    expect(results.shared).toEqual({
      thread_read: 'allowed',
      queue_list: 'allowed',
      queue_enqueue: 'mousse_read_only',
      thread_fork: 'mousse_read_only',
      thread_merge_back: 'mousse_read_only',
      // The call reaches delegate_task, which refuses a non-read-only child as a value; a read-only one starts.
      delegate_task: 'read_only_caller_requires_shared',
      delegate_shared: 'started',
      integrate_delegation: 'mousse_read_only',
      create_task: 'mousse_read_only'
    })
    // The same calls are not refused by the policy for an isolated child.
    expect(Object.values(results.isolated)).not.toContain('mousse_read_only')
    expect(results.isolated).toMatchObject({ queue_enqueue: 'allowed', delegate_task: 'started', delegate_shared: 'started' })
  }, 30_000)
})

describe('ToolRegistry read-only gate', () => {
  const tool = (name: string, access: 'reads' | 'actsAsCaller' | 'writesThreads' | 'startsThreads', readOnlySafe = false) => ({
    name, description: name, inputSchema: {}, access, class: 'read' as const, ...(readOnlySafe ? { readOnlySafe } : {}), handler: () => ({ text: 'ok' })
  })
  const turns = new AppToolTurns()
  for (const threadId of ['child', 'parent']) turns.register(appTurn({ threadId, runId: `run-${threadId}` }))
  const registry = new ToolRegistry({ activeRunId: (threadId) => `run-${threadId}`, readOnlyThread: (threadId) => threadId === 'child', turns })
    .register(tool('reads', 'reads'))
    .register(tool('safe', 'actsAsCaller', true))
    .register(tool('acts', 'actsAsCaller'))
    .register(tool('writes', 'writesThreads'))
    .register(tool('starts', 'startsThreads'))
  const call = (name: string, threadId: string) =>
    registry.call(name, {}, {
      credential: { threadId, runId: `run-${threadId}`, provider: 'codex', modeCeiling: 'default', binding: 'drained_turn', current: () => true },
      toolCallId: 'c',
      signal: new AbortController().signal
    })

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
