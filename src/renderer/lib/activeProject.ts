import type { GitScope } from '../../shared/types'

export interface ActiveProjectInput {
  /** The thread is the new-chat composer state, where the workspace draft decides the project. */
  isNewChat: boolean
  /** Project of the composer workspace draft, falling back to the thread's own. */
  draftProjectId: string | undefined
  draftWorktree?: boolean
  /** Project the selected thread belongs to. */
  threadProjectId: string | null
  projects: ReadonlyArray<{ id: string; path: string }>
  /** Folder of the selected thread, as resolved for its own project. */
  resolved: {
    path: string | null
    loading: boolean
    provisioning?: boolean
    /** Set when `path` is the thread's own ready worktree rather than the project folder. */
    workspaceThreadId?: string | null
    /** That worktree's generation. */
    workspaceGeneration?: number
    /** Why the thread's own worktree cannot be read now (not on disk, its drive not answering); `path` is then null. */
    unavailable?: string
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
  /** The thread is waiting for its checkout to be made. */
  provisioning?: boolean
  /** The thread whose own worktree `path` is; null when `path` is the project folder. */
  workspaceThreadId: string | null
  /** That worktree's generation: what is cached of it is cached under it (`folderKey`). */
  workspaceGeneration?: number
  /** Why the thread's own worktree cannot be read now; the Git section says so instead of reading anything. */
  unavailable?: string
  /** Looks the folder up again (Retry). */
  retry?: () => void
}

/**
 * The project and folder the surfaces beside the thread work on. An empty new
 * chat follows the project picked in the composer, since picking only changes
 * the workspace draft; any other thread keeps its own project and resolved folder.
 */
export function resolveActiveProject(input: ActiveProjectInput): ActiveProject {
  if (input.isNewChat && input.draftProjectId) {
    if (input.draftWorktree) return { projectId: input.draftProjectId, path: null, key: null, loading: true, provisioning: true, workspaceThreadId: null }
    const path = input.projects.find((project) => project.id === input.draftProjectId)?.path ?? null
    return { projectId: input.draftProjectId, path, key: path ? folderKey({ projectId: input.draftProjectId, workspaceThreadId: null }) : null, loading: false, workspaceThreadId: null }
  }
  const projectId = input.isNewChat ? null : input.threadProjectId
  const workspaceThreadId = input.isNewChat ? null : input.resolved.workspaceThreadId ?? null
  const workspaceGeneration = workspaceThreadId ? input.resolved.workspaceGeneration : undefined
  const unavailable = input.isNewChat ? undefined : input.resolved.unavailable
  return {
    projectId,
    path: input.resolved.path,
    key: input.resolved.path ? folderKey({ projectId, workspaceThreadId, ...(workspaceGeneration !== undefined ? { workspaceGeneration } : {}) }) : null,
    loading: input.resolved.loading,
    ...(input.resolved.provisioning ? { provisioning: true } : {}),
    workspaceThreadId,
    ...(workspaceGeneration !== undefined ? { workspaceGeneration } : {}),
    ...(unavailable ? { unavailable } : {})
  }
}

/**
 * When to look for a thread's folder again: on each turn phase change of a project thread whose folder is still the
 * project's. A new worktree thread gets its worktree when its first turn starts, after the thread was selected, so
 * without this the Git section and the file tree would keep showing the project folder (and its branch) until the
 * thread is selected again. Null once the folder is the thread's own worktree, or for a thread with no project.
 */
export function folderRecheckKey(input: {
  threadId: string | null
  threadProjectId: string | null
  /** The thread whose worktree the last lookup found; null when it found the project folder. */
  resolvedWorkspaceThreadId: string | null
  turnPhase: string | null
}): string | null {
  if (!input.threadId || !input.threadProjectId || input.resolvedWorkspaceThreadId) return null
  return input.turnPhase
}

/**
 * What the folder a scope names is cached under. A thread's own worktree is the thread's; any other folder is
 * its project's. Ids, not paths: two folders with the same path on two computers are two entries, and a
 * path is not parsed or compared on this computer. Null when the scope names no folder.
 */
export function folderKey(scope: GitScope): string | null {
  // A rebuilt worktree is another folder: nothing read of the one before it shows for it.
  if (scope.workspaceThreadId) return `thread:${scope.workspaceThreadId}${scope.workspaceGeneration ? `@${scope.workspaceGeneration}` : ''}`
  if (scope.projectId) return `project:${scope.projectId}`
  return null
}

/** What a Git mutation sends the daemon: the thread when the folder is its own worktree, the project otherwise. */
export function gitScopeFor(location: Pick<ActiveProject, 'projectId' | 'workspaceThreadId'> & { workspaceGeneration?: number }): GitScope {
  const generation = location.workspaceThreadId ? location.workspaceGeneration : undefined
  return { projectId: location.projectId, workspaceThreadId: location.workspaceThreadId ?? null, ...(generation !== undefined ? { workspaceGeneration: generation } : {}) }
}
