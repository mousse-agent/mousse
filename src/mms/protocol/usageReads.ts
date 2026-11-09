import type { ProviderUsage, UsageAccount, UsageSlot } from '../../shared/providerAuth'

/**
 * The usage page's progressive reads: a list of every provider it shows (with the last reading of
 * each, so it can draw at once), then one read per provider, each with its own deadline so one that
 * hangs never holds the others up. The last readings live in memory, per profile, for this daemon.
 */

/** The longest one provider's read may take before the page shows it as not reachable. */
export const USAGE_FOR_MS = 20_000

interface Kept { usage: ProviderUsage; at: number }
const readings = new WeakMap<object, Map<string, Kept>>()

function kept(owner: object): Map<string, Kept> {
  let map = readings.get(owner)
  if (!map) readings.set(owner, (map = new Map()))
  return map
}

/** The last reading of a provider, dated when it was read (unless it already carries an older date). */
export function cachedUsage(owner: object, id: string): ProviderUsage | undefined {
  const entry = kept(owner).get(id)
  if (!entry) return undefined
  return { ...entry.usage, readAt: entry.usage.readAt ?? new Date(entry.at).toISOString() }
}

/** Keeps a provider's fresh reading. A preview of sign-ins keeps the windows each one had last time. */
export function keepUsage(owner: object, usage: ProviderUsage, now = Date.now()): void {
  const map = kept(owner)
  const before = map.get(usage.id)?.usage
  const accounts = usage.accounts?.map((account) => {
    if (!account.pending) return account
    const last = before?.accounts?.find((entry) => entry.id === account.id)
    return last && !last.pending ? last : account
  })
  map.set(usage.id, { usage: { ...usage, ...(accounts ? { accounts } : {}) }, at: now })
}

/** Keeps one sign-in's fresh reading inside its provider's last reading. */
export function keepAccount(owner: object, providerId: string, account: UsageAccount, now = Date.now()): void {
  const entry = kept(owner).get(providerId)
  if (!entry?.usage.accounts) return
  const accounts = entry.usage.accounts.map((existing) => (existing.id === account.id ? account : existing))
  kept(owner).set(providerId, { usage: { ...entry.usage, accounts }, at: now })
}

/**
 * A sign-in the provider answered "rate limited" for keeps the numbers it had last time (a burst of
 * refreshes must not wipe good readings off the page); one never read before says so.
 */
export function steadyAccount(owner: object, providerId: string, account: UsageAccount): UsageAccount {
  if (account.problem !== 'Rate limited') return account
  const last = kept(owner).get(providerId)?.usage.accounts?.find((entry) => entry.id === account.id)
  return last && !last.pending && last.windows.length ? last : account
}

/** The same for every sign-in of a provider's fresh reading. */
export function steadyUsage(owner: object, usage: ProviderUsage): ProviderUsage {
  if (!usage.accounts?.some((account) => account.problem === 'Rate limited')) return usage
  const accounts = usage.accounts.map((account) => steadyAccount(owner, usage.id, account))
  return { ...usage, accounts, ...(accounts.some((account) => account.windows.length) ? { status: 'available' as const, message: undefined } : {}) }
}

/** The page's list of providers, each with its last reading when there is one. */
export function usageSlots(owner: object, slots: ReadonlyArray<Omit<UsageSlot, 'cached'>>): UsageSlot[] {
  return slots.map((slot) => {
    const cached = cachedUsage(owner, slot.id)
    return { ...slot, ...(cached ? { cached } : {}) }
  })
}

/**
 * One provider's read within \`ms\`: what it returns, or "Not reachable" when it takes longer or fails,
 * so the others carry on. \`named\` is what the page calls it.
 */
export async function withUsageDeadline<T extends ProviderUsage | UsageAccount | undefined>(
  read: (signal: AbortSignal) => Promise<T>,
  fallback: () => T,
  ms = USAGE_FOR_MS
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(fallback())
    }, ms)
  })
  try {
    return await Promise.race([read(controller.signal).catch(() => fallback()), late])
  } finally {
    clearTimeout(timer)
  }
}

/** A provider that did not answer in time, or failed outright. */
export function unreachableUsage(id: string, label: string): ProviderUsage {
  return { id, label, status: 'error', windows: [], problem: 'unavailable', message: 'Not reachable' }
}
