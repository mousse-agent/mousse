/** How the 5-hour and weekly limits moved over time, from the readings Mousse kept of them. */

export type LimitTrendRange = '24h' | '7d' | '30d'
export const LIMIT_TREND_RANGES: readonly LimitTrendRange[] = ['24h', '7d', '30d']
export type LimitTrendWindowId = 'five_hour' | 'seven_day'

export interface LimitTrendWindow {
  id: LimitTrendWindowId
  label: string
  /** [time in ms, share used in %], oldest first. */
  points: Array<[number, number]>
  /** When the window reset, in ms. */
  resets: number[]
  /** When the current window resets, if one is running. */
  nextReset?: number
}

export interface LimitTrend {
  /** The provider, or `provider#account` for one sign-in of a provider that reads several. */
  id: string
  label: string
  windows: LimitTrendWindow[]
}

export interface LimitTrendsResponse { trends: LimitTrend[] }

/** How long each window lasts, for its even-pace line. */
export const LIMIT_WINDOW_MS: Record<LimitTrendWindowId, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000
}

export const LIMIT_TREND_SPAN_MS: Record<LimitTrendRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000
}
