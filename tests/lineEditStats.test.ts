import { describe, expect, it } from 'vitest'
import {
  buildHeatmapGrid,
  buildLineEditSnapshot,
  countLineEdits,
  mergeDayRecord,
  toDateKey
} from '../src/shared/lineEditStats'

describe('countLineEdits', () => {
  it('counts changed and added lines', () => {
    expect(countLineEdits('a\nb', 'a\nc\nd')).toBe(2)
    expect(countLineEdits('', 'one\ntwo')).toBe(2)
    expect(countLineEdits('same', 'same')).toBe(0)
  })
})

describe('buildLineEditSnapshot', () => {
  it('aggregates totals and streaks', () => {
    const days = {
      '2026-06-26': { orchestrator: 10, manual: 0 },
      '2026-06-27': { orchestrator: 5, manual: 2 },
      '2026-06-28': { orchestrator: 0, manual: 8 }
    }
    const snapshot = buildLineEditSnapshot(days, new Date('2026-06-28T12:00:00'))
    expect(snapshot.total).toBe(25)
    expect(snapshot.totalTab).toBe(15)
    expect(snapshot.totalAgent).toBe(10)
    expect(snapshot.longestStreak).toBe(3)
    expect(snapshot.currentStreak).toBe(3)
    expect(snapshot.mostActiveMonth).toBe('June')
  })
})

describe('buildHeatmapGrid', () => {
  it('builds week columns with intensity levels', () => {
    const days = mergeDayRecord({}, toDateKey(new Date()), 'orchestrator', 40)
    const { weeks, maxCount } = buildHeatmapGrid(days, 'all', new Date(), 4)
    expect(maxCount).toBe(40)
    expect(weeks.length).toBeGreaterThan(0)
    const filled = weeks.flatMap((week) => week.days).filter((cell) => cell && cell.count > 0)
    expect(filled.length).toBeGreaterThan(0)
  })
})
