import { existsSync } from 'node:fs'
import { ThreadJournal } from '../data/ThreadJournal'
import { git, inspectPendingChanges, ownPaths, tryGit } from '../actions/git'
import type { ThreadWorkspaceMetadata, WorkspaceRecovery } from '../../shared/workspace'

/** Journal states that refuse every turn, Undo and Publish until recovery runs (`ChangeReceiptService.assertNoPendingOperation`). */
const PENDING_STATES = ['prepared', 'git_applied', 'context_pending', 'recovery_required']

/** The branch the worktree is on; empty for a detached HEAD or a worktree that is gone. */
function currentBranch(worktreePath: string): string {
  return existsSync(worktreePath) ? tryGit(worktreePath, ['branch', '--show-current']).stdout : ''
}

/**
 * Why a thread needs recovery, or undefined when it does not. `verified` is `ThreadWorkspaceManager.verify()`
 * of the stored metadata: its `lifecycle` is `recovery_required` when the branch or HEAD differ from `workspace.json`.
 */
export function describeRecovery(threadDirectory: string, verified: ThreadWorkspaceMetadata): WorkspaceRecovery | undefined {
  const pending = [...new ThreadJournal(threadDirectory, { readOnly: true }).latestByOperation().values()].find((entry) => PENDING_STATES.includes(entry.state))
  if (verified.lifecycle !== 'recovery_required' && !pending) return undefined
  const operation = pending ? { operationId: pending.operationId, operationType: pending.operationType } : {}
  const actual = verified.lifecycle === 'recovery_required' ? currentBranch(verified.worktreePath) : ''
  if (actual && actual !== verified.branch) {
    return { reason: `The worktree is on branch ${actual} instead of ${verified.branch}.`, ...operation, branch: { expected: verified.branch, actual } }
  }
  const error = (pending?.details as { error?: unknown } | undefined)?.error
  if (typeof error === 'string' && error) return { reason: error.replace(/^Error: /, ''), ...operation }
  if (verified.lifecycle === 'recovery_required') return { reason: 'The worktree’s history changed outside Mousse.', ...operation }
  return { reason: `The ${pending!.operationType} operation did not finish.`, ...operation }
}

/**
 * Puts a worktree an agent switched to another branch back on the thread's branch. Only when that loses nothing:
 * no merge, rebase or conflict waits, no file is changed, and the branch tip is still where `workspace.json` recorded
 * it. The agent's commits stay on its own branch. The caller holds the mutation locks and runs `recoverPending` after.
 */
export function switchBackToThreadBranch(workspace: ThreadWorkspaceMetadata): { from: string; message: string } {
  const { worktreePath, branch } = workspace
  const from = currentBranch(worktreePath)
  if (!from) throw new Error(`The worktree is not on a branch, so Mousse cannot switch it back to ${branch}.`)
  if (from === branch) throw new Error(`The worktree is already on ${branch}.`)
  const pending = inspectPendingChanges(worktreePath)
  if (pending.operation) throw new Error(`A ${pending.operation} is in progress on ${from}. Finish or abort it, then switch back.`)
  const changed = ownPaths(pending.files)
  if (changed.length) throw new Error(`${from} has uncommitted changes (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''}). Commit or discard them, then switch back.`)
  const tip = tryGit(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!tip.ok) throw new Error(`The thread branch ${branch} no longer exists.`)
  if (tip.stdout !== workspace.headSha) throw new Error(`The thread branch ${branch} moved since Mousse last saw it, so Mousse will not switch back to it.`)
  git(worktreePath, ['switch', branch])
  return { from, message: `Switched the worktree back to ${branch}. The agent’s commits stay on ${from}.` }
}
