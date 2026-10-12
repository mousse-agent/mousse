/**
 * Phase 1 bridge (docs/run-engine/SPEC.md §5, §9): a real OrchestratorService dual-writes every
 * turn into the Run Engine. Sends become durable runs, run-targeted stop only touches the
 * active run, queued sends carry their runId through the durable queue, and a duplicate
 * clientRequestId replays without starting a turn.
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
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { ThreadEvent } from '../../src/mms/run/types'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'

function createOrchestrator(home: string, store: ThreadDataStore): OrchestratorService {
  process.env.MOUSSE_HOME = home
  const orch = new OrchestratorService(
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
  return orch
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('Run Engine legacy bridge', () => {
  let home: string
  let projectRepo: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let db: ProfileDatabase
  let engine: RunEngine
  let chatCalls: number
  let releaseFirst: () => void
  const forwarded: ThreadEvent[] = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bridge-'))
    projectRepo = mkdtempSync(join(tmpdir(), 'mousse-bridge-repo-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
    db = new ProfileDatabase({ profileHome: home })
    engine = new RunEngine({ store: new RunStore(db) })
    orch.setRunEngine(engine)
    forwarded.length = 0
    orch.on('run-event', (event: ThreadEvent) => forwarded.push(event))
    chatCalls = 0
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    ;(orch as any).llm = {
      getSelectedModelContextLimit: () => ({ limit: 128_000, modelName: 'probe' }),
      getContextInputs: async () => ({
        systemPromptText: '',
        mcpToolsText: '',
        otherToolsText: '',
        signature: 'probe-sig'
      }),
      generateTitle: async () => 'Probe Title',
      chat: async (_messages: unknown, _onTool: unknown, opts: any) => {
        chatCalls += 1
        if (chatCalls === 1) {
          // Hold the first turn inside the provider call until released or aborted.
          await new Promise<void>((resolve) => {
            const signal: AbortSignal | undefined = opts?.signal
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
            void firstGate.then(resolve)
          })
        }
        const aborted = Boolean(opts?.signal?.aborted)
        return {
          text: aborted ? '' : 'hello from probe',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          modelName: 'probe',
          totalResponseTimeMs: 1,
          totalTokensUsed: 2,
          tokensPerSecond: undefined,
          contextInputs: { signature: 'probe-sig' },
          toolEvents: [],
          aborted,
          nativeMessages: []
        }
      }
    }
  })

  afterEach(() => {
    releaseFirst()
    orch.setRunEngine(null)
    db.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(projectRepo, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('tracks a stopped turn and a queued follow-up as runs', async () => {
    const thread = store.createThread('bridge')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo

    const p1 = orch.send('first', false, { threadId: thread.id, clientRequestId: 'send-1' })
    await waitFor(() => chatCalls === 1, 10_000, 'first provider call')
    const [first] = engine.listRuns(thread.id)
    expect(first).toMatchObject({ ordinal: 1, status: 'running', clientRequestId: 'send-1' })
    expect(orch.getTurnState(thread.id).turnId).toBe(first.runId)

    // A send during the turn is a queued run whose id rides on the durable queue item.
    const r2 = await orch.send('second', false, { threadId: thread.id, clientRequestId: 'send-2' })
    expect(r2.queued).toBe(true)
    expect(r2.runId).toBe('run:thread:' + encodeURIComponent(thread.id) + ':ordinal:2')
    expect(r2.queueItem?.runId).toBe(r2.runId)
    expect(engine.getRun(r2.runId!)!.status).toBe('queued')
    expect(orch.listQueue(thread.id).map((item) => item.runId)).toEqual([r2.runId])

    // Same clientRequestId: replayed, nothing new queued or started.
    const dup = await orch.send('second', false, { threadId: thread.id, clientRequestId: 'send-2' })
    expect(dup).toMatchObject({ replayed: true, runId: r2.runId })
    expect(orch.listQueue(thread.id)).toHaveLength(1)
    expect(engine.listRuns(thread.id)).toHaveLength(2)

    // Stop aimed at a run that is not active is ignored; the turn keeps running.
    const wrong = await orch.abortRun(r2.runId!, 'stop-wrong', thread.id)
    expect(wrong).toMatchObject({ status: 'ignored', reason: 'run_not_active', activeRunId: first.runId })
    const bogus = await orch.abortRun('run:thread:nope:ordinal:1', 'stop-bogus', thread.id)
    expect(bogus.status).toBe('ignored')
    expect(orch.isActiveTurnRunning(thread.id)).toBe(true)
    expect(engine.getRun(first.runId)!.status).toBe('running')

    const stop = await orch.abortRun(first.runId, 'stop-1')
    expect(stop).toMatchObject({ status: 'accepted', runId: first.runId })
    const r1 = await p1
    expect(r1.runId).toBe(first.runId)
    expect(engine.getRun(first.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'user', stopRequested: true }
    })

    // Stop keeps queued work; draining it runs the queued run under its own id.
    orch.recoverAndDrainPendingQueues()
    await waitFor(() => engine.getRun(r2.runId!)?.status === 'completed', 10_000, 'second run')
    expect(chatCalls).toBe(2)
    expect(engine.listRuns(thread.id).map((run) => [run.ordinal, run.status])).toEqual([
      [2, 'completed'],
      [1, 'interrupted']
    ])
    const second = engine.getRun(r2.runId!)!
    expect(engine.store.getAttempt(second.activeAttemptId!)!.status).toBe('completed')

    // Stop for a finished run is ignored (SPEC §9).
    const late = await orch.abortRun(first.runId, 'stop-late')
    expect(late).toMatchObject({ status: 'ignored', reason: 'run_not_active' })

    const events = engine.listEvents(thread.id)
    const seqs = events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    const statuses = (runId: string) =>
      events
        .filter((event) => event.type === 'run.status' && event.runId === runId)
        .map((event) => (event.payload as { status: string }).status)
    expect(statuses(first.runId)).toEqual(['starting', 'running', 'running', 'interrupted'])
    expect(statuses(r2.runId!)).toEqual(['starting', 'running', 'finalizing', 'completed'])
    expect(forwarded.map((event) => event.seq)).toEqual(seqs)
  }, 30_000)

  it('replays a duplicate send without starting another turn', async () => {
    const thread = store.createThread('replay')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    releaseFirst()
    const r1 = await orch.send('only once', false, { threadId: thread.id, clientRequestId: 'same' })
    expect(r1.message).toBe('hello from probe')
    expect(r1.replayed).toBeUndefined()
    expect(engine.getRun(r1.runId!)!.status).toBe('completed')
    const again = await orch.send('only once', false, { threadId: thread.id, clientRequestId: 'same' })
    expect(again).toEqual({
      message: '',
      actions: [],
      runId: r1.runId,
      sequence: r1.sequence,
      replayed: true
    })
    expect(chatCalls).toBe(1)
    expect(engine.listRuns(thread.id)).toHaveLength(1)
    // Another thread may not reuse the id.
    const other = store.createThread('other')
    await expect(
      orch.send('x', false, { threadId: other.id, clientRequestId: 'same' })
    ).rejects.toThrow('client_request_id_conflict')
  }, 30_000)

  it('gives a pre-upgrade queue item a run when it drains', async () => {
    const thread = store.createThread('legacy-queue')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    releaseFirst()
    const item = orch.enqueueForThread(thread.id, 'from an old queue')
    expect(item.runId).toBeUndefined()
    orch.recoverAndDrainPendingQueues()
    await waitFor(() => engine.listRuns(thread.id)[0]?.status === 'completed', 10_000, 'legacy run')
    expect(engine.listRuns(thread.id)[0]).toMatchObject({
      clientRequestId: `queue:${item.id}`,
      source: 'queue'
    })
  }, 30_000)

  it('interrupts runs left active by a previous daemon', async () => {
    const thread = store.createThread('boot')
    const sent = await engine.dispatch({
      kind: 'send',
      threadId: thread.id,
      clientRequestId: 'boot-1',
      source: 'gui'
    })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    engine.markRunning(sent.runId)
    const signals: unknown[] = []
    orch.on('run-interrupted-on-boot', (payload) => signals.push(payload))
    expect(orch.recoverRunEngineOnBoot()).toEqual([sent.runId])
    expect(signals).toEqual([{ threadId: thread.id, runId: sent.runId }])
    expect(engine.getRun(sent.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'daemon_restart' }
    })
  })
})
