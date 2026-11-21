/**
 * A delegated subagent thread is marked started on creation and reports `turnState.phase = 'queued'`
 * as soon as its delegation commits (before its `turn.start` effect runs or finishes worktree setup),
 * and settles cleanly if cancelled or failed before starting.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'
import { isThreadStarted } from '../../src/shared/threadTitle'
import type { TurnState } from '../../src/shared/types'

describe('delegated child starting state before turn execution', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  function setup() {
    home = mkdtempSync(join(tmpdir(), 'mousse-delegation-starting-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projects = new ProjectManager()
    const store = new ThreadDataStore(projects)
    const settings = { ...getDefaultSettings(), provider: { ...getDefaultSettings().provider, llmProvider: 'openai', model: 'gpt-replay' } }
    const orch = new OrchestratorService(
      new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(),
      { get: () => settings } as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, projects
    )
    orch.setThreadStore(store)
    orch.setHarness(testHarness({ adapters: [], profileHome: home }))
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })), pid: 4242 })
    orch.setRunEngine(engine)
    engine.reconcileOnBoot()
    cleanups.push(() => {
      engine.shutdown()
      orch.setRunEngine(null)
      engine.store.db.close()
    })
    return { orch, engine, store }
  }

  it('marks the child thread started and queued on commit, and clears back to idle if cancelled before starting', async () => {
    const { orch, engine, store } = setup()
    const parent = store.createThread('Parent work', undefined, undefined, { started: true })
    const parentRun = engine.store.createRun({ threadId: parent.id, source: 'gui' })

    const emitted: TurnState[] = []
    orch.on('turn-state', (state: TurnState) => emitted.push(state))

    // Commit a delegation without starting any EffectWorker — the child's turn.start sits queued.
    const accepted = await engine.requestDelegation({
      parentThreadId: parent.id,
      parentRunId: parentRun.runId,
      clientRequestId: 'req-1',
      prompt: 'Audit the routes',
      title: 'New Chat',
      workspace: 'isolated',
      wake: 'always'
    })

    const child = store.getThread(accepted.childThreadId)
    expect(child).toBeDefined()
    // Even with a default-looking title, `started: true` marks the subagent thread started from birth.
    expect(child!.startedAt).toBeDefined()
    expect(isThreadStarted(child!)).toBe(true)

    expect(orch.getTurnState(accepted.childThreadId)).toMatchObject({
      threadId: accepted.childThreadId,
      turnId: accepted.childRunId,
      phase: 'queued'
    })
    expect(emitted).toContainEqual(expect.objectContaining({
      threadId: accepted.childThreadId,
      turnId: accepted.childRunId,
      phase: 'queued'
    }))

    // Cancelling the queued run before execution clears the turn state back to idle.
    engine.markTerminal(accepted.childRunId, 'cancelled', { interruptedBy: 'user' })
    expect(orch.getTurnState(accepted.childThreadId)).toMatchObject({
      threadId: accepted.childThreadId,
      turnId: null,
      phase: 'idle'
    })
  })

  it('settles a queued child turn state to failed if the run fails before execution starts', async () => {
    const { orch, engine, store } = setup()
    const parent = store.createThread('Parent work', undefined, undefined, { started: true })
    const parentRun = engine.store.createRun({ threadId: parent.id, source: 'gui' })

    const accepted = await engine.requestDelegation({
      parentThreadId: parent.id,
      parentRunId: parentRun.runId,
      clientRequestId: 'req-2',
      prompt: 'Check the build',
      title: 'Build checker',
      workspace: 'isolated',
      wake: 'always'
    })

    expect(orch.getTurnState(accepted.childThreadId).phase).toBe('queued')

    engine.markTerminal(accepted.childRunId, 'failed', { error: 'Worktree unavailable' })
    expect(orch.getTurnState(accepted.childThreadId)).toMatchObject({
      threadId: accepted.childThreadId,
      turnId: accepted.childRunId,
      phase: 'failed',
      error: 'Worktree unavailable'
    })
  })
})
