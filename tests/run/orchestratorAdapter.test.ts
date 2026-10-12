/**
 * Phase 3a (docs/run-engine/SPEC.md §13.5): `executeTurn` runs pi-ai turns through the adapter
 * registry. A fake adapter stands in for the pi loop and drives the sink like a provider would.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { MacroEngine } from '../../src/mms/macros/MacroEngine'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { AdapterRegistry } from '../../src/mms/run/adapters/AdapterRegistry'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type {
  AdapterHost,
  ProviderAdapter,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

class FakePiAdapter implements ProviderAdapter {
  readonly id = 'pi'
  readonly capabilities = PI_LOOP_CAPABILITIES
  readonly turns: Array<{ input: TurnInput; host: AdapterHost }> = []

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push({ input, host })
    const providerRef = { provider: input.llmProvider, model: input.model, sessionId: 'fake-session' }
    sink.providerRef(providerRef)
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: 'hello from', contentIndex: 0 })
    ctl.heartbeat()
    sink.text({ phase: 'complete', content: 'hello from the adapter', contentIndex: 0 })
    return {
      text: 'hello from the adapter',
      aborted: false,
      modelName: 'Fake Model',
      totalResponseTimeMs: 3,
      totalTokensUsed: 4,
      usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'fake-sig',
      nativeMessages: input.messages,
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('adapter-based turn.start', () => {
  let home: string
  let engine: RunEngine
  let worker: EffectWorker
  let orch: OrchestratorService
  let store: ThreadDataStore
  let adapter: FakePiAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-adapter-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(),
      new TaskQueue(),
      new WorktreeManager(home),
      new PtyManager(),
      new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine,
      { get: () => getDefaultSettings() } as never,
      {} as never
    )
    orch.setThreadStore(store)
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
      getContextInputs: async () => ({ systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 's' }),
      generateTitle: async () => 'Title',
      chat: async () => {
        throw new Error('the pi branch must go through the adapter')
      }
    }
    adapter = new FakePiAdapter()
    orch.setAdapterRegistry(new AdapterRegistry().register(adapter))
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    orch.recoverRunEngineOnBoot()
    worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
  })

  afterEach(async () => {
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('runs the turn through the registered adapter and records its provider ref', async () => {
    const thread = store.createThread('adapter')
    const response = await orch.send('hi', false, { threadId: thread.id, clientRequestId: 'send-1' })
    expect(response.message).toBe('hello from the adapter')

    const [run] = engine.listRuns(thread.id)
    expect(run.status).toBe('completed')
    expect(adapter.turns).toHaveLength(1)
    const { input, host } = adapter.turns[0]
    expect(input).toMatchObject({
      runId: run.runId,
      attemptId: run.activeAttemptId,
      threadId: thread.id,
      mode: 'agent',
      modelPinned: false
    })
    expect(input.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' })
    expect(typeof host.context.recoverOverflow).toBe('function')
    expect(host.tools.toolLedger).toBeDefined()

    const attempt = engine.store.getAttempt(run.activeAttemptId!)
    expect(attempt?.providerRef).toEqual({
      provider: input.llmProvider,
      model: input.model,
      sessionId: 'fake-session'
    })
    const assistant = orch.getMessages(thread.id).filter((message) => message.role === 'assistant')
    expect(assistant.at(-1)).toMatchObject({ content: 'hello from the adapter', streaming: false })
  })
})
