import type { ProviderUsage } from '../../../shared/providerAuth'
import { formatUsd, orderUsageWindows, remainingNow, summarizeAccounts } from '../../lib/subscriptionUsage'
import { activeAccountsLabel } from '../UsageAccountsView'

/**
 * What a bot header's model button shows of the usage of the provider the bot talks on: a ring for the share left of
 * the limit with the least left (or of a spend budget), and a tooltip naming each. Only the readings the service keeps
 * are used; no ring never stands for 100%.
 */

/** The usage page's id for Claude: its limits count only as the CLI API proxy reads them. */
export const CLAUDE_USAGE_ID = 'claude-subscription'

/** One limit of the provider: its name ("5-hour", "Weekly"), the share left and when it resets. */
export interface BotUsageLimit {
  label: string
  left: number
  resetsAt?: string
}

/**
 * Whether a limit counts for `model`: every limit does, except a model's own weekly ("Weekly · Fable", id
 * `seven_day_<name>` or `model_<name>`), which counts only while that model is the one picked. A surface's weekly
 * ("Weekly · Cowork") names no model, so it never counts.
 */
export function limitApplies(id: string, label: string, model: string): boolean {
  const bare = id.replace(/^\d+:/, '')
  if (!bare.startsWith('seven_day_') && !bare.startsWith('model_')) return true
  const scope = (label.split('·').at(-1) ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
  return scope !== '' && model.toLowerCase().includes(scope)
}

/**
 * The provider's limits that count for `model`, shortest first, each with a number. A provider read through several
 * accounts (the Claude CLI API proxy) gives each limit pooled across them, as the Usage page shows it; any other gives
 * its own windows. Empty when nothing reports a number.
 */
export function usageLimits(usage: ProviderUsage, now: number, model: string): BotUsageLimit[] {
  if (usage.accounts?.length) {
    return summarizeAccounts(usage.accounts, now).flatMap((summary) => summary.remaining === undefined || !limitApplies(summary.id, summary.heading, model) ? []
      : [{ label: summary.heading, left: summary.remaining, ...(summary.resetsAt ? { resetsAt: summary.resetsAt } : {}) }])
  }
  if (usage.status !== 'available') return []
  return orderUsageWindows(usage.windows).flatMap((window) => {
    const left = remainingNow(window, now)
    return left === undefined || !limitApplies(window.id, window.label, model) ? [] : [{ label: window.label, left, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) }]
  })
}

/** When a limit resets, in words: the time today ("3:40 PM"), else the day ("Mon"). */
export function resetWords(resetsAt: string, now: number): string | undefined {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return undefined
  if (at.getTime() <= now) return 'now'
  return at.toDateString() === new Date(now).toDateString()
    ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString([], { weekday: 'short' })
}

/** One line per limit: "5-hour: 72% left, resets 3:40 PM", then "Weekly: 41% left, resets Mon". */
export function usageTooltip(limits: readonly BotUsageLimit[], now: number): string {
  return limits.map((limit) => {
    const reset = limit.resetsAt ? resetWords(limit.resetsAt, now) : undefined
    return `${limit.label}: ${Math.round(limit.left)}% left${reset ? `, resets ${reset}` : ''}`
  }).join('\n')
}

/** The ring's share left (none: nothing to measure) and the tooltip. */
export interface BotUsageReading {
  left?: number
  tooltip: string
}

export const NO_USAGE_INFO = 'No usage info'

/** A reading older than this says when it is from: twice the refresh, so one missed refresh is not mentioned. */
export const STALE_AFTER_MS = 10 * 60_000

/** "as of 22:09" for a reading from today, "as of Mon 22:09" for an older one; nothing while it is fresh. */
export function staleNote(readAt: string | undefined, now: number): string | undefined {
  const at = readAt ? Date.parse(readAt) : Number.NaN
  if (Number.isNaN(at) || now - at < STALE_AFTER_MS) return undefined
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `as of ${date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`}`
}

/**
 * The ring and tooltip for a provider's kept reading. Limit windows: the ring on the one with the least left, each
 * named in the tooltip (pooled ones say how many accounts count). A key with a spend budget: the ring on what is left
 * of it ("$12.40 of $50 left"). A key without one: no ring, and what was spent when known. Claude without the CLI API
 * proxy's numbers, a proxy or provider that reports nothing, or no reading: no ring and "No usage info". A reading
 * older than `STALE_AFTER_MS` keeps its numbers and says when it is from.
 */
export function usageReading(usage: ProviderUsage | undefined, now: number, model: string): BotUsageReading {
  if (!usage) return { tooltip: NO_USAGE_INFO }
  // Claude's limits count only as the CLI API proxy reads them (as its limit trends do).
  if (usage.id === CLAUDE_USAGE_ID && !usage.proxy && !usage.accounts?.length) return { tooltip: NO_USAGE_INFO }
  const reading = shownReading(usage, now, model)
  const note = reading.tooltip === NO_USAGE_INFO ? undefined : staleNote(usage.readAt, now)
  return note ? { ...reading, tooltip: `${reading.tooltip}\n${note}` } : reading
}

/**
 * The reading to show when a new one comes: a read that failed (not reachable, timed out) keeps the numbers shown
 * before, which then say when they are from once they are old; any other replaces them.
 */
export function nextReading(previous: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  return next.status === 'error' && !next.accounts?.length && previous && previous.status !== 'error' ? previous : next
}

function shownReading(usage: ProviderUsage, now: number, model: string): BotUsageReading {
  const limits = usageLimits(usage, now, model)
  if (limits.length) {
    const pooled = usage.accounts?.length ? `\n${activeAccountsLabel(usage.accounts)}` : ''
    return { left: Math.min(...limits.map((limit) => limit.left)), tooltip: usageTooltip(limits, now) + pooled }
  }
  if (usage.status !== 'available') return { tooltip: NO_USAGE_INFO }
  const credit = usage.credit
  if (credit?.limitUsd && credit.limitUsd > 0) {
    return { left: Math.max(0, Math.min(100, (credit.balanceUsd / credit.limitUsd) * 100)), tooltip: `${formatUsd(credit.balanceUsd)} of ${formatUsd(credit.limitUsd)} left` }
  }
  if (credit?.usedUsd !== undefined) return { tooltip: `${formatUsd(credit.usedUsd)} spent so far` }
  return { tooltip: NO_USAGE_INFO }
}
