import type { ProviderUsage, UsageAccount, UsageSlot } from '../../shared/providerAuth'
import type { MmsProfileServices } from '../MmsProfileServices'
import { limitReadings } from '../usageHistory/limitReadings'

/**
 * The usage page's progressive reads: a list of every provider it shows (with the last reading of
 * each, so it can draw at once), then one read per provider, each with its own deadline so one that
 * hangs never holds the others up. The last readings live in memory, per profile, for this daemon.
 */

/** The longest one provider's read may take before the page shows it as not reachable. */
export const USAGE_FOR_MS = 20_000

interface Kept {
  usage: ProviderUsage
  at: number
  /** The preview may display older numbers for these sign-ins while their reads are still pending. */
  pending?: ReadonlySet<string>
}
const readings = new WeakMap<object, Map<string, Kept>>()

function kept(owner: object): Map<string, Kept> {
  let map = readings.get(owner)
  if (!map) readings.set(owner, (map = new Map()))
  return map
}

/** When a provider was last read for the page or in the background, in ms. */
export function keptAt(owner: object, id: string): number | undefined {
  return kept(owner).get(id)?.at
}

/** The last reading of a provider, dated when it was read (unless it already carries an older date). */
export function cachedUsage(owner: object, id: string): ProviderUsage | undefined {
  const entry = kept(owner).get(id)
  if (!entry) return undefined
  return { ...entry.usage, readAt: entry.usage.readAt ?? new Date(entry.at).toISOString() }
}

type KeptListener = (providerId: string) => void
const keptListeners = new WeakMap<object, Set<KeptListener>>()

/**
 * Calls `listener` with the provider's id each time a reading of it is kept, whichever read made it (the usage page,
 * the background reads, a bot header's refresh). The protocol server pushes each one to every window.
 */
export function onUsageKept(owner: object, listener: KeptListener): () => void {
  let set = keptListeners.get(owner)
  if (!set) keptListeners.set(owner, (set = new Set()))
  set.add(listener)
  return () => { set.delete(listener) }
}

function usageKept(owner: object, providerId: string): void {
  for (const listener of keptListeners.get(owner) ?? []) {
    try {
      listener(providerId)
    } catch {
      // A listener never fails the read that kept the reading.
    }
  }
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
  const pending = usage.accounts?.filter((account) => account.pending).map((account) => account.id)
  map.set(usage.id, { usage: { ...usage, ...(accounts ? { accounts } : {}) }, at: now, ...(pending?.length ? { pending: new Set(pending) } : {}) })
  usageKept(owner, usage.id)
}

