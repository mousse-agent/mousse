import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { addMs, EffectOutbox, EFFECT_LEASE_GRACE_MS } from '../../src/mms/run/EffectOutbox'
import { RunStore } from '../../src/mms/run/RunStore'

const T0 = '2026-10-12T00:00:00.000Z'
const at = (ms: number): string => addMs(T0, ms)

describe('EffectOutbox', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const open = () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-outbox-'))
    let clock = Date.parse(T0)
    db = new ProfileDatabase({ profileHome, clock: () => clock })
    const store = new RunStore(db)
    const outbox = new EffectOutbox(store, { allowReservedKinds: true })
    return {
      store,
      outbox,
      setClock: (iso: string) => {
        clock = Date.parse(iso)
      }
    }
  }

  const effectEvents = (store: RunStore, threadId: string) =>
    store.listEvents(threadId).filter((event) => event.type === 'effect.status')

  it('enqueues with a deterministic id and spec-derived fields, idempotently by id', () => {
    const { store, outbox } = open()
    const run = store.createRun({ threadId: 't', source: 'gui' })
    const first = outbox.enqueue({
      threadId: 't',
      runId: run.runId,
      kind: 'turn.start',
      payload: { a: 1 }
    })
    expect(first).toMatchObject({
      effectId: `effect:${run.runId}:turn.start:1`,
      status: 'pending',
      class: 'process_bound',
      timeoutMs: 6 * 60 * 60_000,
      maxAttempts: 1,
      attempts: 0,
      availableAt: T0,
      payload: { a: 1 }
    })
    const second = outbox.enqueue({ threadId: 't', runId: run.runId, kind: 'turn.start' })
    expect(second.effectId).toBe(`effect:${run.runId}:turn.start:2`)
    const runless = outbox.enqueue({ threadId: 't', kind: 'title.generate' })
    expect(runless).toMatchObject({
      effectId: 'effect:t:title.generate:1',
      class: 'replay_safe',
      timeoutMs: 60_000
    })

    const again = outbox.enqueue({
      effectId: first.effectId,
      threadId: 't',
      runId: run.runId,
      kind: 'turn.start',
      payload: { a: 2 }
    })
    expect(again).toEqual(first)
    expect(outbox.listForThread('t')).toHaveLength(3)
    expect(effectEvents(store, 't')).toHaveLength(3)
    expect(effectEvents(store, 't')[0].payload).toEqual(JSON.parse(JSON.stringify(first)))
  })

  it('lets an earlier available pending row in the lane block a later one', () => {
    const { outbox } = open()
    const a = outbox.enqueue({ threadId: 't', kind: 'turn.start', availableAt: at(1000) })
    const b = outbox.enqueue({ threadId: 't', kind: 'checkpoint.capture', availableAt: T0 })
    // b sorts first by available_at, but a is older in the lane and available, so a goes first.
    expect(outbox.claimNext('1:1', at(2000))!.effectId).toBe(a.effectId)
    expect(outbox.claimNext('1:1', at(2000))).toBeNull()
    expect(outbox.get(b.effectId)!.status).toBe('pending')
  })

  it('lets an earlier row that is not yet available (backoff, deferral) block the lane: a lane is FIFO (L2)', () => {
    const { outbox } = open()
    const later = outbox.enqueue({ threadId: 't', kind: 'turn.start', availableAt: at(5000) })
    const due = outbox.enqueue({ threadId: 't', kind: 'checkpoint.capture', availableAt: T0 })
    // `due` is available, but the earlier `later` row still waits: nothing in the lane may overtake it.
    expect(outbox.claimNext('1:1', at(1000))).toBeNull()
    expect(outbox.get(due.effectId)!.status).toBe('pending')
    // Another thread's lane is unaffected.
    const other = outbox.enqueue({ threadId: 'u', kind: 'checkpoint.capture', availableAt: T0 })
    expect(outbox.claimNext('1:1', at(1000))!.effectId).toBe(other.effectId)
    // Once the earlier row is due it goes first, then holds the lane while running.
    expect(outbox.claimNext('1:1', at(6000))!.effectId).toBe(later.effectId)
    expect(outbox.claimNext('1:1', at(6000))).toBeNull()
  })

  it('defer puts a running effect back to pending later without counting the attempt', () => {
    const { outbox } = open()
    const turn = outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    const claimed = outbox.claimNext('1:1', T0)!
    expect(claimed.attempts).toBe(1)
    expect(outbox.defer(turn.effectId, '2:2', T0, at(5000), 'thread_busy')).toEqual({ settled: false, status: 'running' })
    const deferred = outbox.defer(turn.effectId, '1:1', T0, at(5000), 'thread_busy')
    expect(deferred).toMatchObject({ settled: true, effect: { status: 'pending', attempts: 0, availableAt: at(5000), leaseOwner: null, lastError: 'thread_busy' } })
    expect(outbox.claimNext('1:1', at(1000))).toBeNull()
    expect(outbox.claimNext('1:1', at(5000))).toMatchObject({ effectId: turn.effectId, attempts: 1 })
  })

  it('refuses to enqueue a reserved effect kind (no producer yet, SPEC §12.2)', () => {
    const { store } = open()
    const strict = new EffectOutbox(store)
    for (const kind of ['request.respond', 'checkpoint.capture', 'title.generate', 'workspace.cleanup'] as const)
      expect(() => strict.enqueue({ threadId: 't', kind })).toThrow(expect.objectContaining({ code: 'bad_request', message: 'reserved effect kind' }))
    expect(strict.listForThread('t')).toEqual([])
    expect(strict.enqueue({ threadId: 't', kind: 'turn.interrupt' }).status).toBe('pending')
  })

  it('pages a thread\'s effects newest first by cursor, oldest first within a page', () => {
    const { outbox } = open()
    const ids = Array.from({ length: 5 }, () => outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' }).effectId)
    outbox.enqueue({ threadId: 'u', kind: 'turn.interrupt' })
    const newest = outbox.pageForThread('t', { limit: 2 })
    expect(newest.effects.map((effect) => effect.effectId)).toEqual(ids.slice(3))
    expect(newest.hasMore).toBe(true)
    const older = outbox.pageForThread('t', { limit: 2, before: newest.cursor! })
    expect(older.effects.map((effect) => effect.effectId)).toEqual(ids.slice(1, 3))
    const oldest = outbox.pageForThread('t', { limit: 2, before: older.cursor! })
    expect(oldest).toMatchObject({ hasMore: false })
    expect(oldest.effects.map((effect) => effect.effectId)).toEqual(ids.slice(0, 1))
    expect(outbox.pageForThread('t', { limit: 10_000 }).effects).toHaveLength(5)
  })

  it('blocks a lane on a running row with a live lease but not on an expired one', () => {
    const { outbox } = open()
    const a = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    const b = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    const other = outbox.enqueue({ threadId: 'u', kind: 'turn.steer' })
    const claimed = outbox.claimNext('1:1', T0)!
    expect(claimed).toMatchObject({
      effectId: a.effectId,
      status: 'running',
      attempts: 1,
      leaseOwner: '1:1',
      leaseExpiresAt: at(30_000 + EFFECT_LEASE_GRACE_MS)
    })
    expect(outbox.claimNext('1:1', at(1000))!.effectId).toBe(other.effectId)
    expect(outbox.claimNext('1:1', at(1000))).toBeNull()
    expect(outbox.claimNext('1:1', at(30_000 + EFFECT_LEASE_GRACE_MS - 1))).toBeNull()
    // The lease has expired: the stuck row no longer holds the lane.
    expect(outbox.claimNext('1:2', at(30_000 + EFFECT_LEASE_GRACE_MS))!.effectId).toBe(b.effectId)
  })

  it('runs the title lane independently of the thread lane', () => {
    const { outbox } = open()
    const turn = outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    const title = outbox.enqueue({ threadId: 't', kind: 'title.generate' })
    const title2 = outbox.enqueue({ threadId: 't', kind: 'title.generate' })
    const cleanup = outbox.enqueue({ threadId: 't', kind: 'workspace.cleanup' })
    expect(outbox.claimNext('o', T0)!.effectId).toBe(turn.effectId)
    expect(outbox.claimNext('o', T0)!.effectId).toBe(title.effectId)
    // Thread lane is held by the turn; title lane by the first title.
    expect(outbox.claimNext('o', T0)).toBeNull()
    outbox.succeed(turn.effectId, 'o', at(1))
    expect(outbox.claimNext('o', at(2))!.effectId).toBe(cleanup.effectId)
    outbox.succeed(title.effectId, 'o', at(3))
    expect(outbox.claimNext('o', at(4))!.effectId).toBe(title2.effectId)
  })

  it('runs interrupt, steer and answers in a control lane beside a running turn', () => {
    const { outbox } = open()
    const turn = outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    const interrupt = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    const steer = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    const answer = outbox.enqueue({ threadId: 't', kind: 'request.respond' })
    expect(outbox.claimNext('o', T0)!.effectId).toBe(turn.effectId)
    // The control lane is FIFO on its own: the turn does not block it.
    expect(outbox.claimNext('o', T0)!.effectId).toBe(interrupt.effectId)
    expect(outbox.claimNext('o', T0)).toBeNull()
    outbox.succeed(interrupt.effectId, 'o', at(1))
    expect(outbox.claimNext('o', at(2))!.effectId).toBe(steer.effectId)
    outbox.succeed(steer.effectId, 'o', at(3))
    expect(outbox.claimNext('o', at(4))!.effectId).toBe(answer.effectId)
    expect(outbox.get(turn.effectId)!.status).toBe('running')
  })

  it('settles by CAS on status and lease owner and writes nothing on a miss', () => {
    const { store, outbox } = open()
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    expect(outbox.succeed(effect.effectId, 'o', T0)).toEqual({ settled: false, status: 'pending' })
    outbox.claimNext('o', T0)
    const events = effectEvents(store, 't').length
    expect(outbox.succeed(effect.effectId, 'intruder', at(1))).toEqual({
      settled: false,
      status: 'running'
    })
    expect(outbox.fail(effect.effectId, 'intruder', at(1), 'x')).toEqual({
      settled: false,
      status: 'running'
    })
    expect(outbox.renewLease(effect.effectId, 'intruder', at(1))).toBe(false)
    expect(effectEvents(store, 't')).toHaveLength(events)

    expect(outbox.renewLease(effect.effectId, 'o', at(10))).toBe(true)
    expect(outbox.get(effect.effectId)!.leaseExpiresAt).toBe(
      at(10 + 30_000 + EFFECT_LEASE_GRACE_MS)
    )
    const done = outbox.succeed(effect.effectId, 'o', at(20))
    expect(done).toMatchObject({
      settled: true,
      effect: { status: 'succeeded', completedAt: at(20), leaseExpiresAt: null }
    })
    expect(outbox.succeed(effect.effectId, 'o', at(21))).toEqual({
      settled: false,
      status: 'succeeded'
    })
    expect(outbox.get(effect.effectId)!.status).toBe('succeeded')
    expect(outbox.renewLease(effect.effectId, 'o', at(22))).toBe(false)
  })

  it('backs off 100/200/400/800 ms and fails at the fifth attempt', () => {
    const { outbox } = open()
    const effect = outbox.enqueue({ threadId: 't', kind: 'checkpoint.capture' })
    let now = Date.parse(T0)
    const delays: number[] = []
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claimed = outbox.claimNext('o', new Date(now).toISOString())!
      expect(claimed.attempts).toBe(attempt)
      const settled = outbox.fail(effect.effectId, 'o', new Date(now).toISOString(), 'boom')
      if (!settled.settled) throw new Error('not settled')
      expect(settled.effect).toMatchObject({
        status: 'pending',
        lastError: 'boom',
        leaseOwner: null
      })
      const delay = Date.parse(settled.effect.availableAt) - now
      delays.push(delay)
      expect(outbox.claimNext('o', new Date(now + delay - 1).toISOString())).toBeNull()
      now += delay
    }
    expect(delays).toEqual([100, 200, 400, 800])
    outbox.claimNext('o', new Date(now).toISOString())
    const last = outbox.fail(effect.effectId, 'o', new Date(now).toISOString(), 'final')
    expect(last).toMatchObject({
      settled: true,
      effect: { status: 'failed', attempts: 5, lastError: 'final' }
    })
    expect(outbox.nextFutureAvailableAt(new Date(now).toISOString())).toBeNull()
  })

  it('reclaims expired leases without an owner check', () => {
    const { store, outbox } = open()
    const a = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    const b = outbox.enqueue({ threadId: 'u', kind: 'turn.interrupt' })
    outbox.claimNext('dead', T0)
    outbox.claimNext('dead', at(10_000))
    const expiry = 30_000 + EFFECT_LEASE_GRACE_MS
    expect(outbox.reclaimExpired(at(expiry - 1))).toEqual([])
    expect(outbox.reclaimExpired(at(expiry))).toEqual([a.effectId])
    expect(outbox.get(a.effectId)).toMatchObject({
      status: 'pending',
      lastError: 'lease expired',
      leaseOwner: null,
      availableAt: at(expiry + 100)
    })
    expect(outbox.get(b.effectId)!.status).toBe('running')
    expect(outbox.listRunning().map((effect) => effect.effectId)).toEqual([b.effectId])
    expect(effectEvents(store, 't').at(-1)!.payload).toMatchObject({ status: 'pending' })
  })

  it('cancels process-bound effects and re-queues running replay-safe ones on boot', () => {
    const { outbox } = open()
    const turnRunning = outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    const steerPending = outbox.enqueue({
      threadId: 't',
      kind: 'turn.steer',
      availableAt: at(60_000)
    })
    const titleRunning = outbox.enqueue({ threadId: 't', kind: 'title.generate' })
    const cleanupPending = outbox.enqueue({
      threadId: 'u',
      kind: 'workspace.cleanup',
      availableAt: at(60_000)
    })
    const checkpointRunning = outbox.enqueue({ threadId: 'v', kind: 'checkpoint.capture' })
    outbox.claimNext('1:1', T0)
    outbox.claimNext('1:1', T0)
    outbox.claimNext('1:1', T0)
    expect(outbox.listRunning().map((effect) => effect.effectId)).toEqual([
      turnRunning.effectId,
      titleRunning.effectId,
      checkpointRunning.effectId
    ])

    const cancelled = outbox.cancelProcessBound('daemon_restart', at(5))
    expect(cancelled.map((effect) => effect.effectId)).toEqual([
      turnRunning.effectId,
      steerPending.effectId
    ])
    expect(outbox.get(steerPending.effectId)).toMatchObject({
      status: 'cancelled',
      lastError: 'daemon_restart',
      completedAt: at(5)
    })
    const requeued = outbox.requeueRunningReplaySafe(at(6))
    expect(requeued.map((effect) => effect.effectId)).toEqual([
      titleRunning.effectId,
      checkpointRunning.effectId
    ])
    expect(outbox.get(titleRunning.effectId)).toMatchObject({
      status: 'pending',
      availableAt: at(6),
      leaseOwner: null,
      leaseExpiresAt: null,
      attempts: 1
    })
    expect(outbox.get(cleanupPending.effectId)).toMatchObject({
      status: 'pending',
      availableAt: at(60_000)
    })
    expect(outbox.listForThread('t', { status: 'cancelled' })).toHaveLength(2)
    expect(outbox.listPending().map((effect) => effect.effectId)).toEqual([
      titleRunning.effectId,
      checkpointRunning.effectId,
      cleanupPending.effectId
    ])
    expect(outbox.nextFutureAvailableAt(at(0))).toBe(at(6))
    // A due row blocked behind an earlier one does not count: the next claimable moment is the future one.
    expect(outbox.nextFutureAvailableAt(at(7))).toBe(at(60_000))
    expect(outbox.nextFutureAvailableAt(at(60_000))).toBeNull()
    expect(outbox.nextFutureAvailableAt(at(5))).toBe(at(6))
  })

  it('cancels pending or running effects without an owner and notifies subscribers after commit', () => {
    const { store, outbox } = open()
    let notified = 0
    const unsubscribe = outbox.subscribe(() => notified++)
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    expect(notified).toBe(1)
    store.db.transaction(() => {
      outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
      expect(notified).toBe(1)
    })
    expect(notified).toBe(2)
    outbox.claimNext('o', T0)
    expect(notified).toBe(2)
    expect(outbox.cancel(effect.effectId, at(1), 'stop', 'other')).toEqual({
      settled: false,
      status: 'running'
    })
    expect(outbox.cancel(effect.effectId, at(1), 'stop')).toMatchObject({
      settled: true,
      effect: { status: 'cancelled', lastError: 'stop' }
    })
    expect(outbox.cancel(effect.effectId, at(2), 'again')).toEqual({
      settled: false,
      status: 'cancelled'
    })
    expect(notified).toBe(3)
    unsubscribe()
    outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    expect(notified).toBe(3)
  })

  it('rejects an unknown kind', () => {
    const { outbox } = open()
    expect(() => outbox.enqueue({ threadId: 't', kind: 'nope' as never })).toThrow(
      /Unknown effect kind/
    )
  })
})
