import { resolve } from 'node:path'
import type { ThreadJournalRecord } from '../data/ThreadJournal'
import { isAcceptableThreadBranchName, isMousseBranchName } from '../../shared/mousseBranches'

/**
 * Which branches a thread's journal shows Mousse made for its worktree, under the names they have now.
 *
 * A branch is Mousse's when its journal says so, whatever its name:
 * - `workspace-provision`: the worktree was made on a newly created branch. The creation marker proves Mousse made
 *   the branch when the worktree was provisioned. An older journal's plan
 *   can still identify its worktree for recovery. A plan alone gives no authority to delete the branch.
 * - `workspace-branch-rename`: Mousse renamed a verified branch to a free name. Only a completed rename moves ownership to the new name. A rename with no outcome recorded (a stop between
 *   its steps) is `pending`: until it is settled from the repository (`ThreadWorkspaceManager.settleBranchRename`),
 *   the worktree is still the thread's under either name, but neither branch is deleted or renamed (retirement and
 *   purge keep both). A rename settled without knowing its outcome (`disowned`) leaves Mousse owning neither name for good.
 * - `workspace-branch-release`: Mousse deleted the branch (retirement), so the name is no longer Mousse's; a branch
 *   someone makes under it later is theirs. `workspace-branch-restore`: Mousse made it again at its tip, and owns it again.
 */

export const BRANCH_RENAME_OPERATION = 'workspace-branch-rename'
const PROVISION_OPERATION = 'workspace-provision'
/** Branch Git created during a provision. Ownership still requires the provision's completion. */
export const BRANCH_CREATE_OPERATION = 'workspace-branch-create'

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
  /** The original branch's reflog identity, absent on older records. */
  fromReflogId?: string
}

export interface PendingBranchRename extends BranchRenameIntent {
  operationId: string
  sequence: number
  gitApplied?: true
  /** The verified destination identity. Older renames moved the original reflog file. */
  toReflogId?: string
}

