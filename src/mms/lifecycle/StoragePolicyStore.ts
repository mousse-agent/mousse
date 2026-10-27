import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORAGE_POLICY_DEFAULTS, STORAGE_POLICY_MAX_DAYS, type StoragePolicy } from '../../shared/storage'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { StorageSweepClock } from './sweepClock'

function days(value: unknown): number | null | undefined {
  if (value === null) return null
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= STORAGE_POLICY_MAX_DAYS ? value as number : undefined
}

/** Parses a stored or submitted policy; anything unknown is refused rather than guessed. */
export function parseStoragePolicy(value: unknown): StoragePolicy | undefined {
  const policy = value as Partial<StoragePolicy> | undefined
  if (!policy || typeof policy !== 'object' || policy.schemaVersion !== 1 || !policy.worktrees || !policy.browser) return undefined
  const { removeWithDeletedThreads, inactiveDays, removeMerged } = policy.worktrees
  const captureDays = days(policy.browser.captureDays)
  const inactive = days(inactiveDays)
  if (typeof removeWithDeletedThreads !== 'boolean' || typeof removeMerged !== 'boolean' || inactive === undefined || captureDays === undefined) return undefined
  return { schemaVersion: 1, worktrees: { removeWithDeletedThreads, inactiveDays: inactive, removeMerged }, browser: { captureDays } }
}

/**
 * Storage cleanup rules, stored beside the trash policy in `<profile>/lifecycle/storage-policy.json`.
 * Only a human-controlled settings action writes it, like `ResourcePurgeService.configure`.
 */
export class StoragePolicyStore {
  constructor(
    private readonly store: ResourceLifecycleStore,
    private readonly clock: StorageSweepClock,
    private readonly onConfigured?: () => void
  ) {}

  private get path(): string { return join(this.store.root, 'storage-policy.json') }

  policy(): StoragePolicy {
    if (!existsSync(this.path)) return structuredClone(STORAGE_POLICY_DEFAULTS)
    assertLifecyclePath(this.store.root, this.path)
    const policy = parseStoragePolicy(JSON.parse(readFileSync(this.path, 'utf8')))
    if (!policy) throw new Error('Unknown storage policy')
    return policy
  }

  /** Changes whenever a stored rule changes; a run re-reads it under the thread and repository leases. */
  digest(): string {
    return createHash('sha256').update(JSON.stringify(this.policy())).digest('hex')
  }

  configure(input: unknown, human: boolean): StoragePolicy {
    if (!human) throw new Error('Storage cleanup changes require a human-controlled settings action')
    const policy = parseStoragePolicy(input)
    if (!policy) throw new Error(`Invalid storage policy. Day counts must be whole numbers from 1 to ${STORAGE_POLICY_MAX_DAYS}, or off.`)
    this.store.enableCleanupWriter()
    atomicWriteJsonSync(this.path, policy)
    // Saving the policy is the review that clears a storage clock suspension. The trash clock is
    // a safety interlock on irreversible purging and is reset only by the trash row's own save.
    this.clock.resume()
    this.onConfigured?.()
    return this.policy()
  }
}
