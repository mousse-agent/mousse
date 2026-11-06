import { openSurface } from '../../lib/surfaces'
import { useReviewStore } from '../../stores/reviewStore'
import { readWorkspaceAvailability } from './reviewData'

/**
 * Opens a turn's changes from the changed-files summary under it, at `file` when a file row was clicked
 * (the path the agent wrote, absolute or relative to the worktree). A summary without a turn id (a
 * transcript from before turns were recorded) opens the whole thread. A thread with no worktree of its
 * own has no turns to review, so it opens the Git surface, as the summary did before.
 */
export async function openTurnInReview(threadId: string | null, turnId: string | undefined, file?: string): Promise<void> {
  if (!threadId || (await readWorkspaceAvailability(threadId)) !== 'own') {
    openSurface('git')
    return
  }
  const store = useReviewStore.getState()
  if (turnId) store.openTurn(threadId, turnId, file)
  else store.openThread(threadId, file)
  openSurface('review')
}
