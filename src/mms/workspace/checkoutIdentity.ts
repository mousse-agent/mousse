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
}

/** Records the current checkout, clearing a stale identity if Git's files cannot describe it. */
export async function recordCheckoutIdentity(threadDir: string, worktreePath: string): Promise<void> {
  try {
    const read = await readLinkedCheckout(worktreePath)
    const path = join(threadDir, CHECKOUT_IDENTITY_FILE)
    if (read) atomicWriteJsonSync(path, { worktreePath, ...read.identity } satisfies RecordedIdentity)
    else rmSync(path, { force: true })
  } catch (error) {
    console.warn('the worktree\'s checkout could not be recorded; its next turn reads its files first', { worktreePath, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Whether `identity`, read now at `worktreePath`, is the checkout recorded for the thread. */
export async function sameCheckout(threadDir: string, worktreePath: string, identity: CheckoutIdentity): Promise<boolean> {
  let recorded: Partial<RecordedIdentity> | null
  try { recorded = JSON.parse(await readFile(join(threadDir, CHECKOUT_IDENTITY_FILE), 'utf8')) as Partial<RecordedIdentity> | null } catch { return false }
  return recorded?.worktreePath === worktreePath && recorded.realPath === identity.realPath && recorded.gitDir === identity.gitDir &&
    recorded.gitDirId === identity.gitDirId && recorded.worktreeId === identity.worktreeId
}
