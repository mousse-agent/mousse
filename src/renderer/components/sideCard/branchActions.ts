import type { GitScope } from '../../../shared/types'
import {
  checkoutGitBranch,
  createGitBranch,
  deleteGitBranch,
  renameGitBranch
} from '../../stores/gitStatusStore'
import {
  STASH_KEPT_NOTICE,
  branchFailureMessage,
  branchRowMenu,
  checkoutFailureCopy,
  gitErrorCode,
  gitErrorMessage,
  isDirtySwitchRefusal,
  isManagedBranchName,
  type DirtySwitchChoiceId
} from './gitSectionLogic'

/** How a branch switch ended. A refusal keeps the dirty-switch prompt open; Stash stays available there. */
export type SwitchOutcome =
  | { kind: 'switched'; notice: string | null }
  | { kind: 'cancelled' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string }

/**
 * Switch to `branch`. `choice` is the answer to the dirty-switch prompt, or null for a clean folder.
 * Cancel runs nothing. The folder is refreshed whether the switch worked or not, because a
 * stash-and-switch that failed may already have moved the changes.
 */
export async function switchBranch(
  path: string,
  branch: string,
  scope: GitScope,
  choice: DirtySwitchChoiceId | null
): Promise<SwitchOutcome> {
  if (choice === 'cancel') return { kind: 'cancelled' }
  try {
    const result = await checkoutGitBranch(path, branch, scope, choice === null ? {} : { dirty: choice })
    return { kind: 'switched', notice: result.stashKept ? STASH_KEPT_NOTICE : null }
  } catch (error) {
    const code = gitErrorCode(error)
    const message = checkoutFailureCopy(code) ?? gitErrorMessage(error)
    return isDirtySwitchRefusal(code) ? { kind: 'refused', message } : { kind: 'failed', message }
  }
}

export type BranchResult = { ok: true } | { ok: false; message: string }

export interface CreateBranchInput {
  name: string
  /** Start point; the current HEAD when null. */
  from: string | null
  /** Switch to the new branch. */
  checkout: boolean
}

export async function createBranch(path: string, input: CreateBranchInput, scope: GitScope): Promise<BranchResult> {
  const name = input.name.trim()
  try {
    await createGitBranch(path, name, scope, {
      checkout: input.checkout,
      ...(input.from === null ? {} : { from: input.from })
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: branchFailureMessage(error, name, 'create') }
  }
}

export async function renameBranch(path: string, name: string, newName: string, scope: GitScope): Promise<BranchResult> {
  const target = newName.trim()
  try {
    await renameGitBranch(path, name, target, scope)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: branchFailureMessage(error, target, 'rename') }
  }
}

/** `unmerged` means the branch holds commits no other branch has, so a second confirmation is due. */
export type DeleteOutcome = { kind: 'deleted' } | { kind: 'unmerged' } | { kind: 'failed'; message: string }

/**
 * Delete a branch. Without `force` an unmerged branch is not deleted and the outcome says so; the caller
 * asks again and retries with `force`. The current branch and branches under `mousse/` are refused here
 * as well as in the daemon, so no request is sent for them.
 */
export async function deleteBranch(
  path: string,
  name: string,
  current: string | null,
  scope: GitScope,
  force: boolean
): Promise<DeleteOutcome> {
  if (isManagedBranchName(name)) return { kind: 'failed', message: branchFailureMessage({ code: 'git_branch_protected' }, name, 'delete') }
  const menu = branchRowMenu(name, current)
  if (menu.available && !menu.canDelete) return { kind: 'failed', message: branchFailureMessage({ code: 'git_branch_current' }, name, 'delete') }
  try {
    await deleteGitBranch(path, name, scope, force ? { force: true } : {})
    return { kind: 'deleted' }
  } catch (error) {
    if (!force && gitErrorCode(error) === 'git_branch_unmerged') return { kind: 'unmerged' }
    return { kind: 'failed', message: branchFailureMessage(error, name, 'delete') }
  }
}
