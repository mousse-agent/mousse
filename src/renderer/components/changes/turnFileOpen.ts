import type { ReviewScope } from '../../../shared/review'
import type { TurnFileResult } from '../../../shared/turnFiles'
import { openSurface } from '../../lib/surfaces'
import { useAppStore } from '../../stores/appStore'
import { useChangesStore } from '../../stores/changesStore'
import { openFileInPanel } from '../../utils/chatLinks'
import { showToast } from '../ui/Toast'
import { readWorkspaceAvailability } from '../review/reviewData'
import { listedFile } from './changesModel'
import { readScopeList } from './scopeList'

/** Where a click on a file in a turn's changed-files summary takes it. */
export type TurnFileOpen =
  | { kind: 'changes' }
  | { kind: 'diff'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'missing'; path: string }

/**
 * The rule, in order:
 * 1. the Changes tab, when its list (the turn's, or Uncommitted for a thread without its own worktree) has the file;
 * 2. a read-only diff against the last commit of the file's own repository, when Git has a change to show there;
 * 3. the file in the Files tab, when it is there but in no repository, ignored, or unchanged;
 * 4. one line saying it is gone, when nothing is at its path.
 * `located` is null when the file could not be looked up (an older Mousse service, a thread of another computer, a
 * path the thread's calls do not name): the Changes tab opens, as it always did.
 */
export function turnFileOpen(input: { listed: boolean; located: TurnFileResult | null }): TurnFileOpen {
  const { listed, located } = input
  if (listed || !located) return { kind: 'changes' }
  if (located.kind === 'missing') return { kind: 'missing', path: located.path }
  if (located.kind === 'diff') return { kind: 'diff', path: located.path }
  return { kind: 'file', path: located.path }
}

function fileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/** The Changes tab on the turn (or the thread, or Uncommitted for a thread without its own worktree), at `file`. */
function openInChanges(threadId: string, turnId: string | undefined, own: boolean, file: string): void {
  const store = useChangesStore.getState()
  if (!own) store.openUncommitted(threadId, file)
  else if (turnId) store.openTurn(threadId, turnId, file)
  else store.openThread(threadId, file)
  openSurface('git')
}

/**
 * Opens a file from a turn's changed-files summary where it can be seen (see `turnFileOpen`). `file` is the path as the
 * agent wrote it: absolute, or relative to the thread's folder.
 */
export async function openTurnFile(threadId: string, turnId: string | undefined, file: string): Promise<void> {
  const own = (await readWorkspaceAvailability(threadId)) === 'own'
  const scope: ReviewScope = !own ? { kind: 'worktree' } : turnId ? { kind: 'turn', turnId } : { kind: 'thread' }
  const platform = useAppStore.getState().appInfo?.platform ?? ''
  const [list, located] = await Promise.all([
    readScopeList({ threadId }, scope).catch(() => null),
    (async () => window.mousse.review.turnFile({ threadId, path: file }))().catch(() => null)
  ])
  const listed = list !== null && !list.result.unavailable && listedFile(list.result, file, platform) !== null
  const target = turnFileOpen({ listed, located })
  // The person may have moved to another thread while the lists were read; the file opens in its own thread only.
  if (useAppStore.getState().activeThreadId !== threadId) return
  switch (target.kind) {
    case 'changes':
      openInChanges(threadId, turnId, own, file)
      return
    case 'diff':
      useAppStore.getState().openTurnFileDiff(threadId, target.path, fileName(target.path))
      return
    case 'file':
      openFileInPanel({ path: target.path, threadId })
      return
    case 'missing':
      showToast({ key: 'turn-file-missing', message: `${fileName(target.path)} no longer exists`, detail: target.path })
  }
}
