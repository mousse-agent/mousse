import type { ProviderUsage, ProviderUsageWindow, UsageAccount, UsageResets } from '../../shared/providerAuth'

/**
 * The share of a window that is left, as the provider reported it: a whole percent from 0 to 100,
 * or undefined when the provider sent no usable number. Unknown never becomes 0 or 100.
 */
export function remainingPercent(window: Pick<ProviderUsageWindow, 'remainingPercent'>): number | undefined {
  const value = window.remainingPercent as unknown
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** What is left of a window now: a window whose reset has passed has started over (100% left). */
export function remainingNow(window: Pick<ProviderUsageWindow, 'remainingPercent' | 'resetsAt'>, now: number): number | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  if (!Number.isNaN(reset) && reset <= now) return 100
  return remainingPercent(window)
}

/** Below this share left, the bar starts to take on the theme's red; at nothing left it has this much. */
export const USAGE_RED_FROM = 35
export const USAGE_RED_MAX = 55

/** How much red (percent, for `color-mix`) the bar takes at this share left: none while plenty remains. */
export function usageRedMix(remaining: number): number {
  if (remaining >= USAGE_RED_FROM) return 0
  return Math.round(((USAGE_RED_FROM - Math.max(0, remaining)) / USAGE_RED_FROM) * USAGE_RED_MAX)
}

/**
 * A window's place by its length, from its id: 5-hour, the overall weekly, then weekly windows scoped
 * to a model or surface; unknown lengths after them, extra usage last.
 */
function windowMinutes(id: string): number {
  const bare = id.replace(/^\d+:/, '')
  if (bare === 'five_hour') return 300
  if (bare === 'seven_day') return 10_080
  if (bare.startsWith('seven_day_') || bare.startsWith('model_')) return 10_081
  if (bare === 'extra_usage') return Number.MAX_SAFE_INTEGER
  return Number.MAX_SAFE_INTEGER - 1
}

/** The windows shortest first (5-hour before weekly); windows of the same length keep their order. */
export function orderUsageWindows<T extends Pick<ProviderUsageWindow, 'id'>>(windows: readonly T[]): T[] {
  return windows.map((window, index) => ({ window, index }))
    .sort((a, b) => windowMinutes(a.window.id) - windowMinutes(b.window.id) || a.index - b.index)
    .map(({ window }) => window)
}

/**
 * Time left as a countdown: "45m" or "1h 12m" under a day; from a day on, days and hours always
 * ("1d 0h", "3d 4h", "6d 23h"), never days alone.
 */
export function formatCountdown(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** Minutes until `resetsAt`, or undefined when it is not a time. */
function minutesUntil(resetsAt: string | undefined, now: number): number | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  return Number.isNaN(at) ? undefined : Math.floor((at - now) / 60_000)
}

/** The line under a bar: "Resets in 1h 12m", "Resets in 3d 4h", "Resets soon", or undefined when the provider did not say. */
export function formatResetLine(resetsAt: string | undefined, now: number): string | undefined {
  const minutes = minutesUntil(resetsAt, now)
  if (minutes === undefined) return undefined
  return minutes < 1 ? 'Resets soon' : `Resets in ${formatCountdown(minutes)}`
}

/** The exact reset on hover: "Resets Thu 16:40 · in 3d 4h". */
export function resetTooltip(resetsAt: string | undefined, now: number): string | undefined {
  const minutes = minutesUntil(resetsAt, now)
  if (minutes === undefined) return undefined
  const date = new Date(resetsAt!)
  const day = date.toLocaleDateString([], { weekday: 'short' })
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `Resets ${day} ${time}${minutes < 1 ? '' : ` · in ${formatCountdown(minutes)}`}`
}

/** A sign-in that is readable now: it has windows and no problem. Expired or failing ones are left out of totals. */
export function accountActive(account: Pick<UsageAccount, 'windows' | 'problem'>): boolean {
  return !account.problem && account.windows.length > 0
}

