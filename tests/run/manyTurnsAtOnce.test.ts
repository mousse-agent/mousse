/**
 * A profile runs as many turns at once as are sent: no turn waits for another thread's turn to end. Real
 * orchestrator, run engine and effect worker in one process; only the provider is scripted, and each of its
 * turns waits for the test to release it (or for its Stop).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'
import { PI_TEST_CAPABILITIES } from '../support/piStub'

/** A provider whose turns wait for `release` (one gate per thread) or for their Stop. */
class GateAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  readonly started: string[] = []
  private readonly gates = new Map<string, () => void>()

  release(threadId: string): void {
    this.gates.get(threadId)?.()
  }

  async startTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    const providerRef = { provider: input.llmProvider, model: input.model, sessionId: `s-${input.threadId}` }
    sink.providerRef(providerRef)
    this.started.push(input.threadId)
    await new Promise<void>((resolve) => {
      this.gates.set(input.threadId, resolve)
      input.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const aborted = input.signal.aborted
    if (!aborted) sink.text({ phase: 'complete', content: 'done', contentIndex: 0 })
    return {
      text: aborted ? '' : 'done', aborted, modelName: 'Fake Model', totalResponseTimeMs: 1, totalTokensUsed: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'sig', nativeMessages: input.messages, providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('turns on many threads', () => {
  let home: string
  let engine: RunEngine
  let worker: EffectWorker
  let orch: OrchestratorService
  let store: ThreadDataStore
  let adapter: GateAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-many-turns-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(
      new AgentRegistry(),
      new TaskQueue(),
      new WorktreeManager(home),
      new PtyManager(),
      { get: () => ({ ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, llmProvider: 'openai', model: 'gpt-x' } }) } as never,
      {} as never
    )
    orch.setThreadStore(store)
    adapter = new GateAdapter()
    orch.setHarness(testHarness({ adapters: [adapter], profileHome: home }))
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    orch.recoverRunEngineOnBoot()
    worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
    worker.start()
    orch.attachEffectWorker(worker)
  })

  afterEach(async () => {
    for (const threadId of adapter.started) adapter.release(threadId)
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const until = async (check: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    if (!check()) throw new Error(`timed out waiting for ${what}`)
  }

  it("starts twelve threads' turns at once, people's and background work's alike, and a Stop reaches one of them", async () => {
    // A person's messages (window, CLI, phone) and background work (an agent's tool, a schedule, a bot) side by side.
    const sources = ['gui', 'mcp', 'cli', 'schedule', 'remote', 'bot', 'gui', 'mcp', 'cli', 'schedule', 'remote', 'gui']
    const threads = sources.map((source, i) => ({ thread: store.createThread(`t${i + 1}`), source }))
    const sends = threads.map(({ thread, source }, i) =>
      orch.send(`message ${i + 1}`, false, { threadId: thread.id, clientRequestId: `send-${i + 1}`, source }))
    await until(() => adapter.started.length === threads.length, 'every turn to start')
    expect([...adapter.started].sort()).toEqual(threads.map(({ thread }) => thread.id).sort())
    for (const { thread } of threads) expect(orch.getTurnState(thread.id).phase).not.toBe('queued')

    // A Stop of one live turn ends it while the eleven others run on.
    const stopped = threads[5]!.thread.id
    await orch.stopThread(stopped, 'user')
    await until(() => engine.listRuns(stopped).every((run) => run.status !== 'running' && run.status !== 'queued'), 'the stopped run to end')
    expect(engine.listRuns(stopped).map((run) => [run.status, run.outcome?.interruptedBy])).toEqual([['interrupted', 'user']])
    for (const { thread } of threads.filter(({ thread }) => thread.id !== stopped))
      expect(engine.listRuns(thread.id).map((run) => run.status)).toEqual(['running'])

    for (const { thread } of threads) adapter.release(thread.id)
    await Promise.all(sends.map((send) => send.catch(() => undefined)))
    for (const { thread } of threads.filter(({ thread }) => thread.id !== stopped))
      expect(engine.listRuns(thread.id).map((run) => run.status)).toEqual(['completed'])
  })
})
