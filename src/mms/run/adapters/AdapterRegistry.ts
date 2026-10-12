import type { ModelOverride, ProviderDriverKind } from '../../../shared/providerInstances'
import { ProviderInstanceService, type ResolvedProviderInstance } from '../../providers/ProviderInstanceService'
import { fail } from '../db/RunStoreError'
import type { ProviderAdapter } from './ProviderAdapter'

/** Driver kind of the in-process pi-ai tool loop; every `pi:<provider>` instance runs on it. */
export const PI_DRIVER: ProviderDriverKind = 'pi'

/** An instance resolved to the adapter of its driver. */
export interface ResolvedAdapter extends ResolvedProviderInstance {
  adapter: ProviderAdapter
}

/**
 * Resolves the adapter for a provider instance (SPEC §13.5, §13.8): instance id → instance entry
 * → driver → adapter. An unknown or disabled instance throws `provider_instance_unknown` /
 * `provider_instance_disabled`; nothing falls back to the pi loop. Adapters are registered once per
 * driver kind. The driver factory (with the Codex adapter) will build adapters per instance from
 * the entry's `config`; until then each driver has one adapter shared by its instances.
 */
export class AdapterRegistry {
  private readonly drivers = new Map<ProviderDriverKind, ProviderAdapter>()

  constructor(private instanceSource: ProviderInstanceService = new ProviderInstanceService()) {}

  /** The profile's instances; the registry resolves ids against them. */
  get instances(): ProviderInstanceService {
    return this.instanceSource
  }

  setInstances(instances: ProviderInstanceService): this {
    this.instanceSource = instances
    return this
  }

  register(adapter: ProviderAdapter): this {
    if (this.drivers.has(adapter.driver)) fail('conflict', `An adapter for driver ${adapter.driver} is already registered.`)
    this.drivers.set(adapter.driver, adapter)
    return this
  }

  /**
   * The instance and its driver's adapter. Throws the instance errors for an unknown or disabled
   * id and `bad_request` when no adapter serves the instance's driver.
   */
  resolve(instanceId: string, options: { allowDisabled?: boolean } = {}): ResolvedAdapter {
    const resolved = this.instanceSource.resolve(instanceId, options)
    const adapter = this.drivers.get(resolved.entry.driver)
    if (!adapter) fail('bad_request', `No provider adapter for driver ${resolved.entry.driver} (instance ${instanceId}).`)
    return { ...resolved, adapter }
  }

  /**
   * `resolve` for a selection that names an instance or, in older records, only an `llmProvider`.
   * A selection naming nothing at all (no instance, empty provider: no default model configured)
   * runs on the pi driver, whose loop resolves the configured default itself and reports a missing
   * one (`TurnInput.modelPinned`). Any name that is given must resolve; nothing else falls back.
   */
  resolveSelection(selection: Pick<ModelOverride, 'instanceId' | 'llmProvider'>, options: { allowDisabled?: boolean } = {}): ResolvedAdapter {
    if (!selection.instanceId?.trim() && !selection.llmProvider?.trim()) {
      const adapter = this.drivers.get(PI_DRIVER)
      if (!adapter) fail('bad_request', 'No model is selected and no pi loop adapter is registered.')
      return { instanceId: PI_DRIVER, entry: { driver: PI_DRIVER, enabled: true }, llmProvider: '', adapter }
    }
    return this.resolve(this.instanceSource.instanceIdOf(selection), options)
  }

  get(instanceId: string): ProviderAdapter {
    return this.resolve(instanceId).adapter
  }

  list(): ProviderAdapter[] {
    return [...this.drivers.values()]
  }

  /**
   * `llmProvider` names of enabled vendor instances whose runtime is signed in, offered alongside
   * credentialed pi-ai providers when a turn falls back to the configured default model.
   */
  configuredProviderIds(): string[] {
    const ids: string[] = []
    for (const instanceId of Object.keys(this.instanceSource.list())) {
      try {
        const resolved = this.resolve(instanceId)
        if (resolved.entry.driver !== PI_DRIVER && resolved.adapter.configured?.() === true) ids.push(resolved.llmProvider)
      } catch {
        // Disabled instances and drivers without an adapter offer nothing.
      }
    }
    return ids
  }
}
