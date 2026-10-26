// Reads the Review panel and the turn row depend on. No React or Monaco, so tests can load it.
import type { TurnPhase } from '../../../shared/types'
import { invalidateThreadActionHistory, readThreadActionHistory, type ThreadActionHistory } from '../../utils/threadActionHistory'

/**
 * Reads a thread's action history. `fresh` is for a turn that just finished and for the refresh button:
 * `readThreadActionHistory` reuses a result for 3 seconds and hands back an in-flight read, either of
 * which can still show the turn as running, so the cached entry is dropped first.
 */
export function readReviewHistory(threadId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<ThreadActionHistory> {
  if (fresh) invalidateThreadActionHistory(threadId)
  return readThreadActionHistory(threadId)
}

/** True when a turn has just settled: the phase was something else and is now idle. */
export function turnReturnedToIdle(previous: TurnPhase | undefined, next: TurnPhase | undefined): boolean {
  return next === 'idle' && previous !== undefined && previous !== 'idle'
}

export type WorkspaceAvailability = 'own' | 'shared'

/**
 * Whether the thread has a worktree of its own. Only those are checkpointed per turn, so only those
 * have turns and a base to review; a thread on the primary checkout has just the working tree.
 */
export async function readWorkspaceAvailability(threadId: string): Promise<WorkspaceAvailability> {
  try {
    const status = (await window.mousse.workspace.getStatus(threadId)) as {
      metadata?: { lifecycle?: string } | null
      execution?: { lifecycle?: string; workspacePath?: string; primaryPath?: string }
    }
    const execution = status.execution
    const ready = status.metadata?.lifecycle === 'ready' && execution?.lifecycle === 'ready'
    const own = ready && !!execution?.workspacePath && execution.workspacePath !== execution.primaryPath
    return own ? 'own' : 'shared'
  } catch {
    return 'shared'
  }
}
