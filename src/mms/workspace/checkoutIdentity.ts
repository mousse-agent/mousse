import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { tryGitAsync } from '../actions/git'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { readLinkedCheckout, type CheckoutIdentity, type WorktreeHead } from '../git/worktreeHeadFiles'

/**
 * Which physical checkout the thread's worktree was when Mousse last read its files with Git (`CheckoutIdentity`): when
 * it was made, and after each start that read them. A turn may start from the last recorded state with no Git only
 * while the folder, Git config and object storage still match (`ownWorktreeStart`).
 */
export const CHECKOUT_IDENTITY_FILE = 'checkout-identity.json'

interface RecordedIdentity extends CheckoutIdentity {
  worktreePath: string
  /** The exact baseline captured when this checkout was populated, before any turn ran. */
  initialSnapshotSha?: string
}

/** Records the current checkout after Git validates it, clearing a stale identity when it cannot be trusted. */
export async function recordCheckoutIdentity(threadDir: string, worktreePath: string, initialSnapshotSha?: string): Promise<void> {
  try {
    const path = join(threadDir, CHECKOUT_IDENTITY_FILE)
    const before = await readLinkedCheckout(worktreePath)
    if (before?.head.head) {
      const verified = await tryGitAsync(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
      // An edit during validation must also go through Git on the next turn.
      if (verified.ok && verified.stdout === before.head.head && isDeepStrictEqual(before, await readLinkedCheckout(worktreePath))) {
        atomicWriteJsonSync(path, { worktreePath, ...before.identity, initialSnapshotSha } satisfies RecordedIdentity)
        return
      }
    }
    rmSync(path, { force: true })
  } catch (error) {
    console.warn('the worktree\'s checkout could not be recorded; its next turn reads its files first', { worktreePath, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Whether this is the recorded checkout, and if supplied, the snapshot captured when it was populated. */
export async function sameCheckout(threadDir: string, worktreePath: string, identity: CheckoutIdentity, initialSnapshotSha?: string): Promise<boolean> {
  let recorded: Partial<RecordedIdentity> | null
  try { recorded = JSON.parse(await readFile(join(threadDir, CHECKOUT_IDENTITY_FILE), 'utf8')) as Partial<RecordedIdentity> | null } catch { return false }
  return recorded?.worktreePath === worktreePath && recorded.realPath === identity.realPath && recorded.gitDir === identity.gitDir &&
    recorded.gitDirId === identity.gitDirId && recorded.worktreeId === identity.worktreeId &&
    recorded.commonDir === identity.commonDir && recorded.commonDirId === identity.commonDirId &&
    recorded.configHash === identity.configHash && recorded.objectStoreId === identity.objectStoreId &&
    (initialSnapshotSha === undefined || recorded.initialSnapshotSha === initialSnapshotSha)
}

/** Read HEAD from Git's files while the checkout still matches the one Git validated. */
export async function readRecordedCheckoutHead(threadDir: string, worktreePath: string): Promise<WorktreeHead | undefined> {
  const read = await readLinkedCheckout(worktreePath)
  if (read && await sameCheckout(threadDir, worktreePath, read.identity)) return read.head
  return undefined
}
