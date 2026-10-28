import type { Project, Thread } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import { sortSidebarThreads } from '../../shared/threadSidebarSort'
import { isThreadStarted } from '../../shared/threadTitle'
import { groupProjects } from './projectGroups'

/**
 * The ids of the threads in the order the sidebar lists them, ignoring which projects are collapsed.
 * Projects view: each project group in its list order with its threads, then the threads without a project.
 * A group holds the threads of a project and of the other computers' projects for the same repository, in
 * one sidebar order. Threads view: one list. Settled threads, empty drafts and subagent threads are not
 * listed. `excluded` holds threads the sidebar leaves out because another list owns them (agent chats).
 */
export function orderedThreadIds(input: {
  projects: readonly Pick<Project, 'id' | 'node' | 'sameAs'>[]
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
  const { groups, groupOf } = groupProjects(input.projects)
  return [
    ...groups.flatMap((group) => listed.filter((thread) => thread.projectId && groupOf.get(thread.projectId) === group.id)),
    ...listed.filter((thread) => !thread.projectId)
  ].map((thread) => thread.id)
}
