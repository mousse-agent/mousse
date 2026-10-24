import { isThreadStarted } from '../../shared/threadTitle'

/** Where a new chat will run: the project it starts in and whether that is a fresh worktree. */
export interface ComposerWorkspace {
  projectId?: string
  worktreeEnabled: boolean
}

/**
 * True for the composer's new-chat state: no thread selected yet, or a selected
 * thread that has not been started and has no messages. The composer and the
 * thread side card both use this to decide when the workspace can still change.
 */
export function isNewEmptyThread(
  activeThreadId: string | null,
  thread: { startedAt?: string; name?: string } | undefined,
  messageCount: number
): boolean {
  return !activeThreadId || Boolean(thread && !isThreadStarted(thread) && messageCount === 0)
}

/** The workspace draft for the new chat, falling back to what the thread already has. */
export function composerWorkspaceFor(
  draft: ComposerWorkspace | undefined,
  thread: { projectId?: string; worktreeEnabled?: boolean } | undefined
): ComposerWorkspace {
  return draft ?? { projectId: thread?.projectId, worktreeEnabled: Boolean(thread?.worktreeEnabled) }
}
