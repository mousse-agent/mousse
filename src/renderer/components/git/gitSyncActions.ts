import type { GitPullStrategy, GitScope } from '../../../shared/types'
import { abortGitInProgress, fetchGit, pullGit } from '../../stores/gitStatusStore'
import { gitErrorMessage, isGitCancelled } from '../sideCard/gitSectionLogic'
import { fetchResultNotice, pullResultNotice, type SyncActivity } from './gitSyncLogic'

/**
 * Wraps a setter so a result that arrives after the panel moved to another folder is dropped:
 * the tab shows the folder it is on now, not the one an action started in.
 */
export function whileFolder<T>(folder: { readonly current: string | null }, startedIn: string, set: (value: T) => void): (value: T) => void {
  return (value) => {
    if (folder.current === startedIn) set(value)
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
