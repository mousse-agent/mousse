/**
 * A real OrchestratorService over the Run Engine (docs/run-engine/SPEC.md §5, §9, §12). Sends become
 * durable runs, run-targeted stop only touches the active run, queued sends carry their runId
 * through the durable queue, and a duplicate clientRequestId replays without starting a turn.
 * The engine runs with an effect worker and reconciler wired like the profile, so turns,
 * interrupts and steers execute as `turn.*` effects.
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
import { EffectWorker } from '../../src/mms/run/EffectWorker'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { formatRestartNote } from '../../src/mms/run/restartNote'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { EffectKind, EffectRecord, ThreadEvent } from '../../src/mms/run/types'
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

/** Boots an engine with a worker and reconciler the way `MmsProfileServices.start` does. */
function startEngine(
  orch: OrchestratorService,
  home: string
): { engine: RunEngine; worker: EffectWorker; reconciler: Reconciler } {
  const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
  orch.setRunEngine(engine)
  orch.recoverRunEngineOnBoot()
  const worker = new EffectWorker({
    outbox: engine.outbox,
    executors: orch.effectExecutors(),
    owner: engine.leaseOwner
  })
  const reconciler = new Reconciler({ store: engine.store, outbox: engine.outbox, tools: engine.tools })
  worker.start()
  reconciler.start()
  orch.attachEffectWorker(worker)
  return { engine, worker, reconciler }
}

