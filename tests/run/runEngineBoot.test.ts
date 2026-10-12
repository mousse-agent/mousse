import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { RunRecord, ThreadEvent } from '../../src/mms/run/types'

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
    const engine = new RunEngine({ store, pid })
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
    expect(boot).toEqual({ interrupted: [], uncertain: [], epoch: 1 })
    expect(engine.epoch).toBe(1)
    expect(engine.leaseOwner).toBe('1:10')
  })

  it('interrupts active runs after a clean shutdown even with a non-idempotent tool started', async () => {
    const first = daemon(10)
    const run = await running(first.engine, 't', 'req-1')
    startTool(first.engine, run, 'call-1', 'bash')
    first.engine.shutdown()

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [run.runId], uncertain: [], epoch: 2 })
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
    expect(second.boot).toEqual({ interrupted: [], uncertain: [run.runId], epoch: 2 })
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

    const second = daemon(20)
    expect(second.boot).toEqual({ interrupted: [run.runId], uncertain: [], epoch: 2 })
    expect(second.store.getRun(run.runId)!.outcome).toEqual({ interruptedBy: 'daemon_restart' })
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
    expect(second.boot).toEqual({ interrupted: [b.runId], uncertain: [a.runId], epoch: 2 })
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
})
