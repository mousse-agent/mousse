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
 */

export const BRANCH_RENAME_OPERATION = 'workspace-branch-rename'
const PROVISION_OPERATION = 'workspace-provision'

export interface BranchRenameIntent {
  from: string
  to: string
  worktreePath: string
}

export interface PendingBranchRename extends BranchRenameIntent {
  operationId: string
  sequence: number
}

export interface ThreadBranchRecord {
  /** The branches Mousse made for the thread, by their current names. */
  owned: Set<string>
  /** A rename whose outcome is not recorded. */
  pending?: PendingBranchRename
}

const fold = (path: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? resolve(path).toLowerCase() : resolve(path))

function provisionIntent(entry: ThreadJournalRecord): { branch: string; worktreePath?: string } | undefined {
  const intent = entry.expectedPreState as { branch?: unknown; worktreePath?: unknown } | undefined
  return typeof intent?.branch === 'string' ? { branch: intent.branch, ...(typeof intent.worktreePath === 'string' ? { worktreePath: intent.worktreePath } : {}) } : undefined
}

export function renameIntentOf(entry: ThreadJournalRecord): BranchRenameIntent | undefined {
  const intent = entry.expectedPreState as Partial<BranchRenameIntent> | undefined
  if (typeof intent?.from !== 'string' || typeof intent.to !== 'string' || typeof intent.worktreePath !== 'string') return undefined
  return isAcceptableThreadBranchName(intent.to) ? { from: intent.from, to: intent.to, worktreePath: intent.worktreePath } : undefined
}

/**
 * Folds a thread's journal into the branches Mousse owns for it. `worktreePath` limits it to one worktree's records;
 * `acceptProvision` lets a caller add its own checks on a provision's planned record (the retirement service checks
 * where the worktree is).
 */
export function threadBranchRecord(entries: readonly ThreadJournalRecord[], options: { worktreePath?: string; acceptProvision?: (entry: ThreadJournalRecord) => boolean } = {}): ThreadBranchRecord {
  const owned = new Set<string>()
  const provisions = new Map<string, string>()
  const renames = new Map<string, PendingBranchRename>()
  const at = options.worktreePath ? fold(options.worktreePath) : undefined
  for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.operationType === PROVISION_OPERATION) {
      if (entry.state === 'planned') {
        const intent = provisionIntent(entry)
        if (!intent || (at && (!intent.worktreePath || fold(intent.worktreePath) !== at)) || options.acceptProvision?.(entry) === false) continue
        provisions.set(entry.operationId, intent.branch)
        if (isMousseBranchName(intent.branch)) owned.add(intent.branch)
      } else if (entry.state === 'completed') {
        const branch = provisions.get(entry.operationId)
        const recorded = (entry.details as { branch?: unknown } | undefined)?.branch
        if (branch && (recorded === undefined || recorded === branch) && isAcceptableThreadBranchName(branch)) owned.add(branch)
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
        } else if ((entry.details as { disowned?: unknown } | undefined)?.disowned === true) {
          // Settled without knowing which name is Mousse's: neither is, from now on.
          owned.delete(rename.from)
        }
      }
    }
  }
  const pending = [...renames.values()].sort((a, b) => b.sequence - a.sequence)[0]
  return { owned, ...(pending ? { pending } : {}) }
}
