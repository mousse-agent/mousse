import type { Thread } from '../../shared/types'

/**
 * The worktree mark, only where a thread differs from "Start new threads in a worktree": a worktree thread
 * when new threads use the project's folder, or a thread on the project's folder when they use worktrees.
 * A thread with no recorded choice, or without a project, is not marked.
 */
export function worktreeMark(thread: Pick<Thread, 'projectId' | 'worktreeEnabled'>, worktreeByDefault: boolean): 'Worktree' | 'Primary checkout' | undefined {
  if (!thread.projectId || typeof thread.worktreeEnabled !== 'boolean' || thread.worktreeEnabled === worktreeByDefault) return undefined
  return thread.worktreeEnabled ? 'Worktree' : 'Primary checkout'
}
