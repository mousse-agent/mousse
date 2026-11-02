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

/** Said where Publish is asked of a thread in its project's folder. */
export const PROJECT_FOLDER_PUBLISH_REASON = "This chat works in the project folder, so its changes are already there; there is nothing to publish."

/** Said where a workflow is started from a thread in its project's folder. */
export const PROJECT_FOLDER_WORKFLOW_REASON = 'This chat works in the project folder. Turn on the worktree for this chat to run workflows.'
