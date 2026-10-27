/**
 * Phase 6 harness (docs/run-engine/SPEC.md §16): a real `OrchestratorService`, Run Engine and effect
 * worker over a temporary profile, with scripted adapters standing in for the providers. Callers set
 * `MOUSSE_HOME` to `home` before building it (threads, projects and worktrees live there).
 */
import type { Message } from '@earendil-works/pi-ai'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type {
  AdapterHost,
  ProviderAdapter,
  ProviderCapabilities,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase, type ProfileDatabaseFault } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { ProviderRef } from '../../src/mms/run/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings, normalizeRunSettings, type RunSettings } from '../../src/shared/settings'

/** Model selections the scripted adapters serve. */
export const PI = { llmProvider: 'openai', model: 'gpt-replay' }
export const CLAUDE = { llmProvider: 'claude-subscription', model: 'sonnet' }

/** What a scripted adapter saw for one turn. */
export interface SeenTurn {
  threadId: string
  prompt: string
  messages: Array<{ role: string; content: unknown }>
  nativeHistory?: string
  cwd: string | null
}

export type Script = (input: TurnInput) => Promise<string> | string

/** A provider stand-in: replies come from `script`; the capability manifest is the real adapter's. */
export class ScriptedAdapter implements ProviderAdapter {
  readonly turns: SeenTurn[] = []
  readonly forkCalls: Array<{ ref: ProviderRef; atTurnOrdinal: number }> = []
  /** Thrown by the next turn instead of replying. */
  failNext: Error | null = null

  constructor(
    readonly driver: ProviderDriverKind,
    readonly capabilities: ProviderCapabilities,
    private readonly script: Script,
    /** A session id to report in the provider ref (native-fork tests). */
    private readonly sessionId?: string
  ) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push({
      threadId: input.threadId,
      prompt: input.prompt,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      nativeHistory: input.nativeHistory,
      cwd: input.cwd
    })
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }
    sink.providerRef(providerRef)
    if (this.failNext) {
      const failure = this.failNext
      this.failNext = null
      throw failure
    }
    const text = await this.script(input)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const native = this.capabilities.historyInjection === 'native'
    if (!native) host.context.nativeHistoryAfterTurn(text)
    const reply = {
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: input.llmProvider,
      model: input.model, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } as Message
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: native ? [...input.messages, reply] : [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }

  async forkSession(ref: ProviderRef, atTurnOrdinal: number): Promise<ProviderRef | null> {
    this.forkCalls.push({ ref, atTurnOrdinal })
    return null
  }
}

/** A pi-shaped adapter (`historyInjection: 'native'`). */
export const piAdapter = (script: Script, caps: Partial<ProviderCapabilities> = {}, sessionId?: string): ScriptedAdapter =>
  new ScriptedAdapter('pi', { ...PI_LOOP_CAPABILITIES, ...caps }, script, sessionId)

/** A Claude-subscription-shaped adapter (`historyInjection: 'prompt'`, weak containment). */
export const claudeAdapter = (script: Script): ScriptedAdapter =>
  new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, script)

export async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * A bare `OrchestratorService` over `store` with inert collaborators (no run engine, no providers):
 * tests replace `llm` and drive the queue, admission and event paths. Points `MOUSSE_HOME` at `home`.
 * The default model is a pi instance (`PI`), so turns run on the pi loop over the replaced `llm`:
 * a profile with no model has no turn to run (`no_model_selected`).
 */
export function createOrchestrator(home: string, store: ThreadDataStore): OrchestratorService {
  process.env.MOUSSE_HOME = home
  const settings = () => ({ ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, ...PI } })
  const settingsStore = { getSettings: settings, get: settings }
  const providerAuth = { getConnectedProviders: () => [] }
  const orch = new OrchestratorService(
    new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
    settingsStore as never, providerAuth as never
  )
  orch.setThreadStore(store)
  return orch
}

/** One daemon over `home`: orchestrator, engine and effect worker with the given adapters. */
export function phase6Daemon(home: string, adapters: ProviderAdapter[], options: { pid?: number; instances?: ProviderInstanceService; drivers?: HarnessDriver[]; runs?: Partial<RunSettings>; fault?: ProfileDatabaseFault } = {}) {
  const projects = new ProjectManager()
  const store = new ThreadDataStore(projects)
  // The returned `settings` is the daemon's live settings object: a test may change it while the daemon runs.
  const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, ...PI }, runs: normalizeRunSettings(options.runs) }
  // Each daemon has its own questions, as each process has: waiting callbacks never outlive a daemon.
  const questions = new UserQuestionService()
  const orch = new OrchestratorService(
    new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
    { get: () => settings } as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, projects,
    { questions }
  )
  orch.setThreadStore(store)
  ;(orch as any).llm = {
    getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'scripted' }),
    getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'scripted' }),
    generateTitle: async () => 'Scripted',
    chat: async () => { throw new Error('the scripted adapter replaces the pi loop') }
  }
  orch.setHarness(testHarness({ adapters, ...(options.drivers ? { drivers: options.drivers } : {}), ...(options.instances ? { instances: options.instances } : {}), profileHome: home }))
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home, ...(options.fault ? { fault: options.fault } : {}) })), pid: options.pid ?? 1 })
  orch.setRunEngine(engine)
  const boot = engine.reconcileOnBoot()
  const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
  worker.start()
  orch.attachEffectWorker(worker)
  let stopped = false
  const halt = async (clean: boolean): Promise<void> => {
    if (stopped) return
    stopped = true
    await worker.stop()
    orch.attachEffectWorker(null)
    if (clean) engine.shutdown()
    orch.setRunEngine(null)
    engine.store.db.close()
  }
  /**
   * Ends like a profile stop (`MmsProfileServices.stopRunEngine`): the worker stops, the
   * orchestrator drains its live turns, then the epoch closes cleanly.
   */
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    // As the profile does: saved approvals are held before the worker's stop aborts the turns.
    orch.holdApprovals()
    const workerStopped = worker.stop()
    await orch.shutdown()
    await workerStopped
    orch.attachEffectWorker(null)
    engine.shutdown()
    orch.setRunEngine(null)
    engine.store.db.close()
  }
  return {
    orch, engine, store, projects, boot, worker, questions, settings,
    /** Ends like a crash: the daemon epoch stays open. */
    crash: () => halt(false),
    stop: () => halt(true),
    shutdown
  }

}

export type Phase6Daemon = ReturnType<typeof phase6Daemon>
