import { describe, expect, it } from 'vitest'
import { paceRemaining } from '../../src/renderer/lib/usagePace'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const resets = (ms: number) => new Date(NOW + ms).toISOString()
const HOUR = 3_600_000

describe('even pace on a limit', () => {
  it('is the share that would be left now if the window were used evenly to its reset', () => {
    // 2 of 5 hours to go: 40% would be left.
    expect(paceRemaining({ id: 'five_hour', resetsAt: resets(2 * HOUR) }, NOW)).toBe(40)
    // 3.5 of 7 days to go, for every weekly window.
    for (const id of ['seven_day', 'seven_day_opus', 'weekly']) expect(paceRemaining({ id, resetsAt: resets(84 * HOUR) }, NOW)).toBe(50)
    // A month: from the same day of the month before. Dec 19 to Jan 19 is 31 days; 15.5 to go.
    expect(paceRemaining({ id: 'monthly', resetsAt: '2027-01-19T00:00:00Z' }, Date.parse('2027-01-03T12:00:00Z'))).toBe(50)
  })

  it('has none for a window of unknown length, or without a reset still to come', () => {
    expect(paceRemaining({ id: 'credits', resetsAt: resets(HOUR) }, NOW)).toBeUndefined()
    expect(paceRemaining({ id: 'five_hour' }, NOW)).toBeUndefined()
    expect(paceRemaining({ id: 'five_hour', resetsAt: resets(-HOUR) }, NOW)).toBeUndefined()
  })
})
