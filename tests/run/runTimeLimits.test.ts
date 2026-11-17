/**
 * Issue #685: the running-time limit an agent on another computer gives a run here. `RunTimeLimits` counts only the
 * time the run works (not queued, paused, or waiting on a person), stops it once at its limit, and forgets it when it
 * ends. The records are an in-memory stand-in for `run_time_limits`; the clock is the test's.
 */
import { describe, expect, it } from 'vitest'
import { RunTimeLimits, runTimeLimitMessage } from '../../src/mms/orchestrator/RunTimeLimits'
import type { RunTimeLimitRecord, RunTimeLimitRecords } from '../../src/mms/run/runTimeLimits'
import type { RunRecord } from '../../src/mms/run/types'

const TICK = 15_000

function setup(limitMinutes = 1) {
  const rows = new Map<string, RunTimeLimitRecord>()
  const records = {
    set: (runId: string, threadId: string, limitMs: number) => { if (!rows.has(runId)) rows.set(runId, { runId, threadId, limitMs, usedMs: 0 }) },
    get: (runId: string) => rows.get(runId) ?? null,
    list: () => [...rows.values()].map((row) => ({ ...row })),
    has: () => rows.size > 0,
    setUsed: (runId: string, usedMs: number) => { rows.get(runId)!.usedMs = usedMs },
    remove: (runId: string) => { rows.delete(runId) }
  } as unknown as RunTimeLimitRecords
  const world = { now: 0, status: 'running' as string | null, waiting: false, stops: [] as Array<{ threadId: string; runId: string; message: string }> }
  const limits = new RunTimeLimits({
    records,
    getRun: () => (world.status ? { status: world.status } as RunRecord : null),
    waitingOnPerson: () => world.waiting,
    stop: async (threadId, runId, message) => { world.stops.push({ threadId, runId, message }) },
    tickMs: TICK,
    now: () => world.now
  })
  limits.set('run-1', 'thread-1', limitMinutes)
  /** Moves the clock on by `ms` and runs one tick. */
  const tick = async (ms = TICK) => {
    world.now += ms
    await limits.pass()
  }
  const used = () => rows.get('run-1')?.usedMs
  return { world, limits, tick, used, rows }
}

describe('running-time limits (issue #685)', () => {
  it('counts only the time the run works: not queued, not paused, not while a person is asked', async () => {
    const { world, tick, used } = setup()
    await tick() // the first read only starts counting
    expect(used()).toBe(0)
    await tick()
    expect(used()).toBe(TICK)
    for (const status of ['queued', 'paused']) {
      world.status = status
      await tick()
    }
    world.status = 'running'
    world.waiting = true
    await tick()
    expect(used()).toBe(TICK)
    world.waiting = false
    world.status = 'finalizing'
    await tick()
    expect(used()).toBe(2 * TICK)
  })

  it('a computer that slept or a clock that jumped adds at most two ticks', async () => {
    const { tick, used } = setup()
    await tick()
    await tick(60 * 60_000)
    expect(used()).toBe(2 * TICK)
  })

  it('stops the run once at its limit, saying so, and forgets it once the run ended', async () => {
    const { world, tick, rows } = setup(1)
    await tick()
    for (let i = 0; i < 3; i += 1) await tick()
    expect(world.stops).toEqual([])
    await tick()
    expect(world.stops).toEqual([{ threadId: 'thread-1', runId: 'run-1', message: 'Stopped after its limit of 1 minute of running time.' }])
    // A slow stop is not asked for again on the next tick.
    await tick()
    expect(world.stops).toHaveLength(1)
    world.status = 'cancelled'
    await tick()
    expect(rows.size).toBe(0)
  })

  it('a retry of the same send keeps what the run used', async () => {
    const { limits, tick, used } = setup()
    await tick()
    await tick()
    limits.set('run-1', 'thread-1', 1)
    expect(used()).toBe(TICK)
  })

  it('a run that is gone is forgotten without a stop', async () => {
    const { world, tick, rows } = setup()
    world.status = null
    await tick()
    expect(rows.size).toBe(0)
    expect(world.stops).toEqual([])
  })

  it('says minutes in words', () => {
    expect(runTimeLimitMessage(60_000)).toBe('Stopped after its limit of 1 minute of running time.')
    expect(runTimeLimitMessage(45 * 60_000)).toBe('Stopped after its limit of 45 minutes of running time.')
  })
})
