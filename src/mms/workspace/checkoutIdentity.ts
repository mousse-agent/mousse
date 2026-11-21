import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { readLinkedCheckout, type CheckoutIdentity } from '../git/worktreeHeadFiles'

/**
 * Which physical checkout the thread's worktree was when Mousse last read its files with Git (`CheckoutIdentity`): when
 * it was made, and after each start that read them. A turn may start from the last recorded state with no Git only
 * while the folder is still that checkout (`ownWorktreeStart`): a worktree removed and added again at the same path, or
 * a folder link pointed elsewhere, is another one.
 */
export const CHECKOUT_IDENTITY_FILE = 'checkout-identity.json'

interface RecordedIdentity extends CheckoutIdentity {
  worktreePath: string
  /** The exact baseline captured when this checkout was populated, before any turn ran. */
  initialSnapshotSha?: string
}

/** Records the current checkout, clearing a stale identity if Git's files cannot describe it. */
export async function recordCheckoutIdentity(threadDir: string, worktreePath: string, initialSnapshotSha?: string): Promise<void> {
  try {
    const read = await readLinkedCheckout(worktreePath)
    const path = join(threadDir, CHECKOUT_IDENTITY_FILE)
    if (read) atomicWriteJsonSync(path, { worktreePath, ...read.identity, initialSnapshotSha } satisfies RecordedIdentity)
    else rmSync(path, { force: true })
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
    (initialSnapshotSha === undefined || recorded.initialSnapshotSha === initialSnapshotSha)
}
