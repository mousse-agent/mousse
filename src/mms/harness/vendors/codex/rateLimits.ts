import type { ProviderUsageWindow, UsageResets } from '../../../../shared/providerAuth'
import { codexErrorKind, codexHttpStatus, type CodexErrorInfo, type RateLimitResetCredits, type RateLimitSnapshot, type RateLimitWindow } from './protocol'

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

function windowLabel(window: RateLimitWindow, slot: 'primary' | 'secondary'): string {
  const minutes = window.windowDurationMins
  if (minutes === 300) return '5-hour limit'
  if (minutes === 10_080) return 'Weekly limit'
  if (minutes && minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour limit`
  return slot === 'primary' ? 'Usage limit' : 'Secondary usage limit'
}

/**
 * The reset credits of a read reply, trimmed to what Mousse keeps: the available count and, per
 * credit, its type, status, title and expiry (no ids). Undefined for anything else.
 */
export function trimResetCredits(value: unknown): RateLimitResetCredits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const count = raw.availableCount
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 1_000) return undefined
  const text = (entry: unknown) => (typeof entry === 'string' && entry.trim() && entry.length <= 120 ? entry.trim() : undefined)
  const credits = (Array.isArray(raw.credits) ? raw.credits : []).slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const credit = item as Record<string, unknown>
    const expires = credit.expiresAt
    const kept = {
      ...(text(credit.resetType) ? { resetType: text(credit.resetType) } : {}),
      ...(text(credit.status) ? { status: text(credit.status) } : {}),
      ...(text(credit.title) ? { title: text(credit.title) } : {}),
      ...(typeof expires === 'number' && Number.isFinite(expires) && expires > 0 ? { expiresAt: expires } : {})
    }
    return [kept]
  })
  return { availableCount: count, ...(credits.length ? { credits } : {}) }
}

/** The usage page's resets for a snapshot: what Codex reports available, with each credit's expiry. */
export function snapshotResets(snapshot: RateLimitSnapshot | null | undefined): UsageResets | undefined {
  const credits = snapshot?.rateLimitResetCredits
  if (!credits) return undefined
  // Codex sends epoch seconds; a value that large is already milliseconds.
  const iso = (at: number) => new Date(at > 1e12 ? at : at * 1000).toISOString()
  return {
    available: credits.availableCount,
    ...(credits.credits?.length ? {
      credits: credits.credits.map((credit) => ({
        ...(credit.title ? { title: credit.title } : {}),
        ...(credit.resetType ? { type: credit.resetType } : {}),
        ...(credit.status ? { status: credit.status } : {}),
        ...(credit.expiresAt ? { expiresAt: iso(credit.expiresAt) } : {})
      }))
    } : {})
  }
}

/** The plan a snapshot's limits belong to, named as ChatGPT does ("Plus", "Pro"), when Codex says. */
export function snapshotPlan(snapshot: RateLimitSnapshot | null | undefined): string | undefined {
  const plan = snapshot?.planType
  if (typeof plan !== 'string' || !/^[a-z_]{1,32}$/i.test(plan) || plan === 'unknown') return undefined
  return plan.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

/** The usage page's windows for a snapshot: what is left of each limit and when it resets. */
export function usageWindows(snapshot: RateLimitSnapshot | null | undefined): ProviderUsageWindow[] {
  return (['primary', 'secondary'] as const).flatMap((slot) => {
    const window = snapshot?.[slot]
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return []
    const reset = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : undefined
    return [{
      id: windowKind(window, slot),
      label: windowLabel(window, slot),
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      ...(reset && !Number.isNaN(reset.getTime()) ? { resetsAt: reset.toISOString() } : {})
    }]
  })
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

/**
 * The usage page's windows for a snapshot Codex sent at some earlier time. A window whose reset
 * has passed since then has started over: it reads as all left, with no reset time.
 */
export function reportedUsageWindows(snapshot: RateLimitSnapshot | null | undefined, nowMs: number): ProviderUsageWindow[] {
  return usageWindows(snapshot).map((window) => {
    if (!window.resetsAt || Date.parse(window.resetsAt) > nowMs) return window
    const { resetsAt: _passed, ...rest } = window
    return { ...rest, remainingPercent: 100 }
  })
}
