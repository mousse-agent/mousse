/**
 * `delegate_task` picks the child's agent by provider instance (SPEC §13.8, §14.2): a real
 * `OrchestratorService`, Run Engine and effect worker with a scripted pi parent and a scripted
 * Claude-driver child. An older `provider` name routes the same way; an unknown or disabled
 * instance fails the tool call before any child thread exists.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { MacroEngine } from '../../src/mms/macros/MacroEngine'
import type { DelegateTaskInput, DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { AdapterRegistry } from '../../src/mms/run/adapters/AdapterRegistry'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { getDefaultSettings } from '../../src/shared/settings'

type Script = (input: TurnInput, delegation: DelegationToolHost | undefined) => Promise<string>

class ScriptedAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host.tools.delegation)
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

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('delegate_task by provider instance', () => {
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

  /** One daemon whose pi parent sends `request` through `delegate_task` on its first turn. */
  const daemon = (request: Omit<DelegateTaskInput, 'prompt' | 'workspace'>, stored?: Record<string, unknown>) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-delegation-instances-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const outcome: { started?: { delegationId: string }; error?: { code?: string; message: string } } = {}
    const projects = new ProjectManager()
    const store = new ThreadDataStore(projects)
    const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, llmProvider: 'openai', model: 'gpt-replay' } }
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine, { get: () => settings } as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, undefined, projects
    )
    orch.setThreadStore(store)
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'scripted' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'scripted' }),
      generateTitle: async () => 'Scripted',
      chat: async () => { throw new Error('the scripted adapter replaces the pi loop') }
    }
    const parent = new ScriptedAdapter('pi', PI_LOOP_CAPABILITIES, async (input, delegation) => {
      if (input.prompt !== 'Review the module') return 'unexpected pi turn'
      try {
        outcome.started = await delegation!.delegateTask({ prompt: 'Review it', workspace: 'shared', role: 'review', ...request }, { toolCallId: 'call-1' }) as { delegationId: string }
        return 'Delegated.'
      } catch (error) {
        outcome.error = { code: (error as { code?: string }).code, message: (error as Error).message }
        return 'Delegation failed.'
      }
    })
    const claude = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async () => 'Reviewed by Claude.')
    const instances = new ProviderInstanceService({ store: { read: () => stored, write: (next) => { stored = next } } })
    orch.setAdapterRegistry(new AdapterRegistry(instances).register(parent).register(claude))
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: 1 })
    orch.setRunEngine(engine)
    engine.reconcileOnBoot()
    const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
    stops.push(async () => {
      await worker.stop()
      orch.attachEffectWorker(null)
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
    })
    return { orch, engine, store, parent, claude, outcome }
  }

  const routesToClaude = async (request: Omit<DelegateTaskInput, 'prompt' | 'workspace'>) => {
    const d = daemon(request)
    const thread = d.store.createThread('Parent')
    expect((await d.orch.send('Review the module', false, { threadId: thread.id, clientRequestId: 'parent-send' })).message).toBe('Delegated.')
    // The parent ran on the default selection, mapped to its pi instance.
    expect(d.parent.turns[0]).toMatchObject({ instanceId: 'pi:openai', llmProvider: 'openai' })
    const delegation = d.engine.delegations.get(d.outcome.started!.delegationId)!
    expect(delegation.provider).toBe('claude')
    expect(d.store.getThread(delegation.childThreadId)?.modelOverride).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await waitFor(() => d.engine.getRun(delegation.childRunId)?.status === 'completed', 'the child run')
    expect(d.claude.turns).toHaveLength(1)
    expect(d.claude.turns[0]).toMatchObject({ threadId: delegation.childThreadId, instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet', prompt: 'Review it' })
    expect(d.parent.turns.some((turn) => turn.threadId === delegation.childThreadId)).toBe(false)
  }

  it('runs the child on the requested instance', async () => {
    await routesToClaude({ instanceId: 'claude', model: 'sonnet' })
  }, 30_000)

  it('maps an older provider name to the same instance', async () => {
    await routesToClaude({ provider: 'claude-subscription', model: 'sonnet' })
  }, 30_000)

  it.each([
    [{ instanceId: 'nope' }, 'provider_instance_unknown'],
    [{ provider: 'nope' }, 'provider_instance_unknown'],
    [{ instanceId: 'claude' }, 'provider_instance_disabled']
  ] as const)('rejects %o before creating a child thread', async (request, code) => {
    // The `claude` instance is disabled in this profile; unknown ids fail regardless.
    const d = daemon(request, { claude: { driver: 'claude', enabled: false } })
    const thread = d.store.createThread('Parent')
    expect((await d.orch.send('Review the module', false, { threadId: thread.id, clientRequestId: 'parent-send' })).message).toBe('Delegation failed.')
    expect(d.outcome.error?.code).toBe(code)
    expect(d.outcome.error?.message).toMatch(/"(nope|claude)"/)
    expect(d.engine.delegations.listForParentThread(thread.id)).toEqual([])
    expect(d.store.listAllThreads().map((entry) => entry.id)).toEqual([thread.id])
    expect(d.claude.turns).toEqual([])
  }, 30_000)
})
