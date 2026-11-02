import type { Thread } from '../../shared/types'

/**
 * Where a thread does its work. `worktree`: its own Git worktree, made at its first edit. `project-folder`: the
 * project's own folder, and no worktree is ever made for it, by any path (a turn, a file write, a terminal, a Git
 * action, a workflow, a fork or a restore). It is the one answer to that question: every path that could make a
 * thread's worktree asks it first.
 */
export type ThreadPlacement = 'worktree' | 'project-folder'

/**
 * A thread whose worktree toggle was turned off (`worktreeEnabled: false`) works in the project folder. Any other
 * thread, including one with no recorded choice (older threads, and threads agents, workflows and pull requests
 * start), gets a worktree on a Git project.
 */
export function threadPlacement(thread: Pick<Thread, 'worktreeEnabled'> | null | undefined): ThreadPlacement {
  return thread?.worktreeEnabled === false ? 'project-folder' : 'worktree'
}

/** Said where a path would have needed the thread's worktree. */
export const PROJECT_FOLDER_REASON = 'This chat works in the project folder (its worktree is off), so it has no worktree.'
