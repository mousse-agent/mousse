import { join } from 'path'
import type { ChatReference } from '../../shared/chatReferences'
import type { ProjectManager } from './ProjectManager'
import type { ThreadDataStore } from './ThreadDataStore'

/**
 * Resolves sidebar resources against the active profile's stores. Keep this in
 * the daemon: renderer code must never guess profile roots or legacy layouts.
 */
export class ChatReferenceMetadataResolver {
  constructor(
    private readonly threads: Pick<ThreadDataStore, 'getThread' | 'getThreadDir'>,
    private readonly projects: Pick<ProjectManager, 'getProject'>,
    private readonly profileHomeDir: string
  ) {}

  resolve(input: Pick<ChatReference, 'kind' | 'title' | 'threadId' | 'projectId'>): ChatReference | null {
    if (input.kind === 'thread' && input.threadId) {
      const thread = this.threads.getThread(input.threadId)
      if (!thread) return null
      return {
        id: `thread:${thread.id}`,
        kind: 'thread',
        title: input.title || thread.name,
        threadId: thread.id,
        projectId: thread.projectId,
        metadataPath: join(this.threads.getThreadDir(thread.id), 'meta.json')
      }
    }
    if (input.kind === 'project' && input.projectId) {
      const project = this.projects.getProject(input.projectId)
      if (!project) return null
      return {
        id: `project:${project.id}`,
        kind: 'project',
        title: input.title || project.name,
        projectId: project.id,
        path: project.path,
        metadataPath: join(this.profileHomeDir, 'projects.json')
      }
    }
    return null
  }
}
