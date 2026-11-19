import type { ProviderUsageWindow } from '../../shared/providerAuth'

const HOUR = 3_600_000

/** How long a limit window lasts, from its id; undefined for a window whose length isn't known. */
function windowLength(id: string, resetsAt: number): number | undefined {
  if (id === 'five_hour' || id === 'rolling') return 5 * HOUR
  if (id.startsWith('seven_day') || id === 'weekly') return 7 * 24 * HOUR
  if (id === 'monthly') {
    const start = new Date(resetsAt)
    start.setMonth(start.getMonth() - 1)
    return resetsAt - start.getTime()
  }
  return undefined
}

/**
 * The share that would be left now if the window's limit were used evenly from its start to its reset: 100 at
 * the start, 0 at the reset. Undefined when the window's length or reset time isn't known.
 */
export function paceRemaining(window: Pick<ProviderUsageWindow, 'id' | 'resetsAt'>, now: number): number | undefined {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return undefined
  const length = windowLength(window.id, resetsAt)
  if (!length) return undefined
  const elapsed = (now - (resetsAt - length)) / length
  return Math.round(Math.min(1, Math.max(0, 1 - elapsed)) * 1000) / 10
}
