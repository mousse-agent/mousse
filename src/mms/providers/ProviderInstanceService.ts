import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ConfiguredProvider } from '../../shared/providerAuth'
import {
  instanceIdForLegacyProvider,
  legacyProviderForInstance,
  piInstanceId,
  piProviderIdOf,
  providerInstanceDisabled,
  providerInstanceUnknown,
  readProviderInstances,
  seedProviderInstances,
  type ModelOverride,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceMap
} from '../../shared/providerInstances'
import type { LlmProviderOption } from '../../shared/settings'
import { mirrorHash, tupleConfig, MIRROR_MARKER_KEY, type VendorMirror } from '../harness/vendorMirror'
import { piRetiredOf } from '../harness/drivers/pi/retired'
import type { ProviderAuthService } from './ProviderAuthService'

/**
 * What a profile stores: `providers.instances`, `providers.instancesSeedVersion` and
 * `providers.removedInstances` (the tombstones).
 */
export interface StoredProviderInstances {
  instances?: unknown
  seedVersion?: unknown
  removed?: unknown
}

/** One write of the instance map: the entries, the seed version and the tombstones together. */
export interface ProviderInstanceState {
  instances: Record<string, unknown>
  seedVersion: number
  removed: string[]
}

/** Where a profile keeps its instance map. `read` throws when the stored data cannot be read. */
export interface ProviderInstanceStore {
  read(): StoredProviderInstances
  write(state: ProviderInstanceState): void
}

/** What the provider RPCs list for a vendor driver, from that driver's provider service. */
export interface VendorProviderListing {
  configuredProvider(): ConfiguredProvider | undefined
  llmProvider(): LlmProviderOption | undefined
}

export interface ResolvedProviderInstance {
  instanceId: string
  entry: ProviderInstanceConfig
  /** The `llmProvider` name turns on this instance report (pi: the pi-ai provider id). */
  llmProvider: string
}

