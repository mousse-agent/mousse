import type { LimitTrendRange, LimitTrendWindow } from '../../shared/limitTrends'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The trend's steps: a quarter hour across a day, an hour across a week, a day across a month. */
export const TREND_BUCKETS: Record<LimitTrendRange, { count: number; ms: number }> = {
  '24h': { count: 96, ms: 15 * MINUTE },
  '7d': { count: 168, ms: HOUR },
  '30d': { count: 30, ms: 24 * HOUR }
}

/** When each step of the range starts, oldest first, on the local clock's quarter hours, hours or days; the last holds now. */
export function trendBucketStarts(range: LimitTrendRange, now: number): number[] {
  const { count, ms } = TREND_BUCKETS[range]
  const last = new Date(now)
  if (range === '30d') last.setHours(0, 0, 0, 0)
  else if (range === '7d') last.setMinutes(0, 0, 0)
  else last.setMinutes(Math.floor(last.getMinutes() / 15) * 15, 0, 0)
  if (range !== '30d') return Array.from({ length: count }, (_, i) => last.getTime() - (count - 1 - i) * ms)
  // Days step by the calendar, so a daylight-saving change keeps them on midnight.
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(last)
    day.setDate(day.getDate() - (count - 1 - i))
    return day.getTime()
  })
}

/**
 * One window's readings as one value per step: the 5-hour window's peak in it (a step long enough holds several
 * of its windows), the weekly window's last reading. A step without a reading keeps the one before; steps before
 * the first reading have none.
 */
export function trendValues(window: Pick<LimitTrendWindow, 'id' | 'points'>, starts: readonly number[], now: number): Array<number | null> {
  const peak = window.id === 'five_hour'
  const values: Array<number | null> = []
  let carried: number | null = null
  let p = 0
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]! : now + 1
    let value = carried
    while (p < window.points.length && window.points[p]![0] < end) {
      const used = window.points[p]![1]
      // Readings before the first step only set where the line starts.
      if (window.points[p]![0] >= starts[i]!) value = peak && value !== null ? Math.max(value, used) : used
      else value = used
      carried = used
      p++
    }
    values.push(value)
  }
  return values
}
