import { openSurface } from '../../lib/surfaces'
import { useChangesStore } from '../../stores/changesStore'
import { readWorkspaceAvailability } from '../review/reviewData'

/**
 * Opens a turn's changes in the Changes tab from a chat edit line or the changed-files summary under a turn,
 * at `file` when a file row was clicked (the path the agent wrote, absolute or relative to the worktree). A
 * summary without a turn id (a transcript from before turns were recorded) opens the whole thread. A thread
 * with no worktree of its own has no turns, so the tab opens on its uncommitted changes.
 */
export async function openTurnInChanges(threadId: string | null, turnId: string | undefined, file?: string): Promise<void> {
  if (!threadId || (await readWorkspaceAvailability(threadId)) !== 'own') {
    openSurface('git')
    return
  }
  const store = useChangesStore.getState()
  if (turnId) store.openTurn(threadId, turnId, file)
  else store.openThread(threadId, file)
  openSurface('git')
}
