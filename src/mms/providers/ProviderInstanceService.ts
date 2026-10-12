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
import type { ProviderAuthService } from './ProviderAuthService'

/** Where a profile keeps its instance map (`providers.instances` in the profile config). */
export interface ProviderInstanceStore {
  read(): unknown
  write(instances: Record<string, unknown>): void
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
 */
export class ProviderInstanceService {
  private memory: unknown
  private readonly vendors = new Map<ProviderDriverKind, VendorProviderListing>()
  private writeFailed = false

  constructor(private readonly options: { store?: ProviderInstanceStore; providerAuth?: PiCatalog } = {}) {}

  /** Lists a vendor driver's provider in `configuredProviders()` / `llmProviders()`. */
  registerVendor(driver: Exclude<ProviderDriverKind, 'pi'>, listing: VendorProviderListing): this {
    this.vendors.set(driver, listing)
    return this
  }

  /**
   * The effective instance map. Seeds the profile's stored map with any instance it lacks and
   * persists only when something was added; a stored entry is never rewritten.
   */
  list(): ProviderInstanceMap {
    const stored = this.readStored()
    const { instances, added } = seedProviderInstances(stored, this.credentialedPiProviders())
    if (added.length) this.writeStored(instances)
    return readProviderInstances(instances)
  }

  /**
   * The entry for `instanceId`. A `pi:<provider>` id for a known pi-ai provider without a stored
   * entry (no credentials yet) is an implicit enabled pi instance; the pi loop reports the missing
   * credentials itself.
   */
  get(instanceId: string): ProviderInstanceConfig | undefined {
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
    if (!entry || !llmProvider) throw providerInstanceUnknown(instanceId)
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

  /** Signed-in providers for Settings: credentialed pi-ai providers, then each enabled vendor instance. */
  configuredProviders(): ConfiguredProvider[] {
    const instances = this.list()
    const pi = (this.options.providerAuth?.getConfiguredProviders?.() ?? [])
      .map((provider) => ({ ...provider, instanceId: piInstanceId(provider.id) }))
      .filter((provider) => instances[provider.instanceId]?.enabled !== false)
    return [...pi, ...this.vendorEntries(instances, (listing) => listing.configuredProvider())]
  }

  /** Model catalogs for the pickers: credentialed pi-ai providers, then each enabled vendor instance. */
  llmProviders(): LlmProviderOption[] {
    const instances = this.list()
    const pi = (this.options.providerAuth?.getConfiguredLlmProviders?.() ?? [])
      .map((provider) => ({ ...provider, instanceId: piInstanceId(provider.id) }))
      .filter((provider) => instances[provider.instanceId]?.enabled !== false)
    return [...pi, ...this.vendorEntries(instances, (listing) => listing.llmProvider())]
  }

  /** One entry per vendor driver (v1 has one instance per driver), from its first enabled instance. */
  private vendorEntries<T extends { id: string }>(
    instances: ProviderInstanceMap,
    pick: (listing: VendorProviderListing) => T | undefined
  ): Array<T & { instanceId: string }> {
    const entries: Array<T & { instanceId: string }> = []
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

  private isKnownPiProvider(providerId: string): boolean {
    const auth = this.options.providerAuth
    if (builtinPiProviders().has(providerId)) return true
    if (auth?.credentials?.listProviderIds().includes(providerId)) return true
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

  private readStored(): unknown {
    if (!this.options.store) return this.memory
    try {
      const stored = this.options.store.read()
      // After a failed save, keep the seeds from memory so every read does not retry the write.
      return this.writeFailed && isRecord(this.memory) ? { ...this.memory, ...(isRecord(stored) ? stored : {}) } : stored
    } catch {
      return this.memory
    }
  }

  private writeStored(instances: Record<string, unknown>): void {
    this.memory = instances
    if (!this.options.store) return
    try {
      this.options.store.write(instances)
      this.writeFailed = false
    } catch (error) {
      // Seeds are derivable, so a read-only profile keeps working from the in-memory copy.
      if (!this.writeFailed)
        console.warn('[providers] could not save provider instances', error instanceof Error ? error.message : String(error))
      this.writeFailed = true
    }
  }
}
