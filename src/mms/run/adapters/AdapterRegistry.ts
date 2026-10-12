import { fail } from '../db/RunStoreError'
import type { ProviderAdapter } from './ProviderAdapter'

/** Adapter id of the in-process pi-ai tool loop; every pi-ai provider routes here. */
export const PI_ADAPTER_ID = 'pi'

/**
 * `llmProvider` values served by a vendor runtime rather than the pi loop. The only place outside
 * an adapter that names providers (SPEC §2 invariant 8).
 */
const NATIVE_ADAPTER_IDS: ReadonlySet<string> = new Set(['claude-subscription', 'antigravity'])

/** Adapter id serving `llmProvider`. */
export function adapterIdFor(llmProvider: string): string {
  return NATIVE_ADAPTER_IDS.has(llmProvider) ? llmProvider : PI_ADAPTER_ID
}

/** Resolves the adapter for a thread's `llmProvider` (SPEC §13.5). */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>()

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.id)) fail('conflict', `Adapter ${adapter.id} is already registered.`)
    this.adapters.set(adapter.id, adapter)
    return this
  }

  /** Throws `bad_request` when the adapter serving `llmProvider` is not registered. */
  get(llmProvider: string): ProviderAdapter {
    const id = adapterIdFor(llmProvider)
    const adapter = this.adapters.get(id)
    if (!adapter) fail('bad_request', `No provider adapter ${id} for ${llmProvider}.`)
    return adapter
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()]
  }

  /**
   * `llmProvider` ids of signed-in vendor runtimes, offered alongside credentialed pi-ai providers
   * when a turn falls back to the configured default model.
   */
  configuredProviderIds(): string[] {
    return this.list()
      .filter((adapter) => adapter.configured?.() === true)
      .map((adapter) => adapter.id)
  }
}
