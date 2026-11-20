import { resolve } from 'node:path'
import type { ThreadJournalRecord } from '../data/ThreadJournal'
import { isAcceptableThreadBranchName, isMousseBranchName } from '../../shared/mousseBranches'

/**
 * Which branches a thread's journal shows Mousse made for its worktree, under the names they have now.
 *
 * A branch is Mousse's when its journal says so, whatever its name:
 * - `workspace-provision`: the worktree was made with `git worktree add -b <branch>`, which fails when a branch of that
 *   name is already there, so a completed provision proves Mousse made the branch. For a `mousse/` name the planned
 *   record is enough, as it always was (records written before the completed one carried the branch).
 * - `workspace-branch-rename`: Mousse renamed a branch it owned (`git branch -m`, which fails when the new name is
 *   taken). Only a completed rename moves ownership to the new name. A rename with no outcome recorded (a stop between
 *   its steps) is `pending`: until it is settled from the repository (`ThreadWorkspaceManager.settleBranchRename`),
 *   the worktree is still the thread's under either name, but neither branch is deleted or renamed (retirement and
 *   purge keep both). A rename settled without knowing its outcome (`disowned`) leaves Mousse owning neither name for good.
 * - `workspace-branch-release`: Mousse deleted the branch (retirement), so the name is no longer Mousse's; a branch
 *   someone makes under it later is theirs. `workspace-branch-restore`: Mousse made it again at its tip, and owns it again.
 */

export const BRANCH_RENAME_OPERATION = 'workspace-branch-rename'
const PROVISION_OPERATION = 'workspace-provision'

/**
 * Mousse deleted the thread's branch (retirement keeps its tip pinned, `WorktreeRetirementService.releaseBranches`): the
 * name is no longer Mousse's, so a branch someone makes under it later is theirs. Written before the delete.
 */
export const BRANCH_RELEASE_OPERATION = 'workspace-branch-release'
/** Mousse made the released branch again at its tip (a restore): the name is Mousse's again. Written after it is made. */
export const BRANCH_RESTORE_OPERATION = 'workspace-branch-restore'

export interface BranchRenameIntent {
  from: string
  to: string
  worktreePath: string
  /** The commit `from` was at when the rename was planned; absent on older records. */
  fromSha?: string
}

export interface PendingBranchRename extends BranchRenameIntent {
  operationId: string
  sequence: number
}

export interface ThreadBranchRecord {
  /** The branches Mousse made for the thread, by their current names, that it has not deleted or given up. */
  owned: Set<string>
  /**
   * Every name the thread's worktree branch has had by Mousse's own records (made, renamed to, released, given up): the
   * worktree is still the thread's on any of them, though only `owned` ones may be deleted.
   */
  known: Set<string>
  /** A rename whose outcome is not recorded. */
  pending?: PendingBranchRename
  /** The name a branch has now after Mousse's completed renames (the name itself when it was never renamed). */
  renamedTo(name: string): string
}

const fold = (path: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? resolve(path).toLowerCase() : resolve(path))

function provisionIntent(entry: ThreadJournalRecord): { branch: string; worktreePath?: string } | undefined {
  const intent = entry.expectedPreState as { branch?: unknown; worktreePath?: unknown } | undefined
  return typeof intent?.branch === 'string' ? { branch: intent.branch, ...(typeof intent.worktreePath === 'string' ? { worktreePath: intent.worktreePath } : {}) } : undefined
}

export function renameIntentOf(entry: ThreadJournalRecord): BranchRenameIntent | undefined {
  const intent = entry.expectedPreState as Partial<BranchRenameIntent> | undefined
  if (typeof intent?.from !== 'string' || typeof intent.to !== 'string' || typeof intent.worktreePath !== 'string') return undefined
  if (!isAcceptableThreadBranchName(intent.to)) return undefined
  return { from: intent.from, to: intent.to, worktreePath: intent.worktreePath, ...(typeof intent.fromSha === 'string' && /^[0-9a-f]{40,64}$/.test(intent.fromSha) ? { fromSha: intent.fromSha } : {}) }
}

