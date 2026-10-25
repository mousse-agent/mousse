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
import type { MacroEngine } from '../../src/mms/macros/MacroEngine'
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
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import type { Harness } from '../../src/mms/harness/gateway'
import { getDefaultSettings } from '../../src/shared/settings'

/** A Claude-like runtime whose turns wait for `release()`; records forgotten sessions. */
class GatedClaude implements ProviderAdapter {
  readonly driver = 'claude' as const
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-binding-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine, { get: () => getDefaultSettings() } as never, {} as never
    )
    orch.setThreadStore(store)
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'm' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 's' }),
      generateTitle: async () => 'Title',
      chat: async () => { throw new Error('unused') }
    }
    adapter = new GatedClaude()
    forgotten = []
    let stored: unknown = { claude: { driver: 'claude', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const claude = adapterDriver(adapter, { runtime: { forgetConversation: (threadId) => forgotten.push(threadId), signOut: async () => {} } })
    harness = testHarness({ drivers: [{ ...claude, decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }) }], instances, profileHome: home })
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
      policy: { mode: 'default', approvals: 'ask' }
    })
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

  it('a config change during an active turn applies to the next attempt only', async () => {
    const thread = store.createThread('config change')
    orch.setThreadModelOverride(thread.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    adapter.gated = true
    const first = orch.send('one', false, { threadId: thread.id, clientRequestId: 'send-a' })
    await waitFor(() => adapter.turns.length === 1)
    await harness.instances.configure('claude', { displayName: 'Renamed' })
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
    await orch.send('two', false, { threadId: thread.id, clientRequestId: 'send-b' })
    const [latest, previous] = engine.listRuns(thread.id)
    expect(bindingOf(previous.runId)?.accountGeneration).toBe(0)
    expect(bindingOf(latest.runId)?.accountGeneration).toBe(1)
    expect(forgotten).toEqual([thread.id])
    // The same account again: nothing is dropped.
    await orch.send('three', false, { threadId: thread.id, clientRequestId: 'send-c' })
    expect(forgotten).toEqual([thread.id])
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