/** Keeps one sign-in's fresh reading inside its provider's last reading. */
export function keepAccount(owner: object, providerId: string, account: UsageAccount, now = Date.now()): void {
  const entry = kept(owner).get(providerId)
  if (!entry?.usage.accounts) return
  const accounts = entry.usage.accounts.map((existing) => (existing.id === account.id ? account : existing))
  const pending = entry.pending && new Set(entry.pending)
  if (!account.pending) pending?.delete(account.id)
  kept(owner).set(providerId, { usage: { ...entry.usage, accounts }, at: now, ...(pending?.size ? { pending } : {}) })
  usageKept(owner, providerId)
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
export function usageSlots(owner: object, slots: ReadonlyArray<Omit<UsageSlot, 'cached' | 'cachedAt'>>): UsageSlot[] {
  return slots.map((slot) => {
    const cached = cachedUsage(owner, slot.id)
    const entry = kept(owner).get(slot.id)
    return { ...slot, ...(cached ? { cached } : {}), ...(entry && !entry.pending?.size ? { cachedAt: new Date(entry.at).toISOString() } : {}) }
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

export const CLAUDE_USAGE_ID = 'claude-subscription'

/** Every provider the usage page shows, before any is read. */
export function usageSlotList(mms: MmsProfileServices): Array<Omit<UsageSlot, 'cached' | 'cachedAt'>> {
  // Claude turned off in Settings is not shown either.
  const claudeOn = !mms.providerInstances?.isDisabled?.('claude')
  const claude = claudeOn && mms.claudeSubscription.configured() ? [{ id: CLAUDE_USAGE_ID, label: 'Claude subscription', instanceId: 'claude', previewAccounts: true as const }] : []
  return [
    ...mms.providerAccess.usageSlots(),
    ...claude,
    ...(mms.harness?.instances.usageSlots({ kind: 'device' }) ?? [])
  ]
}

/** Keeps a reading's 5-hour and weekly limits for their trends; one that cannot be kept never fails the read. */
export function recordLimitReading(mms: MmsProfileServices, usage: ProviderUsage): void {
  // Claude's limits count only as the CLI API proxy reads them (its sign-ins are the proxy's too).
  if (usage.id === CLAUDE_USAGE_ID && !usage.proxy && !usage.accounts?.length) return
  try {
    void limitReadings(mms.getProfileHomeDir()).record(usage).catch(() => undefined)
  } catch {
    // No profile folder (a test's services): nothing to keep it in.
  }
}

/** Keeps a fresh reading for the page, and its limits for their trends. */
export function keepReading(mms: MmsProfileServices, usage: ProviderUsage): void {
  keepUsage(mms, usage)
  recordLimitReading(mms, usage)
}

/** The same for one sign-in of a provider that reads several. */
export function keepAccountReading(mms: MmsProfileServices, providerId: string, label: string, account: UsageAccount): void {
  keepAccount(mms, providerId, account)
  recordLimitReading(mms, { id: providerId, label, status: 'available', windows: [], accounts: [account] })
}

/**
 * One provider's usage, read within its deadline and kept: the page's read, and the background one. It goes
 * through each provider's own reader, so their caches, backoff and Retry-After waits apply to both.
 */
export async function readProviderUsage(mms: MmsProfileServices, providerId: string): Promise<ProviderUsage | undefined> {
  if (providerId === CLAUDE_USAGE_ID) {
    // Turned off in Settings: not on the page, so not read either.
    if (mms.providerInstances?.isDisabled?.('claude')) return undefined
    const claude = mms.claudeSubscription
    const read = await withUsageDeadline(async () => {
      await claude.status()
      return claude.configured() ? claude.getUsage(mms.worktrees.getRepoRoot()) : undefined
    }, () => unreachableUsage(providerId, 'Claude subscription'))
    const provider = read && steadyUsage(mms, read)
    if (provider) keepReading(mms, provider)
    return provider
  }
  const slot = mms.harness?.instances.usageSlots({ kind: 'device' }).find((entry) => entry.id === providerId)
  const listed = slot ?? mms.providerAccess.usageSlots().find((entry) => entry.id === providerId)
  // Only a provider the page lists is read, so the kept readings never grow past that list.
  if (!listed) return undefined
  const label = listed.label
  const provider = await withUsageDeadline(
    async () => (slot ? mms.harness!.instances.usageFor({ kind: 'device' }, providerId) : mms.providerAccess.usageFor(providerId)),
    () => unreachableUsage(providerId, label)
  )
  if (provider) keepReading(mms, provider)
  return provider
}

/** The CLI API proxy's Claude sign-ins before their usage, kept with each one's last numbers; undefined without such a proxy. */
export async function readClaudeAccountsPreview(mms: MmsProfileServices): Promise<ProviderUsage | undefined> {
  // Turned off in Settings: not on the page, so not read either.
  if (mms.providerInstances?.isDisabled?.('claude')) return undefined
  const provider = await withUsageDeadline((signal) => mms.claudeSubscription.usageAccountsPreview(signal), () => undefined)
  if (provider) keepUsage(mms, provider)
  return provider
}

/** One proxy sign-in's usage, read within its deadline and kept (a rate-limited answer keeps the last numbers). */
export async function readClaudeAccount(mms: MmsProfileServices, accountId: string): Promise<UsageAccount | undefined> {
  if (mms.providerInstances?.isDisabled?.('claude')) return undefined
  const read = await withUsageDeadline<UsageAccount | undefined>((signal) => mms.claudeSubscription.usageAccount(accountId, signal), () => ({ id: accountId, label: accountId, windows: [], problem: 'Not reachable' }))
  const account = read && steadyAccount(mms, CLAUDE_USAGE_ID, read)
  if (account) keepAccountReading(mms, CLAUDE_USAGE_ID, 'Claude subscription', account)
  return account
}

/**
 * One provider read as the usage page reads it: Claude through the proxy's sign-ins one by one when it has several,
 * any other provider (and Claude without them) in one read. Every read goes through the provider's own reader.
 */
export async function readUsageAsPage(mms: MmsProfileServices, providerId: string): Promise<void> {
  if (providerId === CLAUDE_USAGE_ID) {
    const preview = await readClaudeAccountsPreview(mms)
    if (preview?.accounts?.length) {
      await Promise.all(preview.accounts.filter((account) => account.pending).map((account) => readClaudeAccount(mms, account.id)))
      return
    }
  }
  await readProviderUsage(mms, providerId)
}
