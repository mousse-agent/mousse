import { codexErrorKind, codexHttpStatus, type CodexErrorInfo, type RateLimitSnapshot, type RateLimitWindow } from './protocol'

/** The limit the windows of a snapshot stand for. `resetsAt` (epoch seconds) is absent when the server did not report every exhausted window's reset. */
export interface CodexLimitReset {
  limitKind?: string
  resetsAt?: number
}

/** Codex names its windows by length: a 5-hour and a weekly one. */
function windowKind(window: RateLimitWindow, slot: 'primary' | 'secondary'): string {
  const minutes = window.windowDurationMins
  if (minutes === 300) return 'five_hour'
  if (minutes === 10_080) return 'seven_day'
  return slot
}

/**
 * The reset of the windows at or over their limit: the latest one, so the run does not resume while
 * one window still blocks it. A snapshot with no exhausted window says nothing, and an exhausted
 * window that reports no reset leaves the reset unknown.
 */
export function resetFromSnapshot(snapshot: RateLimitSnapshot | null | undefined, nowMs: number): CodexLimitReset | undefined {
  const exhausted = (['primary', 'secondary'] as const)
    .map((slot) => ({ slot, window: snapshot?.[slot] }))
    .filter((entry): entry is { slot: 'primary' | 'secondary'; window: RateLimitWindow } => !!entry.window && entry.window.usedPercent >= 100)
  if (!exhausted.length) return undefined
  const unreported = exhausted.find(({ window }) => typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt) || window.resetsAt * 1000 <= nowMs)
  if (unreported) return { limitKind: windowKind(unreported.window, unreported.slot) }
  const latest = exhausted.reduce((best, entry) => (entry.window.resetsAt! > best.window.resetsAt! ? entry : best))
  return { limitKind: windowKind(latest.window, latest.slot), resetsAt: latest.window.resetsAt! }
}

/** A turn error Codex itself classifies as a plan usage limit (or the 429 behind too many failed attempts). */
export function isUsageLimitInfo(info: CodexErrorInfo | null | undefined): boolean {
  const kind = codexErrorKind(info)
  if (kind === 'usageLimitExceeded' || kind === 'rateLimitExceeded') return true
  return kind === 'responseTooManyFailedAttempts' && codexHttpStatus(info) === 429
}

/** Older servers send no structured kind; their message is all there is. */
export function isUsageLimitText(message: string | undefined): boolean {
  return /usage limit|rate limit/i.test(message ?? '')
}