function effectStatuses(engine: RunEngine, threadId: string, kind: EffectKind, runId: string): string[] {
  return engine
    .listEvents(threadId)
    .filter((event) => event.type === 'effect.status')
    .map((event) => event.payload as EffectRecord)
    .filter((effect) => effect.kind === kind && effect.runId === runId)
    .map((effect) => effect.status)
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('OrchestratorService over the Run Engine', () => {
  let home: string
  let projectRepo: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let engine: RunEngine
  let worker: EffectWorker
  let reconciler: Reconciler
  let chatCalls: number
  let releaseFirst: () => void
  const forwarded: ThreadEvent[] = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bridge-'))
    projectRepo = mkdtempSync(join(tmpdir(), 'mousse-bridge-repo-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    orch = createOrchestrator(home, store)
    ;({ engine, worker, reconciler } = startEngine(orch, home))
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

  afterEach(async () => {
    releaseFirst()
    reconciler.stop()
    await worker.stop()
    orch.attachEffectWorker(null)
    orch.setRunEngine(null)
    engine.store.db.close()
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
    // The stop ran as a turn.interrupt effect beside the running turn.start.
    await waitFor(
      () => effectStatuses(engine, thread.id, 'turn.start', first.runId).at(-1) === 'succeeded',
      10_000,
      'first turn.start settled'
    )
    expect(effectStatuses(engine, thread.id, 'turn.interrupt', first.runId)).toEqual([
      'pending',
      'running',
      'succeeded'
    ])

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
    expect(forwarded.map((event) => event.seq).slice(0, seqs.length)).toEqual(seqs)
  }, 30_000)

  it('cancels queued runs whose items are removed, promoted to steer or cleared', async () => {
    const thread = store.createThread('cancel')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo

    const p1 = orch.send('first', false, { threadId: thread.id, clientRequestId: 'c-1' })
    await waitFor(() => chatCalls === 1, 10_000, 'first provider call')
    const [first] = engine.listRuns(thread.id)
    const queued = []
    for (const text of ['second', 'third', 'fourth', 'fifth']) {
      const response = await orch.send(text, false, { threadId: thread.id, clientRequestId: `c-${text}` })
      expect(response.queued).toBe(true)
      expect(response.queueItem?.runId).toBe(response.runId)
      queued.push(response)
    }
    const [second, third, fourth, fifth] = queued

    expect(orch.removeQueuedItem(thread.id, second.queueItem!.id)?.runId).toBe(second.runId)
    expect(engine.getRun(second.runId!)).toMatchObject({
      status: 'cancelled',
      outcome: { interruptedBy: 'user' }
    })

    // A promoted steer joins the active run; its own run is cancelled and the item drops runId.
    expect(orch.promoteQueueItemToSteer(thread.id, third.queueItem!.id)).toBe(true)
    expect(engine.getRun(third.runId!)!.status).toBe('cancelled')
    const steer = orch.getMessageQueue(thread.id).find((item) => item.id === third.queueItem!.id)
    expect(steer).toMatchObject({ intent: 'steer' })
    expect(steer?.runId).toBeUndefined()

    expect(orch.abortActiveTurn(thread.id, { clearQueue: true })).toBe(true)
    await p1
    for (const run of [fourth, fifth]) {
      expect(engine.getRun(run.runId!)).toMatchObject({
        status: 'cancelled',
        outcome: { interruptedBy: 'user' }
      })
    }
    expect(engine.getRun(first.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'user' }
    })
    expect(orch.listQueue(thread.id)).toEqual([])
    expect(engine.listRuns(thread.id).map((run) => run.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'interrupted'
    ])
    expect(chatCalls).toBe(1)
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

  it('runs a send as a turn.start effect that the worker claims and settles', async () => {
    const thread = store.createThread('effect')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    releaseFirst()
    const response = await orch.send('via effect', false, { threadId: thread.id, clientRequestId: 'e-1' })
    expect(response).toMatchObject({ message: 'hello from probe', runId: expect.any(String) })
    const runId = response.runId!
    expect(engine.getRun(runId)!.status).toBe('completed')
    await waitFor(
      () => effectStatuses(engine, thread.id, 'turn.start', runId).at(-1) === 'succeeded',
      10_000,
      'turn.start settled'
    )
    expect(effectStatuses(engine, thread.id, 'turn.start', runId)).toEqual([
      'pending',
      'running',
      'succeeded'
    ])
    const [effect] = engine.outbox.listForRun(runId)
    expect(effect).toMatchObject({
      kind: 'turn.start',
      attempts: 1,
      leaseOwner: engine.leaseOwner,
      payload: { runId, threadId: thread.id, input: 'via effect', admissionHeld: true }
    })
    expect(orch.isActiveTurnRunning(thread.id)).toBe(false)
  }, 30_000)

  it("returns an 'ack' send before the turn finishes and settles the turn later", async () => {
    const thread = store.createThread('ack')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    const ack = await orch.send('ack me', false, {
      threadId: thread.id,
      clientRequestId: 'a-1',
      awaitMode: 'ack'
    })
    expect(ack).toEqual({
      message: '',
      actions: [],
      runId: expect.any(String),
      sequence: expect.any(Number),
      accepted: true
    })
    const runId = ack.runId!
    // The send holds admission: a concurrent send queues instead of racing the effect.
    expect(orch.isActiveTurnRunning(thread.id)).toBe(true)
    const deferred = (orch as any).turnResults.get(runId).promise as Promise<{ message: string }>
    let settled = false
    void deferred.then(() => (settled = true))
    await waitFor(() => chatCalls === 1, 10_000, 'provider call')
    expect(settled).toBe(false)
    expect(engine.getRun(runId)!.status).toBe('running')
    releaseFirst()
    await expect(deferred).resolves.toMatchObject({ message: 'hello from probe' })
    expect(engine.getRun(runId)!.status).toBe('completed')
  }, 30_000)

  it("makes a replayed 'turn' send of a live run wait for the same result", async () => {
    const thread = store.createThread('replay-live')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    const p1 = orch.send('once', false, { threadId: thread.id, clientRequestId: 'live-1' })
    await waitFor(() => chatCalls === 1, 10_000, 'provider call')
    const p2 = orch.send('once', false, { threadId: thread.id, clientRequestId: 'live-1' })
    releaseFirst()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.message).toBe('hello from probe')
    expect(r2).toMatchObject({
      message: r1.message,
      runId: r1.runId,
      sequence: r1.sequence,
      replayed: true
    })
    expect(chatCalls).toBe(1)
    // Once the run is over a replay answers from the receipt alone.
    const later = await orch.send('once', false, { threadId: thread.id, clientRequestId: 'live-1' })
    expect(later).toEqual({
      message: '',
      actions: [],
      runId: r1.runId,
      sequence: r1.sequence,
      replayed: true
    })
  }, 30_000)

  it('turns a steer that reaches a finalizing run after its turn into a queued turn', async () => {
    const thread = store.createThread('late-steer')
    const session = orch.getOrCreateSession(thread.id)
    session.projectCwd = projectRepo
    releaseFirst()
    // A run in `finalizing` whose legacy turn has already let go of the session.
    const sent = await engine.dispatch({
      kind: 'send',
      threadId: thread.id,
      clientRequestId: 'fin-1',
      source: 'gui'
    })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    engine.markRunning(sent.runId)
    engine.markFinalizing(sent.runId)
    // Keep the session busy so the late steer waits on the queue instead of draining at once.
    session.turnAdmitted = true

    const steer = await orch.steerRun(sent.runId, 'late words', 'steer-1', thread.id)
    expect(steer).toMatchObject({ status: 'accepted', runId: sent.runId })
    await waitFor(
      () => effectStatuses(engine, thread.id, 'turn.steer', sent.runId).at(-1) === 'succeeded',
      10_000,
      'turn.steer settled'
    )
    expect(orch.listQueue(thread.id)).toEqual([
      expect.objectContaining({ content: 'late words', source: 'steer-late', intent: 'normal' })
    ])
    expect(orch.getMessages(thread.id).some((message) => message.content === 'late words')).toBe(false)

    engine.markTerminal(sent.runId, 'completed')
    session.turnAdmitted = false
    orch.recoverAndDrainPendingQueues()
    await waitFor(
      () => engine.listRuns(thread.id)[0]?.status === 'completed' && engine.listRuns(thread.id).length === 2,
      10_000,
      'late steer turn'
    )
    expect(engine.listRuns(thread.id)[0]).toMatchObject({ source: 'steer-late' })
    expect(orch.listQueue(thread.id)).toEqual([])
    expect(chatCalls).toBe(1)
  }, 30_000)

  it('shows a restart note once on the next turn after a daemon restart', async () => {
    const thread = store.createThread('restart-note')
    orch.getOrCreateSession(thread.id).projectCwd = projectRepo
    releaseFirst()
    const payload = {
      runIds: ['run:old'],
      uncertainRunIds: ['run:old'],
      cutOffTools: [{ runId: 'run:old', invocationId: 'inv-1', tool: 'bash', idempotent: false }],
      epoch: 1
    }
    engine.store.appendEvent({ threadId: thread.id, type: 'restart.note', payload })
    const note = formatRestartNote(payload)
    const first = await orch.send('after restart', false, { threadId: thread.id, clientRequestId: 'n-1' })
    await orch.send('and again', false, { threadId: thread.id, clientRequestId: 'n-2' })
    const notes = orch.getMessages(thread.id).filter((message) => message.content === note)
    expect(notes).toHaveLength(1)
    expect(notes[0].role).toBe('system')
    const delivered = engine.listEvents(thread.id).filter((event) => event.type === 'restart.note.delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].runId).toBe(first.runId)
    expect(engine.takeRestartNote(thread.id)).toBeNull()
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
