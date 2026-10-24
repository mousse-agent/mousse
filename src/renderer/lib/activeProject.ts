export interface ActiveProjectInput {
  /** The thread is the new-chat composer state, where the workspace draft decides the project. */
  isNewChat: boolean
  /** Project of the composer workspace draft, falling back to the thread's own. */
  draftProjectId: string | undefined
  /** Project the selected thread belongs to. */
  threadProjectId: string | null
  projects: ReadonlyArray<{ id: string; path: string }>
  /** Folder of the selected thread, as resolved for its own project. */
  resolved: { path: string | null; loading: boolean }
}

export interface ActiveProject {
  projectId: string | null
  path: string | null
  /** The folder is still being looked up, so a null path is not an answer yet. */
  loading: boolean
}

/**
 * The project and folder the surfaces beside the thread work on. An empty new
 * chat follows the project picked in the composer, since picking only changes
 * the workspace draft; any other thread keeps its own project and resolved folder.
 */
export function resolveActiveProject(input: ActiveProjectInput): ActiveProject {
  if (input.isNewChat && input.draftProjectId) {
    const path = input.projects.find((project) => project.id === input.draftProjectId)?.path ?? null
    return { projectId: input.draftProjectId, path, loading: false }
  }
  return {
    projectId: input.isNewChat ? null : input.threadProjectId,
    path: input.resolved.path,
    loading: input.resolved.loading
  }
}
