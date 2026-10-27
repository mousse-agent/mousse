import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { STORAGE_POLICY_DEFAULTS, STORAGE_POLICY_EXISTING_INSTALL, STORAGE_POLICY_MAX_DAYS, type StoragePolicy } from '../../shared/storage'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { StorageSweepClock } from './sweepClock'

function days(value: unknown): number | null | undefined {
  if (value === null) return null
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= STORAGE_POLICY_MAX_DAYS ? value as number : undefined
}

export interface PolicySnapshot { policy: StoragePolicy; digest: string }
const policyDigest = (policy: StoragePolicy): string => createHash('sha256').update(JSON.stringify(policy)).digest('hex')

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

  private get reviewPath(): string { return join(this.store.root, 'storage-policy-review.json') }

  /**
   * Saves the policy of a profile that has none, once. A profile with prior use (threads or lifecycle
   * records) gets the behaviour it had before the recommended rules existed and a pending review, so
   * nothing new starts deleting until the person turns it on. A new profile gets the recommended rules.
   * Either way the file is written, so a later thread cannot change what the profile is.
   */
  initialize(hasPriorUse: () => boolean): 'existing' | 'new' | 'present' {
    if (existsSync(this.path)) return 'present'
    const existing = hasPriorUse()
    this.store.enableCleanupWriter()
    atomicWriteJsonSync(this.path, structuredClone(existing ? STORAGE_POLICY_EXISTING_INSTALL : STORAGE_POLICY_DEFAULTS))
    if (existing) atomicWriteJsonSync(this.reviewPath, { schemaVersion: 1, pending: true, createdAt: new Date().toISOString() })
    return existing ? 'existing' : 'new'
  }

  /** True until the person has reviewed the recommended rules (turned them on, saved a policy or dismissed the notice). */
  reviewPending(): boolean {
    try { return existsSync(this.reviewPath) && (JSON.parse(readFileSync(this.reviewPath, 'utf8')) as { pending?: unknown }).pending === true } catch { return false }
  }

  /** The notice is dismissed. Rules stay as they are. */
  dismissReview(human: boolean): void {
    if (!human) throw new Error('Storage cleanup changes require a human-controlled settings action')
    try { rmSync(this.reviewPath, { force: true }) } catch { /* A marker that cannot be removed only shows the notice again. */ }
  }

  policy(): StoragePolicy {
    if (!existsSync(this.path)) return structuredClone(STORAGE_POLICY_DEFAULTS)
    assertLifecyclePath(this.store.root, this.path)
    const policy = parseStoragePolicy(JSON.parse(readFileSync(this.path, 'utf8')))
    if (!policy) throw new Error('Unknown storage policy')
    return policy
  }

  /**
   * The policy and its digest from one read, so a rule set and the digest that authorizes it can never
   * come from different saves. A run takes one snapshot, evaluates with it and compares `digest()`
   * against it under the leases.
   */
  snapshot(): PolicySnapshot {
    const policy = this.policy()
    return { policy, digest: policyDigest(policy) }
  }

  /** Changes whenever a stored rule changes; a run re-reads it under the thread and repository leases. */
  digest(): string {
    return policyDigest(this.policy())
  }

  configure(input: unknown, human: boolean): StoragePolicy {
    if (!human) throw new Error('Storage cleanup changes require a human-controlled settings action')
    const policy = parseStoragePolicy(input)
    if (!policy) throw new Error(`Invalid storage policy. Day counts must be whole numbers from 1 to ${STORAGE_POLICY_MAX_DAYS}, or off.`)
    this.store.enableCleanupWriter()
    atomicWriteJsonSync(this.path, policy)
    // Saving a policy is the review of the recommended rules.
    try { rmSync(this.reviewPath, { force: true }) } catch { /* See dismissReview. */ }
    // Saving the policy is the review that clears a storage clock suspension. The trash clock is
    // a safety interlock on irreversible purging and is reset only by the trash row's own save.
    this.clock.resume()
    this.onConfigured?.()
    return this.policy()
  }
}
