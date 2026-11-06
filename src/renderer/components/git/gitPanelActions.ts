import type { GitFileChange, GitPullStrategy, GitScope } from '../../../shared/types'
import {
  abortGitInProgress,
  discardGitPaths,
  fetchGit,
  pullGit,
  stageGitPaths,
  unstageGitPaths
} from '../../stores/gitStatusStore'
import { THREAD_WORKTREE_REASON, gitErrorMessage, isGitCancelled } from '../sideCard/gitSectionLogic'
import {
  discardPrompt,
  fetchResultNotice,
  pullResultNotice,
  type SyncActivity
} from './gitPanelLogic'

/** What the Git panel does when a button is pressed. Every action refreshes the folder afterwards, whether it worked or not. */

export type RowRequest =
  | { action: 'stage' | 'unstage'; files: readonly GitFileChange[] | 'all' }
  | { action: 'discard'; files: readonly GitFileChange[] }

/** `left` names paths a discard left as they are, because they changed after the person pressed Discard. */
export type RowOutcome = { kind: 'done'; notice?: string; left?: string } | { kind: 'cancelled' } | { kind: 'failed'; message: string }

export interface RowActionDeps {
  /** Asks the user; false cancels. May answer later (a themed dialog). Defaults to the window's confirm dialog. */
  confirm?: (message: string) => boolean | Promise<boolean>
  /** How long a discard keeps its copy, as the folder's status says (`discardKeptForMs`). */
  discardKeptForMs?: number
}

const paths = (files: readonly GitFileChange[]): string[] => [...new Set(files.map((file) => file.path))]

/**
 * Stage, unstage or discard files. A discard asks first and does nothing when declined, since it
 * throws changes away and deletes untracked files; its result names the copy the daemon kept and
 * how to bring a file back. Stage and unstage are refused in a thread's own worktree, where a
 * commit takes every change anyway.
 */
export async function runRowAction(
  path: string,
  scope: GitScope,
  request: RowRequest,
  deps: RowActionDeps = {}
): Promise<RowOutcome> {
  if (request.action !== 'discard' && scope.workspaceThreadId !== null) {
    return { kind: 'failed', message: THREAD_WORKTREE_REASON }
  }
  if (request.files !== 'all' && request.files.length === 0) return { kind: 'done' }
  try {
    if (request.action === 'discard') {
      const confirm = deps.confirm ?? ((message: string) => window.confirm(message))
      if (!(await confirm(discardPrompt(request.files, deps.discardKeptForMs)))) return { kind: 'cancelled' }
      const kept = await discardGitPaths(path, paths(request.files), scope)
      return { kind: 'done', ...(kept?.notice ? { notice: kept.notice } : {}), ...(kept?.left ? { left: kept.left } : {}) }
    } else {
      const target = request.files === 'all' ? 'all' : paths(request.files)
      if (request.action === 'stage') await stageGitPaths(path, target, scope)
      else await unstageGitPaths(path, target, scope)
    }
    return { kind: 'done' }
  } catch (error) {
    return { kind: 'failed', message: gitErrorMessage(error) }
  }
}

const CANCELLED_TEXT = { fetch: 'Fetch cancelled', pull: 'Pull cancelled', abort: 'Abort cancelled' } as const

export type SyncRequest =
  | { action: 'fetch' }
  | { action: 'pull'; strategy: GitPullStrategy }
  | { action: 'abort'; kind: 'merge' | 'rebase' }

/**
 * Fetch, pull or abort, reporting one activity: running, then done with what happened, or failed
 * with Git's reason. Never rejects. The folder is refreshed after a failure too, since a pull can
 * stop half way and leave a merge to deal with.
 */
export async function runSync(
  path: string,
  scope: GitScope,
  request: SyncRequest,
  onActivity: (activity: SyncActivity) => void
): Promise<void> {
  onActivity({ phase: 'running', action: request.action })
  try {
    if (request.action === 'fetch') {
      onActivity({ phase: 'done', action: 'fetch', message: fetchResultNotice(await fetchGit(path, scope)) })
    } else if (request.action === 'pull') {
      const { result } = await pullGit(path, scope, { strategy: request.strategy })
      onActivity({ phase: 'done', action: 'pull', message: pullResultNotice(result) })
    } else {
      // The daemon's line says it is done, how long the edits it wrote over are kept, and how to bring one back.
      const notice = await abortGitInProgress(path, request.kind, scope)
      onActivity({ phase: 'done', action: 'abort', message: notice ?? `${request.kind === 'merge' ? 'Merge' : 'Rebase'} aborted` })
    }
  } catch (error) {
    // Cancel is an outcome the user chose, not a failure; a stopped pull can leave a merge, which the sync bar then offers to abort.
    if (isGitCancelled(error)) onActivity({ phase: 'done', action: request.action, message: CANCELLED_TEXT[request.action] })
    else onActivity({ phase: 'failed', action: request.action, message: gitErrorMessage(error) })
  }
}
