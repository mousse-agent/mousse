import type { ProjectManager } from './ProjectManager'
import type { ThreadDataStore } from './ThreadDataStore'

export function resolveActiveProjectPath(
  projectManager: ProjectManager,
  threadStore: ThreadDataStore,
  activeThreadId: string | null
): string | undefined {
  if (!activeThreadId) return undefined
  const thread = threadStore.getThread(activeThreadId)
  if (!thread?.projectId) return undefined
  return projectManager.getProject(thread.projectId)?.path
}

export function resolveThreadProjectPath(
  projectManager: ProjectManager,
  threadStore: ThreadDataStore,
  threadId: string
): string | undefined {
  const thread = threadStore.getThread(threadId)
  if (!thread?.projectId) return undefined
  return projectManager.getProject(thread.projectId)?.path
}
