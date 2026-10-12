import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunFsck } from '../../src/mms/run/fsck/RunFsck'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { EffectStatus, RunStatus, ToolInvocationStatus } from '../../src/mms/run/types'

/**
 * SPEC §12.8 fault matrix. One turn runs through every durable step; the daemon is killed by
 * throwing at `transaction.beforeCommit` of one step (that step rolls back, nothing after it
 * runs), the database is reopened by a new daemon, and `reconcileOnBoot()` + `runOnce()` must
 * leave exactly the states in the table. `enqueue-claimed-not-started` is a plain crash after the
 * claim of a `turn.start` that stored its send: rule 5 enqueues it again.
 */
const STEPS = [
  'send', // run.created
  'enqueue', // effect pending
  'claim', // effect running
  'starting',
  'running', // provider streaming
  'tool.start',
  'tool.commit',
  'finalizing',
  'terminal', // turn terminal
  'succeed' // effect succeeded
] as const
type Step = (typeof STEPS)[number]

interface Expected {
  killAt: Step | 'enqueue-claimed-not-started' | null
  tool: string
  run: RunStatus | null
  effect: EffectStatus | null
  invocation: ToolInvocationStatus | null
  boot: 'none' | 'interrupted' | 'uncertain'
  /** Rule 5 on the stranded queued run (its dead effect stored no send, or one). */
  queued?: 'cancelled' | 'restarted'
}

const MATRIX: Expected[] = [
  { killAt: 'send', tool: 'bash', run: null, effect: null, invocation: null, boot: 'none' },
  { killAt: 'enqueue', tool: 'bash', run: 'queued', effect: null, invocation: null, boot: 'none' },
  { killAt: 'claim', tool: 'bash', run: 'cancelled', effect: 'cancelled', invocation: null, boot: 'none', queued: 'cancelled' },
  { killAt: 'starting', tool: 'bash', run: 'cancelled', effect: 'cancelled', invocation: null, boot: 'none', queued: 'cancelled' },
  { killAt: 'enqueue-claimed-not-started', tool: 'bash', run: 'queued', effect: 'cancelled', invocation: null, boot: 'none', queued: 'restarted' },
  { killAt: 'running', tool: 'bash', run: 'interrupted', effect: 'cancelled', invocation: null, boot: 'interrupted' },
  { killAt: 'tool.start', tool: 'bash', run: 'interrupted', effect: 'cancelled', invocation: null, boot: 'interrupted' },
  { killAt: 'tool.commit', tool: 'bash', run: 'uncertain', effect: 'cancelled', invocation: 'outcome_unknown', boot: 'uncertain' },
  { killAt: 'tool.commit', tool: 'read_file', run: 'interrupted', effect: 'cancelled', invocation: 'outcome_unknown', boot: 'interrupted' },
  { killAt: 'finalizing', tool: 'bash', run: 'interrupted', effect: 'cancelled', invocation: 'committed', boot: 'interrupted' },
  { killAt: 'terminal', tool: 'bash', run: 'interrupted', effect: 'cancelled', invocation: 'committed', boot: 'interrupted' },
  { killAt: 'succeed', tool: 'bash', run: 'completed', effect: 'cancelled', invocation: 'committed', boot: 'none' },
  { killAt: null, tool: 'bash', run: 'completed', effect: 'succeeded', invocation: 'committed', boot: 'none' }
]

const THREAD = 'matrix'
const RUN_ID = 'run:thread:matrix:ordinal:1'
const EFFECT_ID = `effect:${RUN_ID}:turn.start:1`
const RESTARTED_EFFECT_ID = `effect:${RUN_ID}:turn.start:2`
const SEND = { runId: RUN_ID, threadId: THREAD, input: { content: 'hello', mode: 'agent' } }
const INVOCATION_ID = 'call-1'

