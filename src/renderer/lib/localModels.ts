import type { InstanceSnapshot } from '../../shared/harness/status'
import { legacyProviderForInstance, piProviderIdOf } from '../../shared/providerInstances'
import { applySnapshot } from './providerSnapshots'
import { providersApi } from './providersComputer'

/** An entry on a local model server: its provider id is `local-<slug>` (`pi:local-ollama`), whatever it lists now. */
export function isLocalEntry(snapshot: Pick<InstanceSnapshot, 'driver' | 'instanceId'>): boolean {
  return legacyProviderForInstance(snapshot.instanceId, snapshot)?.startsWith('local-') === true
}

/** The local server's provider id (`local-ollama`) of an entry, for `providers.local.*`. */
export function localProviderIdOf(snapshot: Pick<InstanceSnapshot, 'instanceId'>): string | undefined {
  return piProviderIdOf(snapshot.instanceId)
}

/** A list read again this recently is not read again: opening the picker twice in a row asks the server once. */
const REFRESH_GAP_MS = 10_000
const lastRefresh = new Map<string, number>()

/**
 * Reads the model lists of the local entries again (each from its own server only), when the Providers page or the
 * model picker opens. Nothing else reads them: not the app's start, not a render. A server that does not answer
 * keeps the list it had.
 */
export function refreshLocalModels(snapshots: readonly InstanceSnapshot[] | undefined, node?: string, now: number = Date.now()): void {
  for (const snapshot of snapshots ?? []) {
    if (!isLocalEntry(snapshot) || !snapshot.enabled.device) continue
    const key = `${node ?? ''}/${snapshot.instanceId}`
    if (now - (lastRefresh.get(key) ?? -Infinity) < REFRESH_GAP_MS) continue
    lastRefresh.set(key, now)
    void providersApi(node)
      .instances.refreshModels(snapshot.instanceId)
      .then((next) => applySnapshot(next, undefined, node))
      .catch(() => undefined)
  }
}

/** Test seam: forget when lists were last read. */
export function resetLocalRefreshes(): void {
  lastRefresh.clear()
}

/** "32K", "1M": a window in tokens, for a chip. */
export function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1024)}K`
}
