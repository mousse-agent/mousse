/**
 * Execution bindings (provider abstraction plan §1): each attempt runs on one immutable binding
 * resolved when its turn starts and persisted with the attempt. Config and account changes apply to
 * later attempts only; a native session from another account or home is never resumed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import type { Harness } from '../../src/mms/harness/gateway'
import { getDefaultSettings } from '../../src/shared/settings'

/** A Claude-like runtime whose turns wait for `release()`; records forgotten sessions. */
class GatedClaude implements ProviderAdapter {
  constructor(readonly driver: 'claude' | 'codex' = 'claude') {}
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly turns: TurnInput[] = []
  private gates: Array<() => void> = []
  gated = false

  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1], _ctl: unknown, host: Parameters<ProviderAdapter['startTurn']>[3]): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    if (this.gated) await new Promise<void>((resolve) => this.gates.push(resolve))
    host.context.nativeHistoryAfterTurn('ok')
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }

  release(): void {
    for (const gate of this.gates.splice(0)) gate()
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('execution bindings', () => {
  let home: string
  let engine: RunEngine
  let worker: EffectWorker
  let orch: OrchestratorService
  let store: ThreadDataStore
  let adapter: GatedClaude
  let harness: Harness
  let forgotten: string[]
  let codexForgotten: string[]
  let codex: GatedClaude
  /** The models the codex runtime lists, first = what `default` runs. */
  let codexListing: string[]
  /** The account the instances report; `undefined` = signed in, identity unknown. */
  let subject: string | undefined
  let authChecks: number
  let clock: number
  /** Moves the clock on between two turns. */
  const later = () => { clock += 1_000 }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-binding-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
      { get: () => getDefaultSettings() } as never, {} as never
    )
    orch.setThreadStore(store)
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'm' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 's' }),
      generateTitle: async () => 'Title',
      chat: async () => { throw new Error('unused') }
    }
    adapter = new GatedClaude()
    codex = new GatedClaude('codex')
    forgotten = []
    codexForgotten = []
    codexListing = []
    subject = 'account-a'
    authChecks = 0
    clock = Date.now()
    let stored: unknown = { claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const auth = async () => {
      authChecks += 1
      return { state: 'signed_in' as const, ...(subject ? { subject } : {}) }
    }
    const claude = adapterDriver(adapter, { runtime: { auth, forgetConversation: (threadId) => forgotten.push(threadId), signOut: async () => {}, setLaunch: async () => {} } })
    const codexDriver = adapterDriver(codex, {
      runtime: {
        auth,
        forgetConversation: (threadId) => codexForgotten.push(threadId),
        // As a managed Codex: `default` runs the first listed model, fixed at bind.
        concreteModel: (model) => (model === 'default' ? codexListing[0] : model)
      }
    })
    harness = testHarness({
      drivers: [{ ...claude, decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }) }, codexDriver],
      instances,
      profileHome: home,
      now: () => clock
    })
    orch.setHarness(harness)
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    orch.recoverRunEngineOnBoot()
    worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
  })

  afterEach(async () => {
    adapter.release()
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    harness.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const bindingOf = (runId: string) => engine.bindingForRun(runId)

  it('records one binding per attempt and reads it back after a restart', async () => {
    const thread = store.createThread('bound')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('hi', false, { threadId: thread.id, clientRequestId: 'send-1' })
    const [run] = engine.listRuns(thread.id)
    expect(bindingOf(run.runId)).toEqual({
      instanceId: 'claude', driver: 'claude', accountGeneration: 0, homeId: 'default', configRevision: 0, model: 'sonnet',
      accountId: expect.stringMatching(/^[0-9a-f]{32}$/),
      policy: { mode: 'default', approvals: 'ask', origin: 'interactive' },
      // The caps the attempt runs on, frozen with the binding.
      caps: expect.objectContaining({ steer: 'interrupt_restart', toolControl: 'approval_only' }),
      factsRevision: 0
    })
    // The account is a salted hash, never the vendor's id.
    expect(JSON.stringify(bindingOf(run.runId))).not.toContain('account-a')
    // A binding is immutable: a second write keeps the first.
    const attemptId = engine.getRun(run.runId)!.activeAttemptId!
    engine.store.setAttemptBinding(attemptId, { ...bindingOf(run.runId)!, model: 'opus' })
    expect(bindingOf(run.runId)?.model).toBe('sonnet')

    // Restart: a new store over the same database reads the binding.
    const reopened = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    try {
      expect(reopened.bindingForRun(run.runId)?.instanceId).toBe('claude')
      expect(reopened.store.getAttempt(attemptId)?.executionBinding?.model).toBe('sonnet')
    } finally {
      reopened.store.db.close()
    }
  })

  it('a message for a hidden model or a turned-off provider is refused before it is a run or a transcript entry', async () => {
    const thread = store.createThread('refused')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'haiku:low' })
    await harness.instances.setModelPrefs('claude', { hide: ['haiku'] })
    await expect(orch.send('hi', false, { threadId: thread.id, clientRequestId: 'send-hidden' })).rejects.toMatchObject({ code: 'model_hidden' })
    await harness.instances.setEnabled('claude', { kind: 'device' }, false)
    await expect(orch.send('hi', false, { threadId: thread.id, clientRequestId: 'send-off' })).rejects.toMatchObject({ code: 'provider_instance_disabled' })
    expect(engine.listRuns(thread.id)).toEqual([])
    expect(orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user')).toEqual([])
    expect(adapter.turns).toEqual([])
  })

  it('a retried send that was accepted returns its run even after its model is hidden', async () => {
    const thread = store.createThread('replay hidden')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    const first = await orch.send('one', false, { threadId: thread.id, clientRequestId: 'replay-hidden' })
    await harness.instances.setModelPrefs('claude', { hide: ['sonnet'] })
    await expect(orch.send('one', false, { threadId: thread.id, clientRequestId: 'replay-hidden' })).resolves.toMatchObject({ runId: first.runId, replayed: true })
    // A new message is still refused.
    await expect(orch.send('two', false, { threadId: thread.id, clientRequestId: 'new-hidden' })).rejects.toMatchObject({ code: 'model_hidden' })
    expect(engine.listRuns(thread.id)).toHaveLength(1)
  })

  it('a retried send that was accepted returns its run even after its provider is turned off', async () => {
    const thread = store.createThread('replay off')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    const first = await orch.send('one', false, { threadId: thread.id, clientRequestId: 'replay-off' })
    await harness.instances.setEnabled('claude', { kind: 'device' }, false)
    await expect(orch.send('one', false, { threadId: thread.id, clientRequestId: 'replay-off' })).resolves.toMatchObject({ runId: first.runId, replayed: true })
    await expect(orch.send('two', false, { threadId: thread.id, clientRequestId: 'new-off' })).rejects.toMatchObject({ code: 'provider_instance_disabled' })
    expect(engine.listRuns(thread.id)).toHaveLength(1)
  })

  it('a config change during an active turn applies to the next attempt only', async () => {
    const thread = store.createThread('config change')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    adapter.gated = true
    const first = orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    await waitFor(() => adapter.turns.length === 1)
    await harness.instances.configure('claude', { env: { FOO: '1' } })
    const [active] = engine.listRuns(thread.id)
    expect(bindingOf(active.runId)?.configRevision).toBe(0)
    adapter.gated = false
    adapter.release()
    await first
    expect(bindingOf(active.runId)?.configRevision).toBe(0)

    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    const latest = engine.listRuns(thread.id)[0]
    expect(latest.runId).not.toBe(active.runId)
    expect(bindingOf(latest.runId)?.configRevision).toBe(1)
  })

  it('a native session from another account is not resumed: the next turn drops it and hands history over', async () => {
    const thread = store.createThread('account change')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(forgotten).toEqual([])
    // Signing out moves the account generation on.
    await harness.instances.signOut('claude')
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    const [latest, previous] = engine.listRuns(thread.id)
    expect(bindingOf(previous.runId)?.accountGeneration).toBe(0)
    expect(bindingOf(latest.runId)?.accountGeneration).toBe(1)
    expect(forgotten).toEqual([thread.id])
    // The same account again: nothing is dropped.
    later()
    await orch.send('three', false, { threadId: thread.id, clientRequestId: 'send-c' })
    expect(forgotten).toEqual([thread.id])
  })

  it('an account switched in a terminal between two turns is noticed at the next turn, with no Settings visit', async () => {
    const thread = store.createThread('terminal switch')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    expect(forgotten).toEqual([])
    const checks = authChecks
    // `claude auth logout` / `claude auth login` as someone else; no probe, no snapshots request.
    subject = 'account-b'
    later()
    await orch.send('three', false, { threadId: thread.id, clientRequestId: 'send-c' })
    expect(authChecks).toBeGreaterThan(checks)
    const [latest, previous] = engine.listRuns(thread.id)
    expect(bindingOf(latest.runId)?.accountGeneration).toBe(bindingOf(previous.runId)!.accountGeneration + 1)
    expect(bindingOf(latest.runId)?.accountId).not.toBe(bindingOf(previous.runId)?.accountId)
    expect(forgotten).toEqual([thread.id])
  })

  it('an account switched one second after a turn is read again: one check per turn, shared by its bind and start', async () => {
    const thread = store.createThread('quick switch')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    let checks = authChecks
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(authChecks - checks).toBe(1)
    subject = 'account-b'
    later()
    checks = authChecks
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    expect(authChecks - checks).toBe(1)
    const [latest, previous] = engine.listRuns(thread.id)
    expect(bindingOf(latest.runId)?.accountId).not.toBe(bindingOf(previous.runId)?.accountId)
    expect(bindingOf(latest.runId)?.accountGeneration).toBe(bindingOf(previous.runId)!.accountGeneration + 1)
    expect(forgotten).toEqual([thread.id])
  })

  it('a recovery of a binding made with a known account hands history over when the account cannot be read now', async () => {
    const thread = store.createThread('unknown recovery')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    const [first] = engine.listRuns(thread.id)
    const stored = bindingOf(first.runId)!
    expect(stored.accountId).toBeDefined()
    // The next run recovers on a binding recorded with the known account; the account read now fails.
    const markStarting = engine.markStarting.bind(engine)
    engine.markStarting = (runId) => {
      const run = markStarting(runId)
      engine.store.setAttemptBinding(run.activeAttemptId!, stored)
      engine.store.createAttempt({ runId, reason: 'recovery' })
      return engine.getRun(runId)!
    }
    subject = undefined
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    expect(adapter.turns).toHaveLength(2)
    expect(forgotten).toEqual([thread.id])
  })

  it('an account the instance cannot identify never resumes a native session', async () => {
    const thread = store.createThread('unknown identity')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    subject = undefined
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    const [latest] = engine.listRuns(thread.id)
    expect(bindingOf(latest.runId)?.accountId).toBeUndefined()
    expect(forgotten).toEqual([thread.id])
  })

  it('a config change between completed turns hands the history over instead of resuming', async () => {
    const thread = store.createThread('config revision')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    await harness.instances.configure('claude', { args: ['--verbose'] })
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    expect(forgotten).toEqual([thread.id])
    // Renaming is not a config change.
    await harness.instances.configure('claude', { displayName: 'Mine' })
    later()
    await orch.send('three', false, { threadId: thread.id, clientRequestId: 'send-c' })
    expect(forgotten).toEqual([thread.id])
  })

  it('resume compares against the last run on the same instance, not the last run of the thread', async () => {
    const thread = store.createThread('claude codex claude')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    orch.setThreadModelOverride(thread.id, { instanceId: 'codex', llmProvider: 'codex', model: 'gpt' })
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    subject = 'account-b'
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    later()
    await orch.send('three', false, { threadId: thread.id, clientRequestId: 'send-c' })
    expect(adapter.turns.map((turn) => turn.model)).toEqual(['sonnet', 'sonnet'])
    expect(forgotten).toEqual([thread.id])
  })

  it('a replacement attempt runs its run binding (runtime and input) and records it, not the current selection', async () => {
    const thread = store.createThread('retry')
    orch.setThreadModelOverride(thread.id, { instanceId: 'codex', llmProvider: 'codex', model: 'mutable-model' })
    const bound = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'bound-model' }, { purpose: 'turn' }), { mode: 'agent' })
    let retryAttempt: string | undefined
    const markStarting = engine.markStarting.bind(engine)
    engine.markStarting = (runId) => {
      const run = markStarting(runId)
      // The first attempt ran on `bound`; a retry replaces it.
      engine.store.setAttemptBinding(run.activeAttemptId!, bound)
      retryAttempt = engine.store.createAttempt({ runId, reason: 'retry' }).attemptId
      return engine.getRun(runId)!
    }
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(codex.turns).toEqual([])
    expect(adapter.turns).toHaveLength(1)
    expect(adapter.turns[0]).toMatchObject({ instanceId: 'claude', model: 'bound-model', mode: 'agent' })
    expect(engine.store.getAttempt(retryAttempt!)?.executionBinding).toEqual(bound)
    expect(bound.policy).toEqual({ mode: 'default', approvals: 'ask', origin: 'interactive' })
  })

  it('a turn on a runtime that resolves `default` runs and records the bound model, and recovery keeps it', async () => {
    const thread = store.createThread('bound default')
    orch.setThreadModelOverride(thread.id, { instanceId: 'codex', llmProvider: 'codex', model: 'default' })
    codexListing = ['gpt-a', 'gpt-b']
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    const [first] = engine.listRuns(thread.id)
    const stored = bindingOf(first.runId)!
    // The dispatched input and the persisted binding carry the same concrete model.
    expect(stored.model).toBe('gpt-a')
    expect(codex.turns.map((turn) => turn.model)).toEqual(['gpt-a'])
    // The catalog reorders; a recovery of that binding still runs the bound model.
    codexListing = ['gpt-b', 'gpt-a']
    const markStarting = engine.markStarting.bind(engine)
    engine.markStarting = (runId) => {
      const run = markStarting(runId)
      engine.store.setAttemptBinding(run.activeAttemptId!, stored)
      engine.store.createAttempt({ runId, reason: 'recovery' })
      return engine.getRun(runId)!
    }
    later()
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    expect(codex.turns.map((turn) => turn.model)).toEqual(['gpt-a', 'gpt-a'])
  })

  it('a turn on `default` with no listed model fails before it runs', async () => {
    const thread = store.createThread('no models')
    orch.setThreadModelOverride(thread.id, { instanceId: 'codex', llmProvider: 'codex', model: 'default' })
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(codex.turns).toEqual([])
    expect(engine.listRuns(thread.id).map((run) => [run.status, run.outcome?.error])).toEqual([['failed', expect.stringMatching(/model_unavailable.*Refresh models/)]])
  })

  it('a plan-mode binding is never run with an agent-mode input', async () => {
    const thread = store.createThread('plan retry')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    const bound = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' }), { mode: 'plan' })
    expect(bound.policy).toEqual({ mode: 'plan', approvals: 'ask', origin: 'interactive' })
    const markStarting = engine.markStarting.bind(engine)
    engine.markStarting = (runId) => {
      const run = markStarting(runId)
      engine.store.setAttemptBinding(run.activeAttemptId!, bound)
      engine.store.createAttempt({ runId, reason: 'retry' })
      return engine.getRun(runId)!
    }
    // The replayed request is in agent mode; the runtime would take bypass permissions from it.
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(adapter.turns).toEqual([])
    const [run] = engine.listRuns(thread.id)
    expect(run.status).toBe('failed')
    expect(run.outcome?.error).toMatch(/default mode but its binding is plan mode/)
  })

  it('a plan-mode send records a plan policy and runs the input in plan mode', async () => {
    const thread = store.createThread('plan')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    await orch.send({ content: 'one', mode: 'plan' }, false, { threadId: thread.id, clientRequestId: 'send-a' })
    const [run] = engine.listRuns(thread.id)
    expect(bindingOf(run.runId)?.policy).toEqual({ mode: 'plan', approvals: 'ask', origin: 'interactive' })
    expect(adapter.turns.map((turn) => turn.mode)).toEqual(['plan'])
  })

  it('a recovery attempt whose binding no longer matches the instance config fails typed instead of running', async () => {
    const thread = store.createThread('stale')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    const bound = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' }), { mode: 'agent' })
    await harness.instances.configure('claude', { env: { CHANGED: '1' } })
    const markStarting = engine.markStarting.bind(engine)
    engine.markStarting = (runId) => {
      const run = markStarting(runId)
      engine.store.setAttemptBinding(run.activeAttemptId!, bound)
      engine.store.createAttempt({ runId, reason: 'recovery' })
      return engine.getRun(runId)!
    }
    await orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    expect(adapter.turns).toEqual([])
    const [run] = engine.listRuns(thread.id)
    expect(run.status).toBe('failed')
    expect(run.outcome?.error).toMatch(/settings of this provider changed/)
  })

  it('the context gauge of a fresh profile with no model selected is empty, not an error', async () => {
    ;(orch as any).llm.getContextInputs = async () => { throw new Error('Unknown model "" for provider ""') }
    await expect(orch.getContextUsage('')).resolves.toMatchObject({ percent: 0, used: 0, limit: 0, categories: [] })
  })

  it('Stop reaches the instance named by the binding', async () => {
    const thread = store.createThread('stop')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    adapter.gated = true
    const send = orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    await waitFor(() => adapter.turns.length === 1)
    const interrupted: string[] = []
    adapter.interrupt = async (ref) => {
      interrupted.push(String(ref.instanceId))
      adapter.release()
      return 'interrupted'
    }
    const [run] = engine.listRuns(thread.id)
    await orch.abortRun(run.runId, 'stop-1', thread.id)
    await send
    await waitFor(() => interrupted.length > 0)
    expect(interrupted).toEqual(['claude'])
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
