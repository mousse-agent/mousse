import type { ProviderUsage, ProviderUsageWindow, UsageAccount } from '../../shared/providerAuth'

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
 * Time left as a countdown: "45m" or "1h 12m" under a day; "3d 4h" from a day on, or "3d" when the
 * hours are none or there is no room (`short`).
 */
export function formatCountdown(totalMinutes: number, options: { short?: boolean } = {}): string {
  const minutes = Math.max(0, Math.floor(totalMinutes))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours && !options.short ? `${days}d ${hours}h` : `${days}d`
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
    return {
      id: first.id,
      heading,
      label: `${heading} · ${count === active.length ? 'all accounts' : `${count} account${count === 1 ? '' : 's'}`}`,
      accounts: count,
      ...(lefts.length ? { remaining: Math.round(lefts.reduce((sum, left) => sum + left, 0) / lefts.length) } : {}),
      ...(resets[0] ? { resetsAt: resets[0] } : {})
    }
  })
}

/** An account's avatar hue, the same for the same account every time. */
export function accountHue(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
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
