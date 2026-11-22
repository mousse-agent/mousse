import { describe, expect, it } from 'vitest'
import { pickForTiming, summarizeSizes } from '../.agents/skills/check-on-real-data/real-threads'

describe('real-thread report helpers', () => {
  it('summarises sizes without thread identity', () => {
    expect(summarizeSizes([5, 1, 9, 3, 7, 11, 2], 3)).toEqual({ count: 7, min: 1, median: 5, p90: 11, max: 11, largest: [11, 9, 7] })
    expect(summarizeSizes([])).toEqual({ count: 0, min: 0, median: 0, p90: 0, max: 0, largest: [] })
  })

  it('picks the largest, the median and the smallest threads once each, with anonymous labels', () => {
    const picks = pickForTiming([10, 50, 20, 40, 30, 60, 5], 3)
    expect(picks).toEqual([
      { label: 'largest #1', index: 5 },
      { label: 'largest #2', index: 1 },
      { label: 'largest #3', index: 3 },
      { label: 'median', index: 4 },
      { label: 'smallest', index: 6 }
    ])
    expect(pickForTiming([4, 9], 5)).toEqual([{ label: 'largest #1', index: 1 }, { label: 'largest #2', index: 0 }])
    expect(pickForTiming([])).toEqual([])
  })
})
