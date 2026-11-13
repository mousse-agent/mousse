import type { Project, Thread } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import { sortSidebarThreads, sortThreadFeed } from '../../shared/threadSidebarSort'
import { isThreadStarted } from '../../shared/threadTitle'
import { groupProjects } from './projectGroups'

/**
 * The ids of the threads in the order the sidebar lists them, ignoring which projects are collapsed.
 * Projects view: each project group in its list order with its threads, then the threads without a project.
 * A group holds the threads of a project and of the other computers' projects for the same repository, in
 * one sidebar order. Threads view: one list, in the order its rows were dragged into, threads started since
 * on top. Settled threads, empty drafts and subagent threads are not listed. `excluded` holds threads the
 * sidebar leaves out because another list owns them (agent chats).
 */
export function orderedThreadIds(input: {
  projects: readonly Pick<Project, 'id' | 'node' | 'sameAs'>[]
  threads: readonly Thread[]
  view: 'projects' | 'threads' | 'chats'
  excluded?: ReadonlySet<string>
  /** The Threads tab's dragged order (see `sortThreadFeed`). */
  arranged?: readonly string[]
}): string[] {
  const started = visibleThreads(input.threads).filter(
    (thread) => !thread.settledAt && isThreadStarted(thread) && !input.excluded?.has(thread.id)
  )
  if (input.view !== 'projects') return sortThreadFeed(started, input.arranged).map((thread) => thread.id)
  const listed = sortSidebarThreads(started)
  const { groups, groupOf } = groupProjects(input.projects)
  return [
    ...groups.flatMap((group) => listed.filter((thread) => thread.projectId && groupOf.get(thread.projectId) === group.id)),
    ...listed.filter((thread) => !thread.projectId)
  ].map((thread) => thread.id)
}

/**
 * The thread to open when `threadId`, the open one, is archived: the next one in its project group as the sidebar
 * lists it, or the one before it when it was the last. Threads without a project count as one group. Null when it
 * was the group's only thread.
 */
export function threadAfterArchive(input: {
  projects: readonly Pick<Project, 'id' | 'node' | 'sameAs'>[]
  threads: readonly Thread[]
  threadId: string
  excluded?: ReadonlySet<string>
}): string | null {
  const { groupOf } = groupProjects(input.projects)
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]))
  const groupKey = (id: string) => {
    const projectId = byId.get(id)?.projectId
    return projectId ? groupOf.get(projectId) ?? projectId : null
  }
  const target = groupKey(input.threadId)
  const ids = orderedThreadIds({ projects: input.projects, threads: input.threads, view: 'projects', excluded: input.excluded })
    .filter((id) => groupKey(id) === target)
  const index = ids.indexOf(input.threadId)
  if (index === -1) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}
