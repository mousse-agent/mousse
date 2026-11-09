import type { ProviderUsage, UsageSlot } from '../../shared/providerAuth'
import { formatUsd, orderUsageWindows, remainingPercent } from './subscriptionUsage'

/**
 * Where a provider goes on the Usage page: its card among the subscriptions (plan limits that are
 * working), a slim row in Other usage (credit balances, API keys, no usage data), or a dimmed row
 * in Needs attention (signed out, a sign-in or key that has to be redone, no subscription, no answer).
 */
export type UsageSection = 'subscription' | 'other' | 'attention'

/** The reader's own note for a provider it has no usage reader for. */
const UNSUPPORTED = 'Usage information is not available for this provider.'

/** A provider the page has no usage reader for: listed among Other usage as "No usage data", not as a problem. */
export function usageUnsupported(provider: Pick<ProviderUsage, 'status' | 'windows' | 'message' | 'credit'>): boolean {
  return provider.status === 'unavailable' && provider.windows.length === 0 && !provider.credit && provider.message === UNSUPPORTED
}

export function usageSection(provider: ProviderUsage): UsageSection {
  if (provider.signedOut || provider.problem === 'no_subscription' || provider.status === 'error') return 'attention'
  if (provider.credit || usageUnsupported(provider) || provider.authType === 'api_key') return 'other'
  return 'subscription'
}

/** Where a provider whose usage has not arrived yet waits: from what the list already says of it. */
export function slotSection(slot: Pick<UsageSlot, 'authType' | 'signedOut'>): UsageSection {
  if (slot.signedOut) return 'attention'
  return slot.authType === 'api_key' ? 'other' : 'subscription'
}

export interface AttentionReason {
  /** A few words: "Signed out", "Session expired", "No subscription". */
  text: string
  /** Whether Reconnect (the provider's settings) can fix it. */
  reconnect: boolean
  /** Order in the list: things to fix first, no subscription last. */
  rank: number
}

export function attentionReason(provider: ProviderUsage): AttentionReason {
  if (provider.signedOut) return { text: 'Signed out', reconnect: true, rank: 0 }
  switch (provider.problem) {
    case 'session_expired': return { text: 'Session expired', reconnect: true, rank: 0 }
    case 'key_expired': return { text: 'Key expired', reconnect: true, rank: 0 }
    case 'key_rejected': return { text: 'Key rejected', reconnect: true, rank: 0 }
    case 'no_subscription': return { text: 'No subscription', reconnect: false, rank: 2 }
    default: break
  }
  const message = provider.message ?? ''
  if (/^Not reachable/.test(message)) return { text: 'Not reachable', reconnect: false, rank: 1 }
  if (/refresh/i.test(message) && /login|sign/i.test(message)) return { text: 'Login refresh failed', reconnect: true, rank: 0 }
  return { text: 'Usage unavailable', reconnect: false, rank: 1 }
}

/** The settings entry that signs a provider in again: its instance id in Settings → Providers. */
export function usageInstanceId(providerId: string): string {
  if (providerId === 'claude-subscription') return 'claude'
  if (providerId === 'codex' || providerId.includes(':')) return providerId
  return `pi:${providerId}`
}

/** An Other usage row's figure: "$12.40 left · $37.60 used", "58% left · Weekly limit", or "No usage data". */
export function otherUsageFigure(provider: ProviderUsage): { text: string; remaining?: number } {
  if (provider.credit) {
    const { balanceUsd, usedUsd, limitUsd } = provider.credit
    const remaining = limitUsd && limitUsd > 0 ? Math.max(0, Math.min(100, Math.round((balanceUsd / limitUsd) * 100))) : undefined
    return { text: `${formatUsd(balanceUsd)} left${usedUsd !== undefined ? ` · ${formatUsd(usedUsd)} used` : ''}`, ...(remaining !== undefined ? { remaining } : {}) }
  }
  const windows = orderUsageWindows(provider.windows).map((window) => ({ window, left: remainingPercent(window) })).filter((entry) => entry.left !== undefined)
  if (windows.length) {
    // The tightest window says most about what is left.
    const tightest = windows.reduce((low, entry) => (entry.left! < low.left! ? entry : low))
    return { text: `${tightest.left}% left · ${tightest.window.label}`, remaining: tightest.left! }
  }
  return { text: 'No usage data' }
}

/** Needs attention, things to fix first and "No subscription" last; the same rank keeps the page's order. */
export function orderAttention<T extends { provider: ProviderUsage }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => ({ row, index, rank: attentionReason(row.provider).rank }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ row }) => row)
}

const SECTION_KEY = 'mousse.usage.section.'

/** Whether a section was left open; undefined when the person never chose (its default applies). */
export function rememberedSectionOpen(section: 'other' | 'attention'): boolean | undefined {
  try {
    const value = localStorage.getItem(SECTION_KEY + section)
    return value === 'open' ? true : value === 'closed' ? false : undefined
  } catch {
    return undefined
  }
}

export function rememberSectionOpen(section: 'other' | 'attention', open: boolean): void {
  try {
    localStorage.setItem(SECTION_KEY + section, open ? 'open' : 'closed')
  } catch {
    // No storage: the choice lasts while the page is open.
  }
}
