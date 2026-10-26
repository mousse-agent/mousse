import { openSurface } from '../../lib/surfaces'
import { useReviewStore } from '../../stores/reviewStore'
import { readWorkspaceAvailability } from './reviewData'

/**
 * Opens a turn's changes from the "Review changes" row under it. A row without a turn id (a transcript
 * from before turns were recorded) opens the whole thread. A thread with no worktree of its own has no
 * turns to review, so it opens the Git surface, as the row did before.
 */
export async function openTurnInReview(threadId: string | null, turnId: string | undefined): Promise<void> {
  if (!threadId || (await readWorkspaceAvailability(threadId)) !== 'own') {
    openSurface('git')
    return
  }
  const store = useReviewStore.getState()
  if (turnId) store.openTurn(threadId, turnId)
  else store.openThread(threadId)
  openSurface('review')
}