/** One limit across several accounts: what is left on average, and the soonest reset among them. */
export interface UsageLimitSummary {
  /** The window id (`five_hour`, `seven_day`, `model_fable`). */
  id: string
  /** The table's column heading ("5-hour", "Weekly", "Weekly · Fable"). */
  heading: string
  /** The summary's label ("5-hour · all accounts", "Weekly · Fable · 2 accounts"). */
  label: string
  /** How many active accounts report this limit. */
  accounts: number
  /** The average share left across them, a whole percent; undefined when none has a number. */
  remaining?: number
  /** The soonest reset still ahead among them. */
  resetsAt?: string
  /** What the next reset that changes anything gives back to the pooled share left. */
  gain?: UsageResetGain
}

/** A reset's effect on the pooled share left: the accounts that reset then, and how much they add. */
export interface UsageResetGain {
  /** Percentage points the average gains, a whole number above 0. */
  percent: number
  /** When they reset (the earliest of the group). */
  at: string
  /** The accounts that reset then, each to 100% left. */
  accounts: Array<{ label: string; at: string }>
}

/** Resets this close together count as one moment. */
const RESET_GROUP_MS = 60_000

/**
 * What the soonest reset gives back across the accounts reporting a limit: at that moment every
 * account resetting then goes to 100% left, so the average left rises by the sum of their used shares
 * over all the accounts. A reset that would add nothing (it rounds to 0%) is skipped for the next one.
 */
export function nextResetGain(entries: ReadonlyArray<{ label: string; window: Pick<ProviderUsageWindow, 'remainingPercent' | 'resetsAt'> }>, now: number): UsageResetGain | undefined {
  const known = entries.map((entry) => ({ ...entry, left: remainingNow(entry.window, now), at: entry.window.resetsAt ? Date.parse(entry.window.resetsAt) : Number.NaN }))
  const total = known.length
  if (!total) return undefined
  const ahead = known.filter((entry) => entry.left !== undefined && Number.isFinite(entry.at) && entry.at > now).sort((a, b) => a.at - b.at)
  for (let index = 0; index < ahead.length;) {
    const start = ahead[index]!.at
    const group = ahead.filter((entry) => entry.at >= start && entry.at - start <= RESET_GROUP_MS)
    index += group.length
    const percent = Math.round(group.reduce((sum, entry) => sum + (100 - entry.left!), 0) / total)
    if (percent > 0) return { percent, at: new Date(start).toISOString(), accounts: group.map((entry) => ({ label: entry.label, at: new Date(entry.at).toISOString() })) }
  }
  return undefined
}

function limitHeading(window: Pick<ProviderUsageWindow, 'id' | 'label'>): string {
  if (window.id === 'five_hour') return '5-hour'
  if (window.id === 'seven_day') return 'Weekly'
  return window.label.replace(/ limit$/, '')
}

/**
 * The limits of several accounts, one per window id, in window order: the average left across the
 * active accounts that report it and the soonest reset among them. Accounts with a problem count for
 * nothing.
 */
export function summarizeAccounts(accounts: readonly UsageAccount[], now: number): UsageLimitSummary[] {
  const active = accounts.filter(accountActive)
  const firsts = new Map<string, ProviderUsageWindow>()
  for (const account of active) for (const window of account.windows) if (!firsts.has(window.id)) firsts.set(window.id, window)
  return orderUsageWindows([...firsts.values()]).map((first) => {
    const reporting = active.flatMap((account) => account.windows.filter((window) => window.id === first.id))
    const lefts = reporting.map((window) => remainingNow(window, now)).filter((left): left is number => left !== undefined)
    const resets = reporting.map((window) => window.resetsAt).filter((reset): reset is string => !!reset && Date.parse(reset) > now)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    const heading = limitHeading(first)
    const count = reporting.length
    const gain = nextResetGain(active.flatMap((account) => account.windows.filter((window) => window.id === first.id).map((window) => ({ label: account.label, window }))), now)
    return {
      id: first.id,
      heading,
      label: `${heading} · ${count === active.length ? 'all accounts' : `${count} account${count === 1 ? '' : 's'}`}`,
      accounts: count,
      ...(lefts.length ? { remaining: Math.round(lefts.reduce((sum, left) => sum + left, 0) / lefts.length) } : {}),
      ...(resets[0] ? { resetsAt: resets[0] } : {}),
      ...(gain ? { gain } : {})
    }
  })
}

