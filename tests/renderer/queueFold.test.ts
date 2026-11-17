import { describe, expect, it } from 'vitest'
import { QUEUE_FOLD_SHARE, queueFoldCount, queueFoldLimit } from '../../src/renderer/lib/queueFold'

describe('queueFoldLimit', () => {
  it('is a third of the visible transcript', () => {
    expect(QUEUE_FOLD_SHARE).toBeCloseTo(1 / 3)
    expect(queueFoldLimit(900)).toBeCloseTo(300)
  })

  it('is 0 for a transcript with no visible height', () => {
    expect(queueFoldLimit(0)).toBe(0)
    expect(queueFoldLimit(-40)).toBe(0)
  })
})

describe('queueFoldCount', () => {
  it('shows every message while together they fit', () => {
    expect(queueFoldCount([60, 60, 60], 300)).toBe(3)
    expect(queueFoldCount([100, 100, 100], 300)).toBe(3)
  })

  it('folds on height, not on how many messages there are', () => {
    expect(queueFoldCount(Array(8).fill(30), 300)).toBe(8)
    expect(queueFoldCount([200, 200], 300)).toBe(1)
  })

  it('shows the whole messages that fit from the top, never one cut in half', () => {
    expect(queueFoldCount([80, 90, 100, 40], 300)).toBe(3)
    expect(queueFoldCount([80, 90, 140, 40], 300)).toBe(2)
  })

  it('stops at the first message that does not fit, even when a later one would', () => {
    expect(queueFoldCount([100, 250, 20], 300)).toBe(1)
  })

  it('always shows at least one message, however tall', () => {
    expect(queueFoldCount([600, 40], 300)).toBe(1)
    expect(queueFoldCount([600], 300)).toBe(1)
  })

  it('does not fold for subpixel rounding', () => {
    expect(queueFoldCount([100.2, 100.2, 99.9], 300)).toBe(3)
  })

  it('a message added to a queue that fit never hides one that was showing', () => {
    const before = [90, 100, 100]
    expect(queueFoldCount(before, 300)).toBe(3)
    expect(queueFoldCount([...before, 200], 300)).toBe(3)
  })

  it('folds nothing until the transcript is measured', () => {
    expect(queueFoldCount([400, 400, 400], 0)).toBe(3)
    expect(queueFoldCount([], 300)).toBe(0)
  })
})
