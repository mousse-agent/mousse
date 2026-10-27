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
  /** The folder on disk, for showing and for opening elsewhere. Reads and caches never use it; see `key`. */
  path: string | null
  /** What Git state, running Git actions and pull requests of this folder are cached under; see `folderKey`. Null with no folder. */
  key: string | null
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
    return { projectId: input.draftProjectId, path, key: path ? folderKey({ projectId: input.draftProjectId, workspaceThreadId: null }) : null, loading: false, workspaceThreadId: null }
  }
  const projectId = input.isNewChat ? null : input.threadProjectId
  const workspaceThreadId = input.isNewChat ? null : input.resolved.workspaceThreadId ?? null
  return {
    projectId,
    path: input.resolved.path,
    key: input.resolved.path ? folderKey({ projectId, workspaceThreadId }) : null,
    loading: input.resolved.loading,
    workspaceThreadId
  }
}

/**
 * What the folder a scope names is cached under. A thread's own worktree is the thread's; any other folder is
 * its project's. Ids, not paths: two folders with the same path on two computers are two entries, and a
 * path is not parsed or compared on this computer. Null when the scope names no folder.
 */
export function folderKey(scope: GitScope): string | null {
  if (scope.workspaceThreadId) return `thread:${scope.workspaceThreadId}`
  if (scope.projectId) return `project:${scope.projectId}`
  return null
}

/** What a Git mutation sends the daemon: the thread when the folder is its own worktree, the project otherwise. */
export function gitScopeFor(location: Pick<ActiveProject, 'projectId' | 'workspaceThreadId'>): GitScope {
  return { projectId: location.projectId, workspaceThreadId: location.workspaceThreadId ?? null }
}