/** An account's avatar hue, the same for the same account every time. */
export function accountHue(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

/** "2 resets", "1 reset"; undefined at none, so nothing is shown. */
export function resetsLabel(resets: Pick<UsageResets, 'available'> | undefined): string | undefined {
  if (!resets || !Number.isInteger(resets.available) || resets.available <= 0) return undefined
  return `${resets.available} reset${resets.available === 1 ? '' : 's'}`
}

/** Reset types as people read them: the known windows by name, anything else in sentence case. */
const RESET_TYPE_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  weekly: 'Weekly',
  seven_day: 'Weekly',
  // Codex's one kind today: a reset of all its rate limits.
  codexratelimits: 'Codex limits',
  unknown: ''
}

/**
 * "five_hour" → "5-hour", "weekly" / "seven_day" → "Weekly", "codexRateLimits" → "Codex limits",
 * anything else in sentence case ("extra_usage_2" → "Extra usage 2"); "" for an unknown type.
 */
export function resetTypeLabel(type: string): string {
  const known = RESET_TYPE_LABELS[type.trim().toLowerCase()]
  if (known !== undefined) return known
  const words = type.trim().replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type
}

/** What using a reset of this type does, in a few words: "Your Codex limits go back to 100%." and its toast. */
export function resetEffect(type: string | undefined): { sentence: string; done: string } {
  const label = type ? resetTypeLabel(type) : ''
  if (!label) return { sentence: 'Your limits go back to 100%.', done: 'Limits reset' }
  if (/limits$/i.test(label)) return { sentence: `Your ${label} go back to 100%.`, done: `${label} reset` }
  return { sentence: `Your ${label} limit goes back to 100%.`, done: `${label} limit reset` }
}

/** What a reset that did not reset says. */
export function resetOutcomeText(outcome: string): string | undefined {
  switch (outcome) {
    case 'reset': return undefined
    case 'nothingToReset': return 'Nothing to reset'
    case 'noCredit': return 'No resets left'
    case 'alreadyRedeemed': return 'Already used'
    default: return "Couldn't use the reset"
  }
}

/**
 * The chip's tooltip: one line per credit, "<title> · <type> · expires in 5d 0h", from what the
 * provider says; the type is left out when the title already names it ("Weekly limit reset").
 */
export function resetsTooltip(resets: UsageResets, now: number): string | undefined {
  const lines = (resets.credits ?? []).map((credit) => {
    const at = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN
    const expiry = Number.isNaN(at) ? undefined : at <= now ? 'expired' : `expires in ${formatCountdown(Math.floor((at - now) / 60_000))}`
    const type = credit.type ? resetTypeLabel(credit.type) : undefined
    const named = type && credit.title?.toLowerCase().includes(type.toLowerCase())
    return [credit.title, named ? undefined : type, expiry].filter(Boolean).join(' · ')
  }).filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

/** The resets of several accounts together, for "3 resets across accounts". */
export function totalResets(accounts: ReadonlyArray<{ resets?: UsageResets }>): number {
  return accounts.reduce((sum, account) => sum + (account.resets && Number.isInteger(account.resets.available) && account.resets.available > 0 ? account.resets.available : 0), 0)
}

/** A USD amount as the page shows it: "$12.40", "$1,250.00". */
export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}

