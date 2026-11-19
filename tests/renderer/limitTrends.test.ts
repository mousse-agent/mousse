import { describe, expect, it } from 'vitest'
import { trendBucketStarts, trendValues } from '../../src/renderer/lib/limitTrends'

/** A limit's readings as one value per step of the chart. */
describe('limit trend steps', () => {
  const starts = [0, 10, 20, 30]
  // A reading before the range, two in the second step (the second lower), a reset in the third.
  const points: Array<[number, number]> = [[-5, 40], [12, 60], [15, 20], [25, 0]]

  it("takes the 5-hour window's peak in each step, the weekly window's last reading", () => {
    expect(trendValues({ id: 'five_hour', points }, starts, 35)).toEqual([40, 60, 20, 0])
    expect(trendValues({ id: 'seven_day', points }, starts, 35)).toEqual([40, 20, 0, 0])
  })

  it('keeps the last reading through steps without one, and has none before the first', () => {
    expect(trendValues({ id: 'seven_day', points: [[22, 5]] }, starts, 35)).toEqual([null, null, 5, 5])
    expect(trendValues({ id: 'seven_day', points: [] }, starts, 35)).toEqual([null, null, null, null])
  })

  it('steps by quarter hours across a day, hours across a week and local days across a month, the last holding now', () => {
    const now = new Date(2026, 10, 19, 14, 37, 12).getTime()
    const day = trendBucketStarts('24h', now)
    expect(day).toHaveLength(96)
    expect(day[95]).toBe(new Date(2026, 10, 19, 14, 30).getTime())
    expect(day[1]! - day[0]!).toBe(15 * 60_000)
    expect(trendBucketStarts('7d', now)[167]).toBe(new Date(2026, 10, 19, 14).getTime())
    const month = trendBucketStarts('30d', now)
    expect(month).toHaveLength(30)
    expect(month.map((ms) => new Date(ms).getHours())).toEqual(Array(30).fill(0))
    expect(month[0]).toBe(new Date(2026, 9, 21).getTime())
  })
})
