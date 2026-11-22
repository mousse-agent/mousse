/**
 * A turn's no-progress check (`watchTurnProgress`): a turn has no limit on its total time, and ends only once its
 * runtime has said nothing for the stall window. Inputs: silence, progress, a person being asked, the computer sleeping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchTurnProgress } from '../src/mms/orchestrator/turnStall'

const TICK = 1_000
const STALL = 10 * TICK

describe('the no-progress check of a turn', () => {
  let now = 0
  let waiting = false
  let stalls: number[] = []
  let stop: () => void = () => {}
  const watch = () => {
    const watcher = watchTurnProgress({ stallMs: STALL, tickMs: TICK, waiting: () => waiting, onStall: (ms) => stalls.push(ms), now: () => now })
    stop = watcher.stop
    return watcher
  }
  const pass = (ms: number) => {
    for (let gone = 0; gone < ms; gone += TICK) {
      now += TICK
      vi.advanceTimersByTime(TICK)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    now = 0
    waiting = false
    stalls = []
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('ends a turn silent for the window, once', () => {
    watch()
    pass(STALL - TICK)
    expect(stalls).toEqual([])
    pass(TICK)
    expect(stalls).toEqual([STALL])
    pass(STALL)
    expect(stalls).toHaveLength(1)
  })

  it('keeps a turn that makes progress going however long it runs', () => {
    const watcher = watch()
    for (let hour = 0; hour < 100; hour += 1) {
      pass(STALL - TICK)
      watcher.progress()
    }
    expect(stalls).toEqual([])
  })

  it('never counts the time a person is being asked, and counts afresh once they answered', () => {
    watch()
    waiting = true
    pass(STALL * 5)
    waiting = false
    pass(STALL - TICK)
    expect(stalls).toEqual([])
    pass(TICK)
    expect(stalls).toHaveLength(1)
  })

  it('counts a sleep of the computer as no more than two looks', () => {
    watch()
    // The computer sleeps for an hour: the timer fires once on waking, with the clock far ahead.
    now += 60 * 60_000
    vi.advanceTimersByTime(TICK)
    expect(stalls).toEqual([])
    pass(STALL - 3 * TICK)
    expect(stalls).toEqual([])
    pass(TICK)
    expect(stalls).toHaveLength(1)
  })
})
