import { resolve } from 'node:path'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { getExternalResourceClaims } from './LifecycleClaims'
import { buildResourceInventory, OwnershipFacts } from './ResourceInventory'
import type { ResourceLifecycleStore } from './ResourceLifecycleStore'

/**
 * The ownership check under a repository lease found a fact it was not given: a record changed while the work waited
 * for the lease. The caller lets go of the lease, discovers again and retries, a bounded number of times.
 */
export class OwnershipEvidenceChanged extends Error {
  constructor(readonly what: string) { super(`Ownership of ${what} changed while it was being read`) }
}

const running = new Map<string, { generation: number; facts: Promise<OwnershipFacts> }>()
let generations = 0

/**
 * What every profile of the installation claims, read once for a cleanup batch, before any thread or repository lease
 * is taken: the checkouts, real paths and old data folders the records name (`OwnershipFacts`). One discovery runs at a
 * time per profile; a caller that asks while one runs shares it. `newerThan`: the generation of facts the caller found
 * out of date, so it never gets those (or older) again; it waits for the running one and starts the next.
 *
 * The facts are only evidence: every change still checks ownership from the records themselves, synchronously, right
 * before it starts, after reading again what its own repository's facts say (`rereadRepositoryFacts`). Each caller gets
 * its own copy.
 */
export async function discoverOwnershipFacts(store: ResourceLifecycleStore, options: { newerThan?: number } = {}): Promise<OwnershipFacts> {
  const key = resolve(store.profileHome)
  for (;;) {
    const current = running.get(key)
    if (current && current.generation > (options.newerThan ?? -1)) return (await current.facts).copy()
    if (current) { await current.facts.catch(() => undefined); continue }
    const generation = ++generations
    const facts = (async () => {
      const found = new OwnershipFacts()
      found.generation = generation
      // Nothing excluded, so the facts cover any caller's exclusions. A refusal here is made again, from the records,
      // by each caller's own check; facts it stopped before are read by `factsFor`.
      await getExternalResourceClaims(store, new Set(), found).catch(() => undefined)
      return found
    })()
    running.set(key, { generation, facts })
    void facts.finally(() => { if (running.get(key)?.facts === facts) running.delete(key) }).catch(() => undefined)
    return (await facts).copy()
  }
}

/**
 * Adds to `facts` what a check that excludes `ownedIds` needs and discovery did not read: the excluded threads' own
 * checkouts (`own`), and anything a refusal stopped discovery before. Reads only what is missing; no lease is needed.
 */
export async function factsFor(store: ResourceLifecycleStore, facts: OwnershipFacts, ownedIds: Set<string>, own: readonly TaskLifecycleRecord[]): Promise<void> {
  for (const record of own) await buildResourceInventory(store, record, {}, facts)
  // Only the facts are wanted: a refusal is made again, from the records, by the check under the lease.
  await getExternalResourceClaims(store, ownedIds, facts).catch(() => undefined)
}
