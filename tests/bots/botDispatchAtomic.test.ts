import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { strandedQueuedRuns } from '../../src/mms/run/strandedRuns'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import { hasUnknownTurnPayloadKind, isBotTurnPayload, isSendTurnPayload, type BotTurnPayload } from '../../src/mms/run/types'

/**
 * PR 6 §4 "Bot dispatch: atomic, and invisible to older builds": a bot run is written with its
 * receipt and its `turn.start` in one run-DB transaction, and its payload carries no `input`, so
 * reconciler rule 5 never restarts it as an ordinary send, in this build or an older one.
 */

const T0 = Date.parse('2026-10-27T00:00:00.000Z')

/**
 * The send guard of every build since d540c3d0 (and of f61a5030, the base PR 6 was planned on),
 * copied: an older build decides with exactly this whether a stranded queued run is restarted.
 */
function olderBuildIsSendTurnPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>
  return typeof value.runId === 'string' && typeof value.threadId === 'string' && value.input !== undefined && value.input !== null
}

describe('bot dispatch (sendWithStart)', () => {
  const homes: string[] = []
  const dbs: ProfileDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const open = (profileHome: string, fault?: (point: string) => void) => {
    let clock = T0
    const db = new ProfileDatabase({ profileHome, clock: () => clock, ...(fault ? { fault } : {}) })
    dbs.push(db)
    const store = new RunStore(db)
    const now = () => new Date(clock).toISOString()
    const outbox = new EffectOutbox(store, { now })
    const tools = new ToolInvocations(store)
    const engine = new RunEngine({ store, outbox, tools, now, pid: 1 })
    const reconciler = new Reconciler({ store, outbox, tools, now, heartbeatMs: 10_000 })
    return { db, store, outbox, engine, reconciler, advance: (ms: number) => { clock += ms } }
  }

  const home = () => {
    const path = mkdtempSync(join(tmpdir(), 'mousse-bot-dispatch-'))
    homes.push(path)
    return path
  }

  const command = (clientRequestId = 'act-1:d1') => ({ kind: 'send' as const, threadId: 'bot-thread', clientRequestId, source: 'bot' })
  const payloadFor = (runId: string): BotTurnPayload => ({ kind: 'bot', runId, threadId: 'bot-thread', activationId: 'act-1', dispatchN: 1 })

  it('writes the run, its receipt and its turn.start together, with a payload that has no input', async () => {
    const { store, outbox, engine } = open(home())
    const sent = await engine.sendWithStart(command(), payloadFor)
    expect(sent).toMatchObject({ status: 'accepted', replayed: false })
    if (sent.status !== 'accepted') throw new Error('rejected')
    expect(store.getRun(sent.runId)).toMatchObject({ status: 'queued', source: 'bot', threadId: 'bot-thread' })
    expect(store.getReceipt('act-1:d1')).toMatchObject({ commandKind: 'send', status: 'accepted' })
    const starts = outbox.listForRun(sent.runId).filter((effect) => effect.kind === 'turn.start')
    expect(starts).toHaveLength(1)
    expect(starts[0].payload).toEqual(payloadFor(sent.runId))
    expect(isBotTurnPayload(starts[0].payload)).toBe(true)
    expect(isSendTurnPayload(starts[0].payload)).toBe(false)
    expect((starts[0].payload as Record<string, unknown>).input).toBeUndefined()
  })

  it('a repeat with the same request id replays and writes nothing more', async () => {
    const { store, outbox, engine } = open(home())
    const first = await engine.sendWithStart(command(), payloadFor)
    const second = await engine.sendWithStart(command(), payloadFor)
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('rejected')
    expect(second).toMatchObject({ runId: first.runId, replayed: true })
    expect(store.listRuns('bot-thread')).toHaveLength(1)
    expect(outbox.listForRun(first.runId).filter((effect) => effect.kind === 'turn.start')).toHaveLength(1)
  })

  it('a crash before the commit leaves no run, no receipt and no effect; the retry writes each once', async () => {
    const profile = home()
    let crash = true
    const { store, outbox, engine } = open(profile, (point) => {
      if (crash && point === 'sendWithStart.beforeCommit') throw new Error('crash')
    })
    await expect(engine.sendWithStart(command(), payloadFor)).rejects.toThrow('crash')
    expect(store.listRuns('bot-thread')).toEqual([])
    expect(store.getReceipt('act-1:d1')).toBeNull()
    expect(outbox.listForThread('bot-thread')).toEqual([])
    crash = false
    const sent = await engine.sendWithStart(command(), payloadFor)
    if (sent.status !== 'accepted') throw new Error('rejected')
    expect(store.listRuns('bot-thread').map((run) => run.runId)).toEqual([sent.runId])
    expect(outbox.listForThread('bot-thread').filter((effect) => effect.kind === 'turn.start')).toHaveLength(1)
  })

  it('a refused continuation writes no run and no effect', async () => {
    const { store, outbox, engine } = open(home())
    const refused = await engine.sendWithStart({ ...command(), continuationOfRunId: 'run-missing' }, payloadFor)
    expect(refused).toMatchObject({ status: 'rejected', reason: 'continuation_not_found' })
    expect(store.listRuns('bot-thread')).toEqual([])
    expect(outbox.listForThread('bot-thread')).toEqual([])
  })

  it('an unknown payload kind is recognised as such; ordinary sends and known kinds are not', () => {
    const known = ['wake', 'integration', 'continuation', 'bot']
    expect(hasUnknownTurnPayloadKind({ kind: 'bot2', runId: 'r', threadId: 't' }, known)).toBe(true)
    expect(hasUnknownTurnPayloadKind({ kind: 'bot', runId: 'r', threadId: 't', activationId: 'a', dispatchN: 1 }, known)).toBe(false)
    expect(hasUnknownTurnPayloadKind({ runId: 'r', threadId: 't', input: { content: 'x' } }, known)).toBe(false)
    expect(isBotTurnPayload({ kind: 'bot', runId: 'r', threadId: 't', activationId: 'a' })).toBe(false)
  })

  describe('downgrade: an older build never starts a queued bot send', () => {
    it('the older build\'s send guard refuses the payload, so rule 5 has nothing to restart', () => {
      const payload = payloadFor('run-1')
      expect(olderBuildIsSendTurnPayload(payload)).toBe(false)
      // The current guard is the older one, unchanged.
      expect(isSendTurnPayload(payload)).toBe(olderBuildIsSendTurnPayload(payload))
    })

    it('a profile left with a queued bot run boots, reconciles and stays queued with nothing started', async () => {
      const profile = home()
      const newer = open(profile)
      const sent = await newer.engine.sendWithStart(command(), payloadFor)
      if (sent.status !== 'accepted') throw new Error('rejected')
      // The newer daemon goes away with the bot run queued and its turn.start pending.
      newer.db.close()
      dbs.splice(dbs.indexOf(newer.db), 1)

      // The older build opens the same run database (no migration: bot runs need none).
      const older = open(profile)
      const boot = older.engine.reconcileOnBoot()
      expect(boot).toBeDefined()
      const effects = () => older.outbox.listForRun(sent.runId)
      // Boot cancels the process-bound turn.start, so no worker can claim it.
      expect(effects().map((effect) => [effect.kind, effect.status])).toEqual([['turn.start', 'cancelled']])
      expect(strandedQueuedRuns(older.store, older.outbox)).toEqual([])
      for (let tick = 0; tick < 3; tick += 1) {
        const report = older.reconciler.runOnce()
        expect(report.queuedStarts).toEqual([])
        expect(report.strandedCancelled).toEqual([])
        older.advance(60_000)
      }
      // Nothing claimable exists for the run, so no request can be sent for it.
      expect(effects().filter((effect) => effect.status === 'pending' || effect.status === 'running')).toEqual([])
      expect(older.store.getRun(sent.runId)).toMatchObject({ status: 'queued', source: 'bot' })
    })

    it('the same boot restarts an ordinary queued send (positive control)', async () => {
      const profile = home()
      const newer = open(profile)
      const sent = await newer.engine.dispatch({ kind: 'send', threadId: 'plain', clientRequestId: 'plain-1', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('rejected')
      newer.outbox.enqueue({ threadId: 'plain', runId: sent.runId, kind: 'turn.start', payload: { runId: sent.runId, threadId: 'plain', input: { content: 'hello', mode: 'agent' } } })
      newer.db.close()
      dbs.splice(dbs.indexOf(newer.db), 1)
      const older = open(profile)
      older.engine.reconcileOnBoot()
      expect(older.reconciler.runOnce().queuedStarts).toEqual([sent.runId])
    })
  })
})
