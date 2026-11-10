import type { Thread } from '../../shared/types'
import { newThreadWorktree, type ProjectChoices } from './newThread'

/**
 * The worktree mark, only where a thread differs from where its project's new threads start (`newThreadWorktree`):
 * a worktree thread when they use the project's folder, or a thread on the project's folder when they use worktrees.
 * A thread with no recorded choice, or without a project, is not marked.
 */
export function worktreeMark(thread: Pick<Thread, 'projectId' | 'worktreeEnabled'>, projects: ProjectChoices): 'Worktree' | 'Primary checkout' | undefined {
  if (!thread.projectId || typeof thread.worktreeEnabled !== 'boolean' || thread.worktreeEnabled === newThreadWorktree(projects, thread.projectId)) return undefined
  return thread.worktreeEnabled ? 'Worktree' : 'Primary checkout'
}
