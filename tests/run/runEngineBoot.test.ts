import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { RunRecord, ThreadEvent } from '../../src/mms/run/types'

const NO_APPROVALS = { continued: [], cancelled: [], undelivered: [] }

describe('RunEngine boot (SPEC §12.5)', () => {
  let profileHome: string | undefined
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  /** A daemon: a fresh connection and engine that has booted. */
  const daemon = (pid: number) => {
    profileHome ??= mkdtempSync(join(tmpdir(), 'mousse-boot-'))
    let tick = Date.UTC(2026, 9, 12) + pid * 1_000_000
    const db = new ProfileDatabase({ profileHome, clock: () => (tick += 1000) })
    dbs.push(db)
    const store = new RunStore(db)
    // Reserved kinds stand in for replay-safe work here (SPEC §12.2: no producer yet).
    const engine = new RunEngine({ store, pid, outbox: new EffectOutbox(store, { allowReservedKinds: true }) })
    const events: ThreadEvent[] = []
    engine.on('event', (event: ThreadEvent) => events.push(event))
    const boot = engine.reconcileOnBoot()
    return { store, engine, events, boot }
  }

  const running = async (engine: RunEngine, threadId: string, key: string): Promise<RunRecord> => {
    const sent = await engine.dispatch({ kind: 'send', threadId, clientRequestId: key, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    return engine.markRunning(sent.runId)
  }

  const startTool = (engine: RunEngine, run: RunRecord, invocationId: string, tool: string) =>
    engine.tools.start({
      invocationId,
      runId: run.runId,
      attemptId: run.activeAttemptId!,
      tool,
      argsDigest: 'd',
      now: '2026-10-12T00:00:00.000Z'
    })

  it('opens epoch 1 on a fresh profile and exposes the lease owner', () => {
    const { engine, boot } = daemon(10)
    expect(boot).toEqual({ interrupted: [], uncertain: [], epoch: 1, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    expect(engine.epoch).toBe(1)
    expect(engine.leaseOwner).toBe('1:10')
  })

  it('interrupts active runs after a clean shutdown even with a non-idempotent tool started', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    startTool(first.engine, run, 'call-1', 'bash')
    first.engine.shutdown()

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [run.runId], uncertain: [], epoch: 2, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    expect(second.store.getRun(run.runId)).toMatchObject({
      status: 'interrupted',
      outcome: { interruptedBy: 'daemon_restart' }
    })
  })

  it('marks a crashed run with a non-idempotent tool in flight uncertain and lists the tool', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    startTool(first.engine, run, 'call-1', 'read_file')
    startTool(first.engine, run, 'call-2', 'bash')
    startTool(first.engine, run, 'call-3', 'mcp__fs__write')
    // No shutdown(): the daemon crashed.

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [], uncertain: [run.runId], epoch: 2, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    const after = second.store.getRun(run.runId)!
    expect(after.status).toBe('uncertain')
    expect(after.outcome).toEqual({
      uncertainReason: 'non_idempotent_tool_in_flight',
      error: 'Non-idempotent tools were in flight when the daemon stopped: bash, mcp__fs__write.'
    })
    expect(second.store.getAttempt(after.activeAttemptId!)!.status).toBe('interrupted')
    expect(second.events.map((event) => event.type)).toEqual([
      'run.status',
      'attempt.status',
      'restart.note'
    ])
  })

  it('interrupts a crashed run whose started tools are all idempotent', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    startTool(first.engine, run, 'call-1', 'read_file')
    const committed = startTool(first.engine, run, 'call-2', 'bash')
    first.engine.tools.commit(committed.invocationId, '2026-10-12T00:00:01.000Z')
    // A run that was still starting when the daemon crashed is interrupted too.
    const starting = await first.engine.dispatch({ kind: 'send', threadId: 'u', clientRequestId: 'req-2', source: 'gui' })
    if (starting.status !== 'accepted') throw new Error('send rejected')
    first.engine.markStarting(starting.runId)

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [run.runId, starting.runId], uncertain: [], epoch: 2, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    expect(second.store.getRun(run.runId)!.outcome).toEqual({ interruptedBy: 'daemon_restart' })
    expect(second.store.getAttempt(second.store.getRun(run.runId)!.activeAttemptId!)!.status).toBe('interrupted')
    expect(second.store.getRun(starting.runId)!.status).toBe('interrupted')
  })

  it('records one restart.note per affected thread and handles effects', async () => {
    const first = daemon(10)
    const a = await running(first.engine, 't1', 'req-a')
    const b = await running(first.engine, 't2', 'req-b')
    const queued = await first.engine.dispatch({ kind: 'send', threadId: 't3', clientRequestId: 'req-c', source: 'gui' })
    startTool(first.engine, a, 'call-a', 'write_file')
    startTool(first.engine, b, 'call-b', 'list_dir')
    const { outbox } = first.engine
    const turn = outbox.enqueue({ threadId: 't1', runId: a.runId, kind: 'turn.start' })
    const title = outbox.enqueue({ threadId: 't1', kind: 'title.generate' })
    const cleanup = outbox.enqueue({ threadId: 't3', kind: 'workspace.cleanup' })
    const later = '2026-10-13T00:00:00.000Z'
    for (let i = 0; i < 3; i++) outbox.claimNext(first.engine.leaseOwner, later)
    expect(outbox.listRunning()).toHaveLength(3)

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [b.runId], uncertain: [a.runId], epoch: 2, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    expect(second.engine.outbox.get(turn.effectId)).toMatchObject({ status: 'cancelled', lastError: 'daemon_restart' })
    expect(second.engine.outbox.get(title.effectId)).toMatchObject({ status: 'pending', leaseOwner: null })
    expect(second.engine.outbox.get(cleanup.effectId)).toMatchObject({ status: 'pending' })
    if (queued.status !== 'accepted') throw new Error('send rejected')
    expect(second.store.getRun(queued.runId)!.status).toBe('queued')

    const notes = (threadId: string) =>
      second.store.listEvents(threadId).filter((event) => event.type === 'restart.note')
    expect(notes('t1').map((event) => event.payload)).toEqual([
      {
        epoch: 2,
        runIds: [a.runId],
        uncertainRunIds: [a.runId],
        cutOffTools: [{ runId: a.runId, invocationId: 'call-a', tool: 'write_file', idempotent: false }]
      }
    ])
    expect(notes('t2').map((event) => event.payload)).toEqual([
      {
        epoch: 2,
        runIds: [b.runId],
        uncertainRunIds: [],
        cutOffTools: [{ runId: b.runId, invocationId: 'call-b', tool: 'list_dir', idempotent: true }]
      }
    ])
    expect(notes('t3')).toEqual([])
    // Boot events reach listeners for every thread it touched, effect-only threads included.
    expect(new Set(second.events.map((event) => event.threadId))).toEqual(new Set(['t1', 't2', 't3']))
  })

  it('lists a queued run whose turn.start died in the restart note (queuedRunIds)', async () => {
    const first = daemon(10)
    const sent = await first.engine.dispatch({ kind: 'send', threadId: 't', clientRequestId: 'req-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    const send = { runId: sent.runId, threadId: 't', input: 'hello' }
    first.engine.outbox.enqueue({ threadId: 't', runId: sent.runId, kind: 'turn.start', payload: send })
    // A run that never had a turn.start (it waits on the message queue) is not stranded.
    await first.engine.dispatch({ kind: 'send', threadId: 'u', clientRequestId: 'req-2', source: 'queue' })
    // Crash.

    const second = daemon(20)
    expect(second.boot.strandedQueued).toEqual([sent.runId])
    expect(second.store.getRun(sent.runId)!.status).toBe('queued')
    const notes = second.store.listEvents('t').filter((event) => event.type === 'restart.note')
    expect(notes.map((event) => event.payload)).toEqual([
      { epoch: 2, runIds: [], uncertainRunIds: [], cutOffTools: [], queuedRunIds: [sent.runId] }
    ])
    expect(second.store.listEvents('u').filter((event) => event.type === 'restart.note')).toEqual([])
  })

  it('cancels a queued integration run whose turn.start died, and leaves queued runs of other sources alone', async () => {
    const first = daemon(10)
    const integration = await first.engine.dispatch({ kind: 'send', threadId: 'p', clientRequestId: 'req-int', source: 'integration' })
    const gui = await first.engine.dispatch({ kind: 'send', threadId: 'p2', clientRequestId: 'req-gui', source: 'gui' })
    if (integration.status !== 'accepted' || gui.status !== 'accepted') throw new Error('send rejected')
    first.engine.outbox.enqueue({ threadId: 'p', runId: integration.runId, kind: 'turn.start', payload: { runId: integration.runId, threadId: 'p', input: 'integrate' } })
    // Crash.

    const second = daemon(20)
    expect(second.store.getRun(integration.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'daemon_restart' } })
    expect(second.store.getRun(gui.runId)!.status).toBe('queued')
    // Not a delegated child: the parent may request the integration again, so nothing is published as a failure.
    expect(second.boot.orphanedChildren).toEqual([])
  })

  it('notes a turn the previous daemon interrupted while shutting down, once', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    // The turn executor recorded the shutdown abort before the epoch closed.
    first.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    // A user's Stop is not a restart.
    const stopped = await running(first.engine, 's', 'req-s')
    first.engine.markTerminal(stopped.runId, 'interrupted', { interruptedBy: 'user' })
    first.engine.shutdown()

    const second = daemon(20)
    expect(second.boot.interrupted).toEqual([])
    const notes = (store: RunStore, threadId: string) =>
      store.listEvents(threadId).filter((event) => event.type === 'restart.note').map((event) => event.payload)
    expect(notes(second.store, 't')).toEqual([{ epoch: 2, runIds: [run.runId], uncertainRunIds: [], cutOffTools: [] }])
    expect(notes(second.store, 's')).toEqual([])
  })

  it('does not note again a run the previous boot interrupted and noted', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    // Crash: the second boot interrupts the run by daemon_restart (inside its own epoch) and notes it.
    const second = daemon(20)
    expect(second.boot.interrupted).toEqual([run.runId])
    second.engine.shutdown()

    const third = daemon(30)
    expect(third.store.listEvents('t').filter((event) => event.type === 'restart.note')).toHaveLength(1)
  })

  it('does not note a shutdown-interrupted turn the thread has moved past', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    first.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    const later = await running(first.engine, 't', 'req-2')
    first.engine.markTerminal(later.runId, 'completed')
    first.engine.shutdown()

    const second = daemon(20)
    expect(second.store.listEvents('t').filter((event) => event.type === 'restart.note')).toEqual([])
  })

  it('leaves a paused run and its pending run.resume alone, and re-queues a running one (usage-limit pause)', async () => {
    const pause = { reason: 'usage_limit', until: '2026-10-12T00:30:00.000Z', estimated: false, count: 1, autoResume: true } as const
    const first = daemon(10)
    const waiting = await running(first.engine, 't', 'req-1')
    first.engine.pauseRun({ runId: waiting.runId, pause, resumeAt: pause.until })
    const due = await running(first.engine, 'u', 'req-2')
    first.engine.pauseRun({ runId: due.runId, pause: { ...pause, until: '2026-10-12T00:00:00.000Z' }, resumeAt: '2026-10-12T00:00:00.000Z' })
    // The second timer is due and an executor holds it when the daemon crashes; the first is still waiting.
    const claimed = first.engine.outbox.claimNext(first.engine.leaseOwner, '2026-10-12T00:10:00.000Z')
    expect(claimed).toMatchObject({ kind: 'run.resume', runId: due.runId, status: 'running' })
    const waitingTimer = first.engine.outbox.listForRun(waiting.runId).find((effect) => effect.kind === 'run.resume')!
    // No shutdown(): the daemon crashed.

    const second = daemon(20)

    expect(second.boot).toEqual({ interrupted: [], uncertain: [], epoch: 2, orphanedChildren: [], recoveredWakes: [], strandedQueued: [], approvals: NO_APPROVALS })
    for (const run of [waiting, due]) {
      expect(second.store.getRun(run.runId)).toMatchObject({ status: 'paused', epoch: second.store.getRun(run.runId)!.epoch })
      expect(second.store.getAttempt(second.store.getRun(run.runId)!.activeAttemptId!)!.status).toBe('interrupted')
      expect(second.store.getPausedRun(run.threadId)!.runId).toBe(run.runId)
      expect(second.store.getActiveRun(run.threadId)).toBeNull()
      expect(second.store.listEvents(run.threadId).filter((event) => event.type === 'restart.note')).toEqual([])
    }
    expect(second.engine.outbox.get(waitingTimer.effectId)).toMatchObject({ status: 'pending', availableAt: pause.until })
    expect(second.engine.outbox.get(claimed!.effectId)).toMatchObject({ status: 'pending', leaseOwner: null })

    // A clean shutdown of the next daemon leaves them paused as well.
    second.engine.shutdown()
    const third = daemon(30)
    expect(third.boot.interrupted).toEqual([])
    expect(third.store.getPausedRun('t')!.runId).toBe(waiting.runId)
    expect(third.engine.outbox.get(waitingTimer.effectId)!.status).toBe('pending')
  })

  it('touches the run heartbeat without bumping the epoch or writing an event', async () => {

    const { engine, store } = daemon(10)
    const run = await running(engine, 't', 'req-1')
    const seq = store.maxSeq('t')
    expect(engine.heartbeat(run.runId)).toBe(true)
    const after = store.getRun(run.runId)!
    expect(after.heartbeatAt).not.toBeNull()
    expect(after.epoch).toBe(run.epoch)
    expect(store.maxSeq('t')).toBe(seq)
    engine.markTerminal(run.runId, 'uncertain', { uncertainReason: 'test' })
    expect(engine.heartbeat(run.runId)).toBe(false)
    expect(engine.heartbeatDaemon()).toBe(true)
  })

  it('revokes every live Mousse MCP credential: the tokens died with the previous daemon (M8)', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't1', 'req-mcp')
    const credentials = new McpCredentials(first.store)
    const minted = credentials.bearerForTurn({ threadId: 't1', runId: run.runId, instanceId: 'claude', modeCeiling: 'default', binding: 'per_call', generation: 'g' })
    expect(credentials.listForThread('t1')).toMatchObject([{ revokedAt: null }])
    first.engine.shutdown()
    const second = daemon(20)
    const after = new McpCredentials(second.store)
    expect(after.listForThread('t1')).toHaveLength(1)
    expect(after.listForThread('t1')[0].revokedAt).not.toBeNull()
    expect(after.resolve(minted.token)).toBeNull()
  })

  describe('saved approval requests (SPEC §17.6)', () => {
    const ask = (engine: RunEngine, requestId: string, threadId: string, runId: string | null) =>
      engine.approvals.create({
        requestId,
        threadId,
        runId,
        instanceId: 'claude',
        provider: 'claude',
        action: 'command',
        permissionKey: 'claude:command',
        fingerprint: `fp-${requestId}`,
        questions: [{
          id: 'permission',
          prompt: 'Allow Claude Code to run a command (Bash)?\nls',
          options: [
            { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
            { id: 'reject', label: 'Reject', decision: 'reject' }
          ]
        }]
      })

    it('a crash turns pending requests into continue requests; an uncertain run records the tools that may have run', async () => {
      const first = daemon(10)
      const cut = await running(first.engine, 't-uncertain', 'req-1')
      startTool(first.engine, cut, 'call-1', 'bash')
      const calm = await running(first.engine, 't-calm', 'req-2')
      ask(first.engine, 'r-uncertain', 't-uncertain', cut.runId)
      ask(first.engine, 'r-calm', 't-calm', calm.runId)
      // No shutdown(): the daemon crashed.

      const second = daemon(20)
      expect(second.boot.approvals).toEqual({ continued: ['r-uncertain', 'r-calm'], cancelled: [], undelivered: [] })
      expect(second.engine.approvals.get('r-uncertain')).toMatchObject({ status: 'pending', answerPath: 'continue', uncertain: true, uncertainTools: ['bash'] })
      expect(second.engine.approvals.get('r-calm')).toMatchObject({ status: 'pending', answerPath: 'continue', uncertain: false, uncertainTools: null })
      // Nothing was answered or granted by the restart.
      expect(second.engine.approvals.listPending().map((row) => row.decision)).toEqual([null, null])
      const notes = (threadId: string) => second.store.listEvents(threadId).filter((event) => event.type === 'restart.note').map((event) => event.payload as { approvalRequestIds?: string[] })
      expect(notes('t-uncertain')[0]!.approvalRequestIds).toEqual(['r-uncertain'])
      expect(notes('t-calm')[0]!.approvalRequestIds).toEqual(['r-calm'])
    })

    it('a clean shutdown leaves them pending too: the next boot offers them as continue requests', async () => {
      const first = daemon(10)
      const run = await running(first.engine, 't', 'req-1')
      ask(first.engine, 'r-1', 't', run.runId)
      // The turn ends by the shutdown, as the orchestrator records it.
      first.engine.markTerminal(run.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      expect(first.engine.approvals.get('r-1')!.status).toBe('pending')
      first.engine.shutdown()

      const second = daemon(20)
      expect(second.boot.approvals.continued).toEqual(['r-1'])
      expect(second.engine.approvals.get('r-1')).toMatchObject({ status: 'pending', answerPath: 'continue' })
    })

    it('an answer committed but never delivered is reported and becomes a continue request', async () => {
      const first = daemon(10)
      const run = await running(first.engine, 't', 'req-1')
      ask(first.engine, 'r-1', 't', run.runId)
      // Settled with its delivery effect (the executor never ran), then the daemon crashed.
      const settled = first.engine.approvals.settle('r-1', { permission: 'allow' }, { kind: 'user', via: 'gui' }, { enqueueDelivery: true })
      expect(settled).toMatchObject({ ok: true, decision: 'allow' })
      expect(first.engine.outbox.listForThread('t').map((effect) => effect.kind)).toEqual(['request.respond'])

      const second = daemon(20)
      expect(second.boot.approvals).toEqual({ continued: [], cancelled: [], undelivered: ['r-1'] })
      // The delivery effect died with the process; the answer was not lost.
      expect(second.engine.outbox.listForThread('t').find((effect) => effect.kind === 'request.respond')).toMatchObject({ status: 'cancelled', lastError: 'daemon_restart' })
      expect(second.engine.approvals.get('r-1')).toMatchObject({ status: 'answered', decision: 'allow', answerPath: 'continue', deliveredAt: null })
      expect(second.engine.approvals.listUndelivered().map((row) => row.requestId)).toEqual(['r-1'])
    })

    it('a request with no run that can continue is closed', async () => {
      const first = daemon(10)
      ask(first.engine, 'r-no-run', 't', null)
      const finished = await running(first.engine, 'u', 'req-1')
      first.engine.markTerminal(finished.runId, 'completed')
      // A request written for a run that already ended is closed with it, never left behind.
      ask(first.engine, 'r-late', 'u', finished.runId)

      const second = daemon(20)
      expect(second.boot.approvals).toEqual({ continued: [], cancelled: ['r-no-run', 'r-late'], undelivered: [] })
      expect(second.engine.approvals.get('r-no-run')).toMatchObject({ status: 'cancelled', cancelReason: 'turn_ended' })
      expect(second.engine.approvals.get('r-late')).toMatchObject({ status: 'cancelled', cancelReason: 'turn_ended' })
    })

    it('a run that ends while the daemon lives closes its requests in the terminal transaction', async () => {
      const { engine, store } = daemon(10)
      const done = await running(engine, 't1', 'req-1')
      const failed = await running(engine, 't2', 'req-2')
      const cut = await running(engine, 't3', 'req-3')
      const unsure = await running(engine, 't4', 'req-4')
      for (const [id, run] of [['r-done', done], ['r-failed', failed], ['r-cut', cut], ['r-unsure', unsure]] as const) ask(engine, id, run.threadId, run.runId)
      engine.markTerminal(done.runId, 'completed')
      engine.markTerminal(failed.runId, 'failed', { error: 'boom' })
      // The restart cut-offs keep theirs for the next boot.
      engine.markTerminal(cut.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
      engine.markTerminal(unsure.runId, 'uncertain', { uncertainReason: 'test' })

      expect(engine.approvals.get('r-done')).toMatchObject({ status: 'cancelled', cancelReason: 'turn_ended' })
      expect(engine.approvals.get('r-failed')).toMatchObject({ status: 'cancelled', cancelReason: 'turn_ended' })
      expect(engine.approvals.get('r-cut')!.status).toBe('pending')
      expect(engine.approvals.get('r-unsure')!.status).toBe('pending')
      const types = store.listEvents('t1').map((event) => event.type)
      expect(types).toContain('approval.pending')
      expect(types.indexOf('approval.cancelled')).toBeGreaterThan(types.indexOf('approval.pending'))
    })
  })
})