export interface ThreadBranchRecord {
  /** The branches Mousse made for the thread, by their current names, that it has not deleted or given up. */
  owned: Set<string>
  /** The creation-time reflog identity for each branch with durable proof. Older records can name a branch without it. */
  reflogIds: Map<string, string>
  /** Original temporary names that are still eligible for first-message naming. */
  temporary: Set<string>
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

function provisionIntent(entry: ThreadJournalRecord): { branch: string; worktreePath?: string; requiresCompletion: boolean; requiresBranchIdentity: boolean; reflogId?: string } | undefined {
  const intent = entry.expectedPreState as { branch?: unknown; worktreePath?: unknown; requiresCompletion?: unknown; requiresBranchIdentity?: unknown } | undefined
  if (typeof intent?.branch !== 'string') return undefined
  return { branch: intent.branch, ...(typeof intent.worktreePath === 'string' ? { worktreePath: intent.worktreePath } : {}), requiresCompletion: intent.requiresCompletion === true, requiresBranchIdentity: intent.requiresBranchIdentity === true }
}

export function renameIntentOf(entry: ThreadJournalRecord): BranchRenameIntent | undefined {
  const intent = entry.expectedPreState as Partial<BranchRenameIntent> | undefined
  if (typeof intent?.from !== 'string' || typeof intent.to !== 'string' || typeof intent.worktreePath !== 'string') return undefined
  if (!isAcceptableThreadBranchName(intent.to)) return undefined
  return { from: intent.from, to: intent.to, worktreePath: intent.worktreePath, ...(typeof intent.fromReflogId === 'string' && /^[0-9a-f]{64}$/.test(intent.fromReflogId) ? { fromReflogId: intent.fromReflogId } : {}) }
}

function reflogIdOf(entry: ThreadJournalRecord): string | undefined {
  const id = (entry.details as { reflogId?: unknown } | undefined)?.reflogId
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : undefined
}

/** A release or restore record's branch, for the worktree at `at` (any worktree when `at` is undefined). */
function releasedBranch(entry: ThreadJournalRecord, at: string | undefined): string | undefined {
  const details = entry.details as { branch?: unknown; worktreePath?: unknown } | undefined
  if (entry.state !== 'completed' || typeof details?.branch !== 'string' || typeof details.worktreePath !== 'string') return undefined
  return at && fold(details.worktreePath) !== at ? undefined : details.branch
}

/** The operation types `threadBranchRecord` reads; a caller may pass only the records of these (`ThreadJournal.ofTypes`). */
export const BRANCH_RECORD_OPERATIONS = [PROVISION_OPERATION, BRANCH_CREATE_OPERATION, BRANCH_RENAME_OPERATION, BRANCH_RELEASE_OPERATION, BRANCH_RESTORE_OPERATION] as const

/**
 * Folds a thread's journal into the branches Mousse owns for it. `worktreePath` limits it to one worktree's records;
 * `acceptProvision` lets a caller add its own checks on a provision's planned record (the retirement service checks
 * where the worktree is).
 */
export function threadBranchRecord(entries: readonly ThreadJournalRecord[], options: { worktreePath?: string; acceptProvision?: (entry: ThreadJournalRecord) => boolean } = {}): ThreadBranchRecord {
  const owned = new Set<string>()
  const reflogIds = new Map<string, string>()
  const known = new Set<string>()
  const temporary = new Set<string>()
  const released = new Set<string>()
  const provisions = new Map<string, NonNullable<ReturnType<typeof provisionIntent>>>()
  const renames = new Map<string, PendingBranchRename>()
  const renamedFrom = new Map<string, string>()
  const at = options.worktreePath ? fold(options.worktreePath) : undefined
  const failedProvisions = new Set(entries.filter((entry) => entry.operationType === PROVISION_OPERATION && entry.state === 'failed').map((entry) => entry.operationId))
  for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.operationType === PROVISION_OPERATION) {
      if (entry.state === 'planned') {
        const intent = provisionIntent(entry)
        if (!intent || (at && (!intent.worktreePath || fold(intent.worktreePath) !== at)) || options.acceptProvision?.(entry) === false) continue
        provisions.set(entry.operationId, intent)
        if (!intent.requiresCompletion && !failedProvisions.has(entry.operationId) && isMousseBranchName(intent.branch)) known.add(intent.branch)
      } else if (entry.state === 'completed') {
        const provision = provisions.get(entry.operationId)
        if (!provision) continue
        const { branch, requiresCompletion, requiresBranchIdentity, reflogId } = provision
        const details = entry.details as { branch?: unknown; recovered?: unknown } | undefined
        if (details?.branch !== undefined && details.branch !== branch) continue
        // Historical provision records include the old id-based names, which the title model may no longer pick.
        if (!isAcceptableThreadBranchName(branch) && (requiresCompletion || !isMousseBranchName(branch))) continue
        known.add(branch)
        // Finding an existing checkout during recovery cannot prove that the provision created its ref.
        if (details?.recovered !== true && !failedProvisions.has(entry.operationId) && (!requiresBranchIdentity || reflogId)) {
          owned.add(branch)
          reflogIds.delete(branch)
          if (reflogId) reflogIds.set(branch, reflogId)
          if (requiresCompletion) temporary.add(branch)
        }
      }
    } else if (entry.operationType === BRANCH_CREATE_OPERATION && entry.state === 'completed') {
      const { provisionId } = (entry.details as { provisionId?: unknown } | undefined) ?? {}
      const provision = typeof provisionId === 'string' ? provisions.get(provisionId) : undefined
      const id = reflogIdOf(entry)
      if (provision && id) provision.reflogId = id
    } else if (entry.operationType === BRANCH_RENAME_OPERATION) {
      if (entry.state === 'planned') {
        const intent = renameIntentOf(entry)
        if (!intent || (at && fold(intent.worktreePath) !== at) || !owned.has(intent.from)) continue
        renames.set(entry.operationId, { ...intent, operationId: entry.operationId, sequence: entry.sequence })
      } else {
        const rename = renames.get(entry.operationId)
        if (!rename) continue
        const details = entry.details as { disowned?: unknown; settled?: unknown; reflogId?: unknown; toReflogId?: unknown } | undefined
        if (entry.state === 'git_applied') {
          if (rename.fromReflogId && details?.reflogId === rename.fromReflogId) {
            if (typeof details.toReflogId === 'string' && /^[0-9a-f]{64}$/.test(details.toReflogId)) {
              rename.toReflogId = details.toReflogId
            } else if (details.toReflogId !== undefined) continue
            rename.gitApplied = true
          }
          continue
        }
        if (entry.state !== 'completed' && entry.state !== 'failed' && entry.state !== 'cancelled') continue
        renames.delete(entry.operationId)
        // Older recovery could mistake a replacement's tip or ordinary Git rename message for the original branch.
        const unproven = entry.state === 'completed' && (details?.settled === true || rename.fromReflogId !== undefined) && !rename.gitApplied
        if (entry.state === 'completed' && !unproven && owned.has(rename.from)) {
          const id = reflogIds.get(rename.from)
          reflogIds.delete(rename.from)
          reflogIds.delete(rename.to)
          if (id && rename.gitApplied && id === rename.fromReflogId) reflogIds.set(rename.to, rename.toReflogId ?? id)
          owned.delete(rename.from)
          temporary.delete(rename.from)
          owned.add(rename.to)
          known.add(rename.to)
          renamedFrom.set(rename.from, rename.to)
        } else if (unproven || details?.disowned === true) {
          // Settled without knowing which name is Mousse's: neither is, from now on.
          reflogIds.delete(rename.from)
          owned.delete(rename.from)
          temporary.delete(rename.from)
          known.add(rename.to)
        }
      }
    } else if (entry.operationType === BRANCH_RELEASE_OPERATION) {
      const branch = releasedBranch(entry, at)
      if (branch && owned.delete(branch)) {
        reflogIds.delete(branch)
        temporary.delete(branch)
        released.add(branch)
      }
    } else if (entry.operationType === BRANCH_RESTORE_OPERATION) {
      const branch = releasedBranch(entry, at)
      if (branch && released.delete(branch)) {
        owned.add(branch)
        const id = reflogIdOf(entry)
        if (id) reflogIds.set(branch, id)
      }
    }
  }
  const pending = [...renames.values()].sort((a, b) => b.sequence - a.sequence)[0]
  if (pending) known.add(pending.to)
  const renamedTo = (name: string): string => {
    let current = name
    for (let hops = 0; hops < 32 && renamedFrom.has(current); hops++) current = renamedFrom.get(current)!
    return current
  }
  return { owned, reflogIds, known, temporary, ...(pending ? { pending } : {}), renamedTo }
}