describe('run engine durability matrix', () => {
  const roots: string[] = []
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  const daemon = (profileHome: string, pid: number, clock: () => number, fault?: (point: string) => void) => {
    const db = new ProfileDatabase({ profileHome, clock, fault })
    dbs.push(db)
    const store = new RunStore(db)
    const engine = new RunEngine({ store, pid })
    return { db, store, engine }
  }

  it.each(MATRIX)('kill at $killAt with $tool → run $run, effect $effect, tool $invocation', async (row) => {
    const profileHome = mkdtempSync(join(tmpdir(), 'mousse-run-matrix-'))
    roots.push(profileHome)
    let tick = Date.UTC(2026, 9, 12)
    const clock = () => (tick += 1000)
    let killNext = false
    const first = daemon(profileHome, 1, clock, (point) => {
      if (killNext && point === 'transaction.beforeCommit') {
        killNext = false
        throw new Error('killed')
      }
    })
    first.engine.reconcileOnBoot()
    const { engine } = first
    const now = () => new Date(tick).toISOString()

    const perform: Record<Step, () => unknown> = {
      send: () => engine.dispatch({ kind: 'send', threadId: THREAD, clientRequestId: 'req-1', source: 'gui' }),
      enqueue: () =>
        engine.outbox.enqueue({
          threadId: THREAD,
          runId: RUN_ID,
          kind: 'turn.start',
          ...(row.queued === 'restarted' ? { payload: SEND } : {})
        }),
      claim: () => {
        if (!engine.outbox.claimNext(engine.leaseOwner, now())) throw new Error('nothing to claim')
      },
      starting: () => engine.markStarting(RUN_ID),
      running: () => engine.markRunning(RUN_ID),
      'tool.start': () =>
        engine.tools.start({
          invocationId: INVOCATION_ID,
          runId: RUN_ID,
          attemptId: engine.getRun(RUN_ID)!.activeAttemptId!,
          tool: row.tool,
          argsDigest: 'sha256:args',
          now: now()
        }),
      'tool.commit': () => engine.tools.commit(INVOCATION_ID, now()),
      finalizing: () => engine.markFinalizing(RUN_ID),
      terminal: () => engine.markTerminal(RUN_ID, 'completed'),
      succeed: () => {
        if (!engine.outbox.succeed(EFFECT_ID, engine.leaseOwner, now()).settled) throw new Error('lost lease')
      }
    }

    for (const step of STEPS) {
      // A plain crash once the claimed turn.start is running, before the turn starts.
      if (row.killAt === 'enqueue-claimed-not-started' && step === 'starting') break
      if (step === row.killAt) {
        killNext = true
        await expect(Promise.resolve().then(perform[step])).rejects.toThrow('killed')
        break
      }
      await perform[step]()
    }
    // Crash: the connection goes away without `shutdown()`.
    first.db.close()

    const second = daemon(profileHome, 2, clock)
    const boot = second.engine.reconcileOnBoot()
    const reconciler = new Reconciler({
      store: second.store,
      outbox: second.engine.outbox,
      tools: second.engine.tools
    })
    const repairs = reconciler.runOnce()
    expect(boot.strandedQueued).toEqual(row.queued ? [RUN_ID] : [])
    expect(repairs.queuedStarts).toEqual(row.queued === 'restarted' ? [RUN_ID] : [])
    expect(repairs.strandedCancelled).toEqual(row.queued === 'cancelled' ? [RUN_ID] : [])
    if (row.queued === 'cancelled')
      expect(second.store.getRun(RUN_ID)!.outcome).toEqual({ error: 'no turn payload after restart' })
    // The restarted run gets a fresh turn.start carrying the stored send.
    expect(second.engine.outbox.get(RESTARTED_EFFECT_ID)).toEqual(
      row.queued === 'restarted' ? expect.objectContaining({ status: 'pending', payload: SEND }) : null
    )

    expect(boot.epoch).toBe(2)
    expect(boot.interrupted).toEqual(row.boot === 'interrupted' ? [RUN_ID] : [])
    expect(boot.uncertain).toEqual(row.boot === 'uncertain' ? [RUN_ID] : [])
    expect({
      run: second.store.getRun(RUN_ID)?.status ?? null,
      effect: second.engine.outbox.get(EFFECT_ID)?.status ?? null,
      invocation: second.engine.tools.get(INVOCATION_ID)?.status ?? null
    }).toEqual({ run: row.run, effect: row.effect, invocation: row.invocation })
    if (row.run === 'uncertain')
      expect(second.store.getRun(RUN_ID)!.outcome).toMatchObject({
        uncertainReason: 'non_idempotent_tool_in_flight',
        error: expect.stringContaining(row.tool)
      })
    const notes = second.store.listEvents(THREAD).filter((event) => event.type === 'restart.note')
    expect(notes).toHaveLength(row.boot === 'none' && !row.queued ? 0 : 1)
    if (row.queued) expect(notes[0].payload).toMatchObject({ runIds: [], queuedRunIds: [RUN_ID] })
    // Recovery leaves no consistency errors behind.
    expect(RunFsck.checkDatabase(second.db).filter((finding) => finding.severity === 'error')).toEqual([])
  })
})