/** A release or restore record's branch, for the worktree at `at` (any worktree when `at` is undefined). */
function releasedBranch(entry: ThreadJournalRecord, at: string | undefined): string | undefined {
  const details = entry.details as { branch?: unknown; worktreePath?: unknown } | undefined
  if (entry.state !== 'completed' || typeof details?.branch !== 'string' || typeof details.worktreePath !== 'string') return undefined
  return at && fold(details.worktreePath) !== at ? undefined : details.branch
}

/**
 * Folds a thread's journal into the branches Mousse owns for it. `worktreePath` limits it to one worktree's records;
 * `acceptProvision` lets a caller add its own checks on a provision's planned record (the retirement service checks
 * where the worktree is).
 */
export function threadBranchRecord(entries: readonly ThreadJournalRecord[], options: { worktreePath?: string; acceptProvision?: (entry: ThreadJournalRecord) => boolean } = {}): ThreadBranchRecord {
  const owned = new Set<string>()
  const known = new Set<string>()
  const released = new Set<string>()
  const provisions = new Map<string, string>()
  const renames = new Map<string, PendingBranchRename>()
  const renamedFrom = new Map<string, string>()
  const at = options.worktreePath ? fold(options.worktreePath) : undefined
  for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.operationType === PROVISION_OPERATION) {
      if (entry.state === 'planned') {
        const intent = provisionIntent(entry)
        if (!intent || (at && (!intent.worktreePath || fold(intent.worktreePath) !== at)) || options.acceptProvision?.(entry) === false) continue
        provisions.set(entry.operationId, intent.branch)
        if (isMousseBranchName(intent.branch)) { owned.add(intent.branch); known.add(intent.branch) }
      } else if (entry.state === 'completed') {
        const branch = provisions.get(entry.operationId)
        const recorded = (entry.details as { branch?: unknown } | undefined)?.branch
        if (branch && (recorded === undefined || recorded === branch) && isAcceptableThreadBranchName(branch)) { owned.add(branch); known.add(branch) }
      }
    } else if (entry.operationType === BRANCH_RENAME_OPERATION) {
      if (entry.state === 'planned') {
        const intent = renameIntentOf(entry)
        if (!intent || (at && fold(intent.worktreePath) !== at) || !owned.has(intent.from)) continue
        renames.set(entry.operationId, { ...intent, operationId: entry.operationId, sequence: entry.sequence })
      } else {
        const rename = renames.get(entry.operationId)
        if (!rename) continue
        renames.delete(entry.operationId)
        if (entry.state === 'completed' && owned.has(rename.from)) {
          owned.delete(rename.from)
          owned.add(rename.to)
          known.add(rename.to)
          renamedFrom.set(rename.from, rename.to)
        } else if ((entry.details as { disowned?: unknown } | undefined)?.disowned === true) {
          // Settled without knowing which name is Mousse's: neither is, from now on.
          owned.delete(rename.from)
          known.add(rename.to)
        }
      }
    } else if (entry.operationType === BRANCH_RELEASE_OPERATION) {
      const branch = releasedBranch(entry, at)
      if (branch && owned.delete(branch)) released.add(branch)
    } else if (entry.operationType === BRANCH_RESTORE_OPERATION) {
      const branch = releasedBranch(entry, at)
      if (branch && released.delete(branch)) owned.add(branch)
    }
  }
  const pending = [...renames.values()].sort((a, b) => b.sequence - a.sequence)[0]
  if (pending) known.add(pending.to)
  const renamedTo = (name: string): string => {
    let current = name
    for (let hops = 0; hops < 32 && renamedFrom.has(current); hops++) current = renamedFrom.get(current)!
    return current
  }
  return { owned, known, ...(pending ? { pending } : {}), renamedTo }
}
