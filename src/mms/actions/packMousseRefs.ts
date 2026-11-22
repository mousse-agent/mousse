import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRepositoryLease, RepositoryLeaseBusyError } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { lifecycleGitAsync } from '../lifecycle/lifecycleGit'

/**
 * Mousse's refs (`refs/mousse/`: two per change receipt, kept files, thread pins) are written one loose file each, and
 * nothing else packs them, so a busy repository gathers thousands, each one a file every Git command that lists refs
 * reads. They are packed into `packed-refs` once this many are loose.
 */
export const LOOSE_MOUSSE_REFS_TO_PACK = 64
/** How long the repository's lease is waited for: a pack is never worth holding up a turn, so a busy one waits for the next pass. */
const LEASE_WAIT_MS = 250

/**
 * Whether this Git packs only the refs it is told to (`pack-refs --include`, Git 2.42). Without it `pack-refs` packs the
 * person's own branches too, so an older Git packs nothing. Learned from the first refusal; kept for the process.
 */
let includeSupported = true

export type PackOutcome = 'packed' | 'few' | 'busy' | 'unsupported'

/** Loose ref files under `<commonDir>/refs/mousse`, counted up to `limit`. */
async function looseMousseRefs(commonDir: string, limit: number): Promise<number> {
  let count = 0
  const folders = [join(commonDir, 'refs', 'mousse')]
  while (folders.length && count < limit) {
    const folder = folders.pop()!
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) folders.push(join(folder, entry.name))
      else if (entry.isFile() && !entry.name.endsWith('.lock') && ++count >= limit) break
    }
  }
  return count
}

/**
 * Packs the repository's loose `refs/mousse/` refs into `packed-refs` (`git pack-refs --include 'refs/mousse/*'`) once
 * {@link LOOSE_MOUSSE_REFS_TO_PACK} of them are loose; every other ref stays as it is. Under the repository's lease, so
 * never while a Mousse ref transaction runs; a lease that stays busy leaves the pack to the next pass. `checkout` is any
 * checkout of the repository.
 */
export async function packMousseRefs(checkout: string, options: { signal?: AbortSignal; threshold?: number } = {}): Promise<PackOutcome> {
  if (!includeSupported) return 'unsupported'
  const identity = await resolveRepositoryIdentityAsync(checkout, { requireMutationCapability: true })
  if (await looseMousseRefs(identity.commonDir, options.threshold ?? LOOSE_MOUSSE_REFS_TO_PACK) < (options.threshold ?? LOOSE_MOUSSE_REFS_TO_PACK)) return 'few'
  let lease
  try { lease = await acquireRepositoryLease(identity, { maxWaitMs: LEASE_WAIT_MS, ...(options.signal ? { signal: options.signal } : {}) }) }
  catch (error) { if (error instanceof RepositoryLeaseBusyError) return 'busy'; throw error }
  try {
    await lifecycleGitAsync(identity.commonDir, ['pack-refs', '--include', 'refs/mousse/*'])
    return 'packed'
  } catch (error) {
    // Git before 2.42 does not know `--include`, and says so with its usage.
    if (/unknown option|usage: git pack-refs/i.test(String((error as { stderr?: unknown }).stderr ?? (error as Error).message))) {
      includeSupported = false
      return 'unsupported'
    }
    throw error
  } finally {
    lease.release()
  }
}
