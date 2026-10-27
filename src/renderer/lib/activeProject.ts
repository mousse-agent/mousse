import type { GitScope } from '../../shared/types'

export interface ActiveProjectInput {
  /** The thread is the new-chat composer state, where the workspace draft decides the project. */
  isNewChat: boolean
  /** Project of the composer workspace draft, falling back to the thread's own. */
  draftProjectId: string | undefined
  /** Project the selected thread belongs to. */
  threadProjectId: string | null
  projects: ReadonlyArray<{ id: string; path: string }>
  /** Folder of the selected thread, as resolved for its own project. */
  resolved: {
    path: string | null
    loading: boolean
    /** Set when `path` is the thread's own ready worktree rather than the project folder. */
    workspaceThreadId?: string | null
  }
}

export interface ActiveProject {
  projectId: string | null
  path: string | null
  /** The folder is still being looked up, so a null path is not an answer yet. */
  loading: boolean
  /** The thread whose own worktree `path` is; null when `path` is the project folder. */
  workspaceThreadId: string | null
}

/**
 * The project and folder the surfaces beside the thread work on. An empty new
 * chat follows the project picked in the composer, since picking only changes
 * the workspace draft; any other thread keeps its own project and resolved folder.
 */
export function resolveActiveProject(input: ActiveProjectInput): ActiveProject {
  if (input.isNewChat && input.draftProjectId) {
    const path = input.projects.find((project) => project.id === input.draftProjectId)?.path ?? null
    return { projectId: input.draftProjectId, path, loading: false, workspaceThreadId: null }
  }
  return {
    projectId: input.isNewChat ? null : input.threadProjectId,
    path: input.resolved.path,
    loading: input.resolved.loading,
    workspaceThreadId: input.isNewChat ? null : input.resolved.workspaceThreadId ?? null
  }
}

/** What a Git mutation sends the daemon: the thread when the folder is its own worktree, the project otherwise. */
export function gitScopeFor(location: Pick<ActiveProject, 'projectId' | 'workspaceThreadId'>): GitScope {
  return { projectId: location.projectId, workspaceThreadId: location.workspaceThreadId ?? null }
}
