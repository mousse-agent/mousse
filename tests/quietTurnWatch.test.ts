/**
 * The quiet-turn watch (#1042): a window whose shown turn looks active but hears nothing is checked against the service
 * after 30 seconds, then less and less often while the turn is really running; any update starts the wait again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIET_TURN_MAX_MS, QUIET_TURN_MS, QuietTurnWatch } from '../src/main/mms/quietTurnWatch'

describe('QuietTurnWatch', () => {
  let quiet: Array<{ windowId: number; threadId: string }>
  let watch: QuietTurnWatch

  beforeEach(() => {
    vi.useFakeTimers()
    quiet = []
    watch = new QuietTurnWatch({ onQuiet: (windowId, threadId) => quiet.push({ windowId, threadId }) })
  })
  afterEach(() => {
    watch.dispose()
    vi.useRealTimers()
  })

  it('checks a turn that looks active 30 seconds after its last update, not before', () => {
    watch.setShown(1, 't1', true)
    vi.advanceTimersByTime(QUIET_TURN_MS - 1)
    expect(quiet).toEqual([])
    vi.advanceTimersByTime(1)
    expect(quiet).toEqual([{ windowId: 1, threadId: 't1' }])
  })

  it('an update about the shown thread starts the wait again; one about another thread does not', () => {
    watch.setShown(1, 't1', true)
    vi.advanceTimersByTime(20_000)
    watch.touch(1, 't1')
    vi.advanceTimersByTime(20_000)
    expect(quiet).toEqual([])
    watch.touch(1, 'other')
    vi.advanceTimersByTime(10_000)
    expect(quiet).toHaveLength(1)
  })

  it('a turn that is not active, or no thread, is never checked', () => {
    watch.setShown(1, 't1', false)
    watch.setShown(2, null, true)
    vi.advanceTimersByTime(60 * 60_000)
    expect(quiet).toEqual([])
  })

  it('a turn that ends stops the watch; one that starts later counts from its own start', () => {
    watch.setShown(1, 't1', true)
    vi.advanceTimersByTime(25_000)
    watch.setShown(1, 't1', false)
    vi.advanceTimersByTime(60_000)
    expect(quiet).toEqual([])
    watch.setShown(1, 't1', true)
    vi.advanceTimersByTime(QUIET_TURN_MS - 1)
    expect(quiet).toEqual([])
    vi.advanceTimersByTime(1)
    expect(quiet).toHaveLength(1)
  })

  it('a long silent turn that is really running is checked four times in ten minutes, backing off to five minutes', () => {
    watch.setShown(1, 't1', true)
    const checkedAt: number[] = []
    const start = Date.now()
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000)
      while (quiet.length) {
        quiet.shift()
        checkedAt.push(Date.now() - start)
        // The service says the turn is still running and the window is current.
        watch.checked(1)
      }
    }
    expect(checkedAt).toEqual([30_000, 90_000, 210_000, 450_000])
    // Never more often than every five minutes after that.
    for (let i = 0; i < 4; i += 1) watch.checked(1)
    expect(watch.waitOf(1)).toBe(QUIET_TURN_MAX_MS)
  })

  it('switching to another thread drops the pending check of the one left', () => {
    watch.setShown(1, 't1', true)
    vi.advanceTimersByTime(20_000)
    watch.setShown(1, 't2', false)
    vi.advanceTimersByTime(60_000)
    expect(quiet).toEqual([])
    watch.forget(1)
    expect(watch.isArmed(1)).toBe(false)
  })
})
