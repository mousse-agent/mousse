import type { Project, Thread } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import { sortSidebarThreads } from '../../shared/threadSidebarSort'
import { isThreadStarted } from '../../shared/threadTitle'

/**
 * The ids of the threads in the order the sidebar lists them, ignoring which projects are collapsed.
 * Projects view: each project in its list order with its threads, then the threads without a project.
 * Threads view: one list. Settled threads, empty drafts and subagent threads are not listed.
 * `excluded` holds threads the sidebar leaves out because another list owns them (agent chats).
 */
export function orderedThreadIds(input: {
  projects: readonly Pick<Project, 'id'>[]
  threads: readonly Thread[]
  view: 'projects' | 'threads' | 'chats'
  excluded?: ReadonlySet<string>
}): string[] {
  const listed = sortSidebarThreads(
    visibleThreads(input.threads).filter(
      (thread) => !thread.settledAt && isThreadStarted(thread) && !input.excluded?.has(thread.id)
    )
  )
  if (input.view !== 'projects') return listed.map((thread) => thread.id)
  return [
    ...input.projects.flatMap((project) => listed.filter((thread) => thread.projectId === project.id)),
    ...listed.filter((thread) => !thread.projectId)
  ].map((thread) => thread.id)
}