/** The clock time of a reading, for "Showing usage from 14:05". */
export function usageReadingTime(fetchedAt: string | undefined): string | undefined {
  if (!fetchedAt) return undefined
  const at = new Date(fetchedAt)
  if (Number.isNaN(at.getTime())) return undefined
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** When reported windows were taken: "As of 14:05" today, "As of 3 Nov, 14:05" on another day. */
export function usageReadAtLabel(readAt: string | undefined, now: number): string | undefined {
  if (!readAt) return undefined
  const at = new Date(readAt)
  if (Number.isNaN(at.getTime())) return undefined
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = at.toDateString() === new Date(now).toDateString()
  return sameDay ? `As of ${time}` : `As of ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

/** Known provider notes, said in a few words; the detail goes in the tooltip. */
const SHORT_NOTES: Array<[RegExp, (match: RegExpExecArray) => { text: string; detail: string }]> = [
  [/^Limits show after the next turn/, () => ({ text: 'No limits yet', detail: 'Shows after the next turn' })],
  [/^Limits unavailable \(proxy\)\. Set (\w+)/, (match) => ({ text: 'Proxy key missing', detail: `Set ${match[1]}` })],
  [/^Sign in with ChatGPT to see limits/, () => ({ text: 'Signed out', detail: 'Sign in with ChatGPT to see limits' })],
  [/^No limits reported for this plan/, () => ({ text: 'No limits reported', detail: 'This plan reports none' })],
  [/^Codex couldn't be reached/, () => ({ text: 'Not reachable', detail: "Codex couldn't be reached" })],
  [/^Claude account usage limits are unavailable/, () => ({ text: 'Limits unavailable', detail: 'Claude reported no account limits' })]
]

/** A provider's note for the usage page: short text, and the detail (if any) for a tooltip. */
export function shortUsageNote(message: string | undefined): { text: string; detail?: string } | undefined {
  if (!message) return undefined
  for (const [pattern, short] of SHORT_NOTES) {
    const match = pattern.exec(message)
    if (match) return short(match)
  }
  return { text: message }
}

/** The computer picker's value for every computer together (the default), and for this one. */
export const ALL_COMPUTERS = 'all'
export const THIS_COMPUTER = 'self'

/** A provider as one computer reported it; `account` is an opaque key of the signed-in account, when reported. */
export type AccountUsage = ProviderUsage & { account?: string }

/** One computer's reading: this computer (`self`) or another, by its node. */
export interface ComputerUsage {
  id: string
  name: string
  providers: readonly AccountUsage[]
}

export interface UsageRow {
  key: string
  provider: ProviderUsage
  /** Shown, muted, only in All computers when the row is one computer's own account. */
  computerName?: string
}

/** A reading that says more wins: numbers over none, then the newer (a live one has no `readAt`). */
function better(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  if ((a.status === 'available') !== (b.status === 'available')) return a.status === 'available' ? a : b
  const at = (usage: ProviderUsage) => (usage.readAt ? Date.parse(usage.readAt) || 0 : Number.POSITIVE_INFINITY)
  return at(b) > at(a) ? b : a
}

/**
 * The providers to show for the picked computer. One computer: its own, unlabelled. All computers: a
 * provider account several computers report is shown once (limits belong to the account, not the
 * computer); every other row names its computer when there is more than one.
 */
export function usageRows(readings: readonly ComputerUsage[], selected: string): UsageRow[] {
  if (selected !== ALL_COMPUTERS) {
    const reading = readings.find((entry) => entry.id === selected)
    return (reading?.providers ?? []).map((provider) => ({ key: `${reading!.id}\u0000${provider.id}`, provider }))
  }
  const several = readings.length > 1
  const rows: Array<UsageRow & { computers: Set<string> }> = []
  const byAccount = new Map<string, (typeof rows)[number]>()
  for (const reading of readings) {
    for (const provider of reading.providers) {
      // An account is the same across computers only for the same kind of provider (`codex:work` is `codex`).
      const accountKey = provider.account ? `${provider.id.split(':')[0]}\u0000${provider.account}` : undefined
      const seen = accountKey ? byAccount.get(accountKey) : undefined
      if (seen) {
        seen.provider = better(seen.provider, provider)
        seen.computers.add(reading.name)
        continue
      }
      const row = { key: accountKey ?? `${reading.id}\u0000${provider.id}`, provider, computers: new Set([reading.name]) }
      rows.push(row)
      if (accountKey) byAccount.set(accountKey, row)
    }
  }
  return rows.map(({ computers, ...row }) => (several && computers.size === 1 ? { ...row, computerName: [...computers][0] } : row))
}

const SELECTED_KEY = 'mousse.usage.computer'

/** The computer picked earlier in this session, if any. */
export function rememberedUsageComputer(): string {
  try {
    return sessionStorage.getItem(SELECTED_KEY) ?? ALL_COMPUTERS
  } catch {
    return ALL_COMPUTERS
  }
}

export function rememberUsageComputer(value: string): void {
  try {
    sessionStorage.setItem(SELECTED_KEY, value)
  } catch {
    // No session storage: the pick lasts while the page is open.
  }
}

/** The picked computer while it is still listed; All computers once it is gone (disconnected, removed). */
export function usageSelection(picked: string, available: readonly string[]): string {
  return picked === ALL_COMPUTERS || available.includes(picked) ? picked : ALL_COMPUTERS
}
