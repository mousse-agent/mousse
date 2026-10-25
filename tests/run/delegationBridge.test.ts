/**
 * Phase 4 bridge (docs/run-engine/SPEC.md §14): a real `OrchestratorService`, Run Engine, effect
 * worker and reconciler with a fake pi adapter. The parent turn calls `delegate_task`; the child
 * runs on its own thread; its completion is an inbox row; rule 4 wakes the parent, whose wake turn
 * reads the result with `task_status`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { MacroEngine } from '../../src/mms/macros/MacroEngine'
import type { DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { subagentPreamble } from '../../src/mms/run/delegation/guidance'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

type Script = (input: TurnInput, delegation: DelegationToolHost | undefined) => Promise<string>

/** A pi-shaped adapter whose replies come from a per-turn script with the turn's delegation host. */
class ScriptedPiAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_LOOP_CAPABILITIES
  readonly turns: TurnInput[] = []
  constructor(private readonly script: Script) {}

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host.tools.delegation)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never],
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

/** One daemon: orchestrator, engine, worker and reconciler over `home`. */
function daemon(home: string, script: Script, pid: number) {
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
  const adapter = new ScriptedPiAdapter(script)
  orch.setHarness(testHarness({ adapters: [adapter], profileHome: home }))
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid })
  orch.setRunEngine(engine)
  const boot = engine.reconcileOnBoot()
  const worker = new EffectWorker({ outbox: engine.outbox, executors: orch.effectExecutors(), owner: engine.leaseOwner })
  worker.start()
  orch.attachEffectWorker(worker)
  const reconciler = new Reconciler({ store: engine.store, outbox: engine.outbox, tools: engine.tools, capabilitiesFor: (id) => orch.capabilitiesForThread(id) })
  return {
    orch, engine, store, adapter, boot, reconciler,
    /** Stops like a crash: the worker stops, the epoch is never ended. */
    crash: async () => {
      await worker.stop()
      orch.attachEffectWorker(null)
      orch.setRunEngine(null)
      engine.store.db.close()
    },
    stop: async () => {
      await worker.stop()
      orch.attachEffectWorker(null)
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
    }
  }
}

describe('delegation bridge (SPEC §14)', () => {
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

  const setupHome = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-delegation-bridge-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    return home
  }

  /** Parent delegates on its first turn, the child answers, the parent's wake turn reads the result. */
  const script = (state: { delegationId?: string; status?: unknown; parentThreadId?: string }): Script => async (input, delegation) => {
    if (input.threadId === state.parentThreadId) {
      if (input.prompt === 'Count the modules') {
        const started = await delegation!.delegateTask({ prompt: 'List the modules', workspace: 'shared', role: 'research' }, { toolCallId: 'call-1' }) as { delegationId: string }
        state.delegationId = started.delegationId
        return 'Delegated the count.'
      }
      if (input.prompt.startsWith('Subagent')) {
        state.status = await delegation!.taskStatus({ delegationId: state.delegationId! })
        return 'The child found three modules.'
      }
      return 'unexpected parent turn'
    }
    return 'Three modules: run, agents, orchestrator.'
  }

  it('a restart between child completion and the wake still wakes the parent after boot', async () => {
    const dir = setupHome()
    const state: { delegationId?: string; status?: unknown; parentThreadId?: string } = {}
    const first = daemon(dir, script(state), 1)
    const parent = first.store.createThread('Parent')
    state.parentThreadId = parent.id
    const response = await first.orch.send('Count the modules', false, { threadId: parent.id, clientRequestId: 'parent-send' })
    const delegation = first.engine.delegations.get(state.delegationId!)!
    const childThreadId = delegation.childThreadId
    expect(childThreadId).not.toBe(parent.id)
    expect(first.store.getThread(childThreadId)?.name).toBe('Delegated: List the modules')
    expect(first.engine.delegations.getLineage(childThreadId)).toMatchObject({ parentThreadId: parent.id, relationship: 'subagent', parentRunId: response.runId })
    // The child's turn runs as its own run on its own thread and publishes to the parent's inbox.
    await waitFor(() => first.engine.getRun(delegation.childRunId)?.status === 'completed', 'the child run')
    // The subagent is told whose it is and where its result goes, then its task.
    expect(first.adapter.turns.find((turn) => turn.threadId === childThreadId)?.prompt)
      .toBe(`${subagentPreamble('Parent')}\n\nList the modules`)
    expect(first.engine.inbox.listPending(parent.id)).toHaveLength(1)
    await first.crash()

    const second = daemon(dir, script(state), 2)
    stops.push(second.stop)
    expect(second.engine.inbox.listPending(parent.id)).toHaveLength(1)
    const wakeRunId = second.reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => second.engine.getRun(wakeRunId)?.status === 'completed', 'the wake run after boot')
    expect(state.status).toMatchObject({ status: 'acknowledged' })
    expect(second.engine.delegations.get(delegation.delegationId)!.status).toBe('acknowledged')
    expect(second.engine.inbox.listForThread(parent.id).map((row) => row.status)).toEqual(['acknowledged'])
  }, 30_000)

  it('rejects a shared workspace for a role that writes', async () => {
    const dir = setupHome()
    let rejection = ''
    let parentId = ''
    const d = daemon(dir, async (input, delegation) => {
      if (input.threadId !== parentId) return 'child'
      try {
        await delegation!.delegateTask({ prompt: 'Edit files', workspace: 'shared', role: 'implement' }, { toolCallId: 'c' })
      } catch (error) {
        rejection = (error as Error).message
      }
      return 'done'
    }, 1)
    stops.push(d.stop)
    parentId = d.store.createThread('Parent').id
    await d.orch.send('go', false, { threadId: parentId })
    expect(rejection).toMatch(/read-only roles/)
    expect(d.engine.delegations.listForParentThread(parentId)).toEqual([])
  }, 30_000)
})