type PiCatalog = Partial<Pick<ProviderAuthService, 'getConfiguredProviders' | 'getConfiguredLlmProviders' | 'has'>> & {
  credentials?: { listProviderIds(): string[] }
  models?: { getProviders(): ReadonlyArray<{ id: string }> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The stored tombstones, read leniently: anything but a list of non-empty strings is ignored. */
function removedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

let builtinPiProviderIds: ReadonlySet<string> | undefined
function builtinPiProviders(): ReadonlySet<string> {
  builtinPiProviderIds ??= new Set(builtinProviders().map((provider) => provider.id))
  return builtinPiProviderIds
}

/**
 * A profile's provider instances: the stored map extended with the seeds (vendor instances and
 * one `pi:<provider>` per credentialed pi-ai provider), resolution of an instance id, and the
 * legacy `llmProvider` mapping used wherever an old selection still arrives. Without a store the
 * map lives in memory (tests, single-process tools).
 *
 * Removed instances are tombstoned (`removedInstances`): a tombstoned id is absent everywhere, even
 * when the stored map still holds an entry for it (an older Mousse may re-seed one from the shared
 * key). That entry is left on disk untouched; only an explicit add (`setEntry` with `revive`)
 * writes a fresh entry and clears the tombstone, in one write.
 */
export class ProviderInstanceService {
  /** Last state read from (or written to) the store; the working copy after a failed read. */
  private memory: StoredProviderInstances = {}
  private readonly vendors = new Map<ProviderDriverKind, VendorProviderListing>()
  /** Per-instance listings (the harness gateway); replaces the one-listing-per-driver map. */
  private instanceListing?: (instanceId: string, entry: ProviderInstanceConfig) => VendorProviderListing | undefined
  private writeFailed = false
  private readError?: string

  constructor(private readonly options: {
    store?: ProviderInstanceStore
    providerAuth?: PiCatalog
    /**
     * The vendor mirror of a built-in instance (its service's `settings.json`): a seeded entry starts
     * with the launch settings and sign-out found there, and the marker that records them.
     */
    mirrorFor?: (instanceId: string) => VendorMirror | undefined
  } = {}) {}

  /** Lists a vendor driver's provider in `configuredProviders()`. Transitional: deleted in 5a-2 with the old provider methods. */
  registerVendor(driver: Exclude<ProviderDriverKind, 'pi'>, listing: VendorProviderListing): this {
    this.vendors.set(driver, listing)
    return this
  }

  /**
   * Lists every enabled vendor instance from its own runtime in `configuredProviders()` (several
   * instances of one driver each get an entry). Transitional: deleted in 5a-2.
   */
  setListings(listing: (instanceId: string, entry: ProviderInstanceConfig) => VendorProviderListing | undefined): this {
    this.instanceListing = listing
    return this
  }

  /**
   * The effective instance map. Seeds the profile's stored map with any instance it lacks and
   * persists only when something changed; a stored entry is never rewritten (except a superseded
   * seed, see `seedProviderInstances`). After a failed read nothing is written: the map comes from
   * the last successful read, and the error is reported by `storeError()`. Removed instances are
   * left out, whatever the stored map holds for them.
   */
  list(): ProviderInstanceMap {
    const { stored, readable } = this.readStored()
    const seeded = this.seed(stored)
    const changed = seeded.added.length > 0 || seeded.upgraded.length > 0 || stored.seedVersion !== seeded.seedVersion
    if (changed && readable) this.writeStored({ instances: seeded.instances, seedVersion: seeded.seedVersion, removed: removedIds(stored.removed) })
    const removed = removedIds(stored.removed)
    const listed = readProviderInstances(seeded.instances)
    for (const instanceId of removed) delete listed[instanceId]
    return listed
  }

  /** Whether `instanceId` was removed from this profile (a tombstone); only an explicit add revives it. */
  isRemoved(instanceId: string): boolean {
    return removedIds(this.readStored().stored.removed).includes(instanceId)
  }

  /**
   * Stores one entry (an added instance, a device toggle, instance config). Fields of the stored
   * entry this version does not know are kept, so an older or newer build reads it unchanged.
   * Throws while the stored map cannot be read: nothing is written over it.
   *
   * A removed (tombstoned) instance takes no entry, except with `revive` (an explicit add): then a
   * fresh entry replaces any stale one and the tombstone goes, in the same write.
   */
  setEntry(instanceId: string, entry: ProviderInstanceConfig, options: { revive?: boolean } = {}): void {
    if (!instanceId || instanceId === '__proto__' || instanceId === 'constructor' || instanceId === 'prototype')
      throw new Error(`Invalid provider instance id "${instanceId}"`)
    const { stored, readable } = this.readStored()
    if (!readable) throw new Error(this.readError ?? 'The provider instances could not be read')
    const removed = removedIds(stored.removed)
    const tombstoned = removed.includes(instanceId)
    if (tombstoned && !options.revive) throw providerInstanceUnknown(instanceId, `Provider instance "${instanceId}" was removed. Add it again in Settings → Providers.`)
    const seeded = this.seed(stored)
    // An explicit add writes a fresh entry: nothing of a stale one (an older build's re-seed) is kept.
    const previous = options.revive ? undefined : seeded.instances[instanceId]
    const next: Record<string, unknown> = { ...(isRecord(previous) ? previous : {}), driver: entry.driver, enabled: entry.enabled }
    if (entry.config && Object.keys(entry.config).length) next.config = { ...entry.config }
    else delete next.config
    this.writeStored({
      instances: { ...seeded.instances, [instanceId]: next },
      seedVersion: seeded.seedVersion,
      removed: tombstoned ? removed.filter((id) => id !== instanceId) : removed
    })
    if (this.writeFailed) throw new Error('Mousse could not save the provider instances')
  }

  /**
   * Removes an entry and tombstones its id in the same write, so it stays removed: no seed brings
   * it back (a credentialed `pi:<provider>` included) and nothing resolves it until it is added again.
   */
  removeEntry(instanceId: string): void {
    const { stored, readable } = this.readStored()
    if (!readable) throw new Error(this.readError ?? 'The provider instances could not be read')
    const seeded = this.seed(stored)
    const removed = removedIds(stored.removed)
    const { [instanceId]: _removed, ...rest } = seeded.instances
    this.writeStored({ instances: rest, seedVersion: seeded.seedVersion, removed: removed.includes(instanceId) ? removed : [...removed, instanceId] })
    if (this.writeFailed) throw new Error('Mousse could not save the provider instances')
  }

  /** Why the stored instance map could not be read, while that lasts. */
  storeError(): string | undefined {
    return this.readError
  }

  /**
   * The entry for `instanceId`. A `pi:<provider>` id for a known pi-ai provider without a stored
   * entry (no credentials yet) is an implicit enabled pi instance; the pi loop reports the missing
   * credentials itself.
   */
  get(instanceId: string): ProviderInstanceConfig | undefined {
    // A removed instance is unknown: neither a stored entry nor the implicit pi instance stands in.
    if (this.isRemoved(instanceId)) return undefined
    const listed = this.list()[instanceId]
    if (listed) return listed
    const providerId = piProviderIdOf(instanceId)
    return providerId && this.isKnownPiProvider(providerId) ? { driver: 'pi', enabled: true } : undefined
  }

  /**
   * Resolves an instance id; throws `provider_instance_unknown` or `provider_instance_disabled`
   * naming the id. `allowDisabled` is for stopping work already running on an instance.
   */
  resolve(instanceId: string, options: { allowDisabled?: boolean } = {}): ResolvedProviderInstance {
    const entry = this.get(instanceId)
    const llmProvider = entry && legacyProviderForInstance(instanceId, entry)
    // A driver without a legacy name reports `''`; only a pi instance whose id names no provider is unknown.
    if (!entry || llmProvider === undefined) throw providerInstanceUnknown(instanceId)
    if (!entry.enabled && !options.allowDisabled) throw providerInstanceDisabled(instanceId)
    return { instanceId, entry, llmProvider }
  }

  /** `instanceIdForLegacyProvider` with this profile's pi-ai catalog. */
  instanceIdForLegacyProvider(llmProvider: string): string {
    return instanceIdForLegacyProvider(llmProvider, (providerId) => this.isKnownPiProvider(providerId))
  }

  /** The instance id a selection names: its own, or the one its legacy `llmProvider` maps to. */
  instanceIdOf(selection: { instanceId?: string; llmProvider?: string }): string {
    return selection.instanceId?.trim() || this.instanceIdForLegacyProvider(selection.llmProvider ?? '')
  }

  /**
   * A selection arriving from protocol or tool input, as stored: the instance must exist and be
   * enabled, and `llmProvider` is re-derived from it. Throws the instance errors.
   */
  overrideFor(input: { instanceId?: string; llmProvider?: string; model: string }): ModelOverride {
    const resolved = this.resolve(this.instanceIdOf(input))
    return { instanceId: resolved.instanceId, llmProvider: resolved.llmProvider, model: input.model }
  }

  /**
   * Migrate-on-read for a stored selection: adds the instance id when the legacy name maps to one
   * and re-derives `llmProvider` from a known instance. Never throws; a selection that cannot be
   * mapped is returned unchanged and fails loudly when a turn resolves it.
   */
  migrate<T extends ModelOverride>(override: T): T
  migrate<T extends ModelOverride>(override: T | undefined): T | undefined
  migrate<T extends ModelOverride>(override: T | undefined): T | undefined {
    if (!override) return override
    try {
      const instanceId = this.instanceIdOf(override)
      const entry = this.get(instanceId)
      const llmProvider = entry ? legacyProviderForInstance(instanceId, entry) : undefined
      return { ...override, instanceId, llmProvider: llmProvider ?? override.llmProvider } as T
    } catch {
      return override
    }
  }

  /**
   * Signed-in providers for Settings: credentialed pi-ai providers, then each enabled vendor
   * instance; removed ones are left out. The model pickers list through `HarnessGateway.llmProviders`.
   * Transitional: deleted in 5a-2 with the old provider methods.
   */
  configuredProviders(): ConfiguredProvider[] {
    const instances = this.list()
    const pi = (this.options.providerAuth?.getConfiguredProviders?.() ?? [])
      .map((provider) => ({ ...provider, instanceId: piInstanceId(provider.id) }))
      .filter((provider) => instances[provider.instanceId]?.enabled !== false && !this.isRemoved(provider.instanceId))
    return [...pi, ...this.vendorEntries(instances, (listing) => listing.configuredProvider())]
  }

  /** One entry per vendor driver (v1 has one instance per driver), from its first enabled instance. */
  private vendorEntries<T extends { id: string }>(
    instances: ProviderInstanceMap,
    pick: (listing: VendorProviderListing) => T | undefined
  ): Array<T & { instanceId: string }> {
    const entries: Array<T & { instanceId: string }> = []
    const perInstance = this.instanceListing
    if (perInstance) {
      for (const [instanceId, entry] of Object.entries(instances)) {
        if (entry.driver === 'pi' || !entry.enabled) continue
        const listing = perInstance(instanceId, entry)
        const value = listing ? pick(listing) : undefined
        if (value) entries.push({ ...value, instanceId })
      }
      return entries
    }
    const listed = new Set<ProviderDriverKind>()
    for (const [instanceId, entry] of Object.entries(instances)) {
      if (entry.driver === 'pi' || !entry.enabled || listed.has(entry.driver)) continue
      const listing = this.vendors.get(entry.driver)
      if (!listing) continue
      listed.add(entry.driver)
      const value = pick(listing)
      if (value) entries.push({ ...value, instanceId })
    }
    return entries
  }

  /**
   * The stored map with its seeds; a vendor seed copies its vendor file's tuple and records the
   * marker. A removed instance is never seeded; a stored entry for it stays as it is on disk.
   */
  private seed(stored: StoredProviderInstances): ReturnType<typeof seedProviderInstances> {
    const removed = new Set(removedIds(stored.removed))
    const credentialed = this.credentialedPiProviders().filter((providerId) => !removed.has(piInstanceId(providerId)))
    const seeded = seedProviderInstances(stored.instances, credentialed, stored.seedVersion, undefined, undefined, (instanceId) => {
      const mirror = this.options.mirrorFor?.(instanceId)
      const vendor = mirror?.read()
      // Unreadable: no marker, so the first start that reads it copies it (without overwriting).
      if (!mirror || !vendor || vendor === 'unreadable') return undefined
      return { ...tupleConfig(vendor, mirror.fields), [MIRROR_MARKER_KEY]: mirrorHash(vendor) }
    })
    const added = seeded.added.filter((instanceId) => !removed.has(instanceId))
    for (const instanceId of seeded.added) if (removed.has(instanceId)) delete seeded.instances[instanceId]
    return { ...seeded, added }
  }

  /** Whether `providerId` names a pi-ai provider: in the catalogue, credentialed, or retired by an update. */
  isKnownPiProvider(providerId: string): boolean {
    const auth = this.options.providerAuth
    // A retired provider stays known after its sign-in and registration are gone, so an old
    // selection naming it follows its Move, or reads retired, never unknown.
    if (builtinPiProviders().has(providerId) || piRetiredOf(providerId)) return true
    if (auth?.credentials?.listProviderIds().includes(providerId)) return true
    // The pi loop serves any provider the credential service reports as configured.
    try {
      if (auth?.has?.(providerId)) return true
    } catch {
      /* fall through to the catalog */
    }
    try {
      return auth?.models?.getProviders().some((provider) => provider.id === providerId) ?? false
    } catch {
      return false
    }
  }

  private credentialedPiProviders(): string[] {
    const auth = this.options.providerAuth
    try {
      return (auth?.credentials?.listProviderIds() ?? [])
        .filter((id) => !id.startsWith('web-tool:'))
        .filter((id) => auth?.has?.(id) ?? true)
    } catch {
      return []
    }
  }

  /**
   * The stored state, and whether it was actually read. A failed read is never mistaken for an
   * empty profile: it returns the last successfully read state and must not be written back.
   */
  private readStored(): { stored: StoredProviderInstances; readable: boolean } {
    if (!this.options.store) return { stored: this.memory, readable: true }
    try {
      const stored = this.options.store.read()
      this.readError = undefined
      // After a failed save, keep the seeds from memory so every read does not retry the write.
      if (this.writeFailed && isRecord(this.memory.instances))
        return { stored: { instances: { ...this.memory.instances, ...(isRecord(stored.instances) ? stored.instances : {}) }, seedVersion: this.memory.seedVersion, removed: this.memory.removed }, readable: true }
      this.memory = stored
      return { stored, readable: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.readError !== message) console.warn('[providers] could not read provider instances; using the last copy read', message)
      this.readError = message
      return { stored: this.memory, readable: false }
    }
  }

  private writeStored(state: ProviderInstanceState): void {
    this.memory = state
    if (!this.options.store) return
    try {
      this.options.store.write(state)
      this.writeFailed = false
    } catch (error) {
      // Seeds are derivable, so a read-only profile keeps working from the in-memory copy.
      if (!this.writeFailed)
        console.warn('[providers] could not save provider instances', error instanceof Error ? error.message : String(error))
      this.writeFailed = true
    }
  }
}
