import type { ProviderUsage, ProvidersUsageResponse, UsageAccount, UsageSlot } from '../../shared/providerAuth'

/**
 * The Usage page's providers while they arrive one by one: each starts from its last reading
 * (\`cached\`, dated) or a placeholder (\`loading\`), and becomes \`fresh\` when its own read answers.
 * A provider read through several proxy sign-ins is \`partial\` while some of them are still read.
 */
export type EntryState = 'loading' | 'cached' | 'partial' | 'fresh'

export interface UsageEntry {
  slot: UsageSlot
  usage: ProviderUsage
  state: EntryState
}

export type UsageEntries = readonly UsageEntry[]

/** What a provider shows before anything arrived: its name, and what the list says of it. */
export function placeholderUsage(slot: UsageSlot): ProviderUsage {
  return { id: slot.id, label: slot.label, status: 'unavailable', windows: [], ...(slot.authType ? { authType: slot.authType } : {}), ...(slot.signedOut ? { signedOut: true } : {}) }
}

/** Every listed provider at once: its last reading when there is one, else a placeholder. */
export function startEntries(slots: readonly UsageSlot[]): UsageEntry[] {
  return slots.map((slot) => (slot.cached
    ? { slot, usage: { ...slot.cached, ...(slot.authType && !slot.cached.authType ? { authType: slot.authType } : {}) }, state: 'cached' }
    : { slot, usage: placeholderUsage(slot), state: 'loading' }))
}

const withEntry = (entries: UsageEntries, id: string, change: (entry: UsageEntry) => UsageEntry): UsageEntry[] =>
  entries.map((entry) => (entry.slot.id === id ? change(entry) : entry))

/** A provider's fresh reading. A reading for a provider the list did not have is added at the end. */
export function applyProvider(entries: UsageEntries, usage: ProviderUsage): UsageEntry[] {
  if (!entries.some((entry) => entry.slot.id === usage.id)) return [...entries, { slot: { id: usage.id, label: usage.label }, usage, state: 'fresh' }]
  return withEntry(entries, usage.id, (entry) => ({ ...entry, usage: { ...usage, ...(entry.slot.authType && !usage.authType ? { authType: entry.slot.authType } : {}) }, state: 'fresh' }))
}

/** A provider whose read failed outright: it says so where it is, keeping what it last showed otherwise. */
export function applyFailure(entries: UsageEntries, id: string): UsageEntry[] {
  return withEntry(entries, id, (entry) => ({ ...entry, usage: { ...entry.usage, status: 'error', windows: [], problem: 'unavailable', message: 'Not reachable', accounts: undefined, readAt: undefined }, state: 'fresh' }))
}

/**
 * The sign-ins of a proxy provider before their usage: each pending one shows what it had last time
 * when there was a last time (else a placeholder), and the provider is \`partial\` until all are read.
 */
export function applyPreview(entries: UsageEntries, usage: ProviderUsage): UsageEntry[] {
  return withEntry(entries, usage.id, (entry) => {
    const accounts = usage.accounts?.map((account) => {
      if (!account.pending) return account
      const last = entry.usage.accounts?.find((existing) => existing.id === account.id && !existing.pending)
      return last ? { ...last, pending: true as const } : account
    })
    return { ...entry, usage: { ...usage, ...(accounts ? { accounts } : {}), readAt: undefined }, state: 'partial' }
  })
}

/** One sign-in's fresh usage; the provider is fresh once none is pending. */
export function applyAccount(entries: UsageEntries, providerId: string, account: UsageAccount): UsageEntry[] {
  return withEntry(entries, providerId, (entry) => {
    const accounts = (entry.usage.accounts ?? []).map((existing) => (existing.id === account.id ? { ...account, label: existing.label } : existing))
    const done = accounts.every((existing) => !existing.pending)
    const status = accounts.some((existing) => existing.windows.length > 0) ? 'available' : entry.usage.status
    return { ...entry, usage: { ...entry.usage, accounts, status }, state: done ? 'fresh' : 'partial' }
  })
}

/**
 * A refresh: the providers listed now, each keeping what it shows until its fresh reading arrives (no
 * skeleton, no jump); one new to the list starts from its last reading or a placeholder.
 */
export function refreshEntries(shown: UsageEntries, slots: readonly UsageSlot[]): UsageEntry[] {
  const fresh = startEntries(slots)
  return fresh.map((entry) => {
    const before = shown.find((existing) => existing.slot.id === entry.slot.id)
    return before && before.state !== 'loading' ? { ...before, slot: entry.slot } : entry
  })
}

/** A provider the list no longer has (its read found nothing to show). */
export function removeEntry(entries: UsageEntries, id: string): UsageEntry[] {
  return entries.filter((entry) => entry.slot.id !== id)
}

/**
 * The providers as the page draws them, in the list's order, with when this reading was made. Each
 * carries its Settings entry from the list (`instanceId`), for Reconnect and Disable.
 */
export function entriesResponse(entries: UsageEntries, now: number): ProvidersUsageResponse {
  const providers = entries.map((entry) => (entry.slot.instanceId ? { ...entry.usage, instanceId: entry.slot.instanceId } : entry.usage))
  return { providers, fetchedAt: new Date(now).toISOString() }
}

/** The providers still waiting for their first answer (drawn as skeletons). */
export function loadingIds(entries: UsageEntries): Set<string> {
  return new Set(entries.filter((entry) => entry.state === 'loading').map((entry) => entry.slot.id))
}

/** Whether any provider is still being read. */
export function stillReading(entries: UsageEntries): boolean {
  return entries.some((entry) => entry.state !== 'fresh')
}
