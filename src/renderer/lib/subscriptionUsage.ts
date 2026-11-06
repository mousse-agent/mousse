import type { ProviderUsageWindow } from '../../shared/providerAuth'

/** Below this share left, the percentage takes the warning colour. */
export const USAGE_LOW_PERCENT = 20

/**
 * The share of a window that is left, as the provider reported it: a whole percent from 0 to 100,
 * or undefined when the provider sent no usable number. Unknown never becomes 0 or 100.
 */
export function remainingPercent(window: Pick<ProviderUsageWindow, 'remainingPercent'>): number | undefined {
  const value = window.remainingPercent as unknown
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

export type UsageTone = 'ok' | 'low' | 'empty'

export function usageTone(remaining: number): UsageTone {
  return remaining <= 0 ? 'empty' : remaining < USAGE_LOW_PERCENT ? 'low' : 'ok'
}

/** "resets in 2h 5m", "resets soon", or undefined when the provider did not say when. */
export function formatUsageReset(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return undefined
  const totalMinutes = Math.floor((at - now) / 60_000)
  if (totalMinutes < 1) return 'resets soon'
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days === 0) return `resets in ${hours}h ${minutes}m`
  return `resets in ${days}d ${hours}h`
}

/** One window in one line: "62% left · 5-hour limit · resets in 2h 5m". */
export function usageWindowLine(window: ProviderUsageWindow, now: number): string {
  const remaining = remainingPercent(window)
  return [
    remaining === undefined ? 'Unknown' : `${remaining}% left`,
    window.label,
    formatUsageReset(window.resetsAt, now)
  ].filter(Boolean).join(' · ')
}

/** The clock time of a reading, for "Showing usage from 14:05". */
export function usageReadingTime(fetchedAt: string | undefined): string | undefined {
  if (!fetchedAt) return undefined
  const at = new Date(fetchedAt)
  if (Number.isNaN(at.getTime())) return undefined
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
