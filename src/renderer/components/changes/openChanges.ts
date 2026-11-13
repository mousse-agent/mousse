import { openSurface } from '../../lib/surfaces'
import { useChangesStore } from '../../stores/changesStore'
import { readWorkspaceAvailability } from '../review/reviewData'
import { openTurnFile } from './turnFileOpen'

/**
 * Opens a turn's changes in the Changes tab from a chat edit line or the changed-files summary under a turn. A summary
 * without a turn id (a transcript from before turns were recorded) opens the whole thread. A thread with no worktree
 * of its own has no turns, so the tab opens on its uncommitted changes.
 *
 * With `file` (a file row was clicked: the path the agent wrote, absolute or relative to the worktree) the file opens
 * wherever it can be seen: in the Changes tab when its list has it, otherwise as a diff against its own repository,
 * in the Files tab, or with a line saying it is gone (`turnFileOpen`).
 */
export async function openTurnInChanges(threadId: string | null, turnId: string | undefined, file?: string): Promise<void> {
  if (threadId && file) return openTurnFile(threadId, turnId, file)
  if (!threadId || (await readWorkspaceAvailability(threadId)) !== 'own') {
    openSurface('git')
    return
  }
  const store = useChangesStore.getState()
  if (turnId) store.openTurn(threadId, turnId)
  else store.openThread(threadId)
  openSurface('git')
}
