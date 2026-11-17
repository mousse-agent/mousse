import { isSubagentThread, visibleThreads } from '../../shared/threadLineage'
import { sortSidebarThreads } from '../../shared/threadSidebarSort'
import type { Project, Thread } from '../../shared/types'
import { openableThread } from './threadHistory'

/** One step of the title bar's path: the open thread's project, the threads above it, then the thread itself. */
export type PathSegment =
  | { kind: 'project'; id: string; name: string; none?: boolean }
  | { kind: 'thread'; id: string; name: string; current: boolean }

const threadName = (thread: Pick<Thread, 'name' | 'lineage'>): string =>
  thread.name.trim() || (isSubagentThread(thread) ? 'Subagent' : 'New thread')

/**
 * The path to `threadId`: its project (when it has one that is listed), the parents a subagent was
 * started from, top first, and the thread. Only subagents have parents here; a fork names no thread it
 * came from. Empty for an unknown thread.
 */
export function threadPath(threadId: string | null, threads: readonly Thread[], projects: readonly Pick<Project, 'id' | 'name'>[]): PathSegment[] {
  if (!threadId) return []
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const current = byId.get(threadId)
  if (!current) return []
  const chain: Thread[] = [current]
  const seen = new Set([current.id])
  for (let at = current; isSubagentThread(at);) {
    const parent = byId.get(at.lineage!.parentThreadId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    chain.unshift(parent)
    at = parent
  }
  const top = chain[0]!
  const projectId = top.projectId ?? current.projectId
  const project = projectId ? projects.find((entry) => entry.id === projectId) : undefined
  return [
    ...(project ? [{ kind: 'project' as const, id: project.id, name: project.name }] : []),
    ...chain.map((thread) => ({ kind: 'thread' as const, id: thread.id, name: threadName(thread), current: thread.id === current.id }))
  ]
}

/** Stands in front of a thread that has no project, so the path always starts with where the thread lives. */
export const NO_PROJECT_SEGMENT: PathSegment = { kind: 'project', id: '', name: 'No Project', none: true }

/** The path as the title bar shows it: led by the project, or by "No Project" when there is none. */
export function withProjectLead(segments: PathSegment[]): PathSegment[] {
  if (segments.length === 0 || segments[0]!.kind === 'project') return segments
  return [NO_PROJECT_SEGMENT, ...segments]
}

export interface SiblingMenu {
  label: string
  threads: { id: string; name: string }[]
}

/**
 * The threads beside `threadId` at its level, itself included, for the menu its path segment opens: a
 * subagent's fellow subagents of the same parent, or a top thread's fellow threads in its project (or,
 * without one, the other threads without a project), in sidebar order. Archived, unstarted and Chats
 * threads are left out, except the thread itself.
 */
export function siblingThreads(
  threadId: string,
  threads: readonly Thread[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
  excluded: ReadonlySet<string> = new Set()
): SiblingMenu | null {
  const thread = threads.find((entry) => entry.id === threadId)
  if (!thread) return null
  const listed = (entry: Thread) => entry.id === threadId || (openableThread(entry) && !excluded.has(entry.id))
  const parent = isSubagentThread(thread) ? threads.find((entry) => entry.id === thread.lineage!.parentThreadId) : undefined
  if (parent) {
    const children = threads.filter((entry) => isSubagentThread(entry) && entry.lineage!.parentThreadId === parent.id && listed(entry))
    return { label: `Subagents of ${threadName(parent)}`, threads: sortSidebarThreads(children).map((entry) => ({ id: entry.id, name: threadName(entry) })) }
  }
  const projectKnown = (id: string | undefined) => Boolean(id && projects.some((project) => project.id === id))
  const project = projectKnown(thread.projectId) ? projects.find((entry) => entry.id === thread.projectId) : undefined
  const peers = visibleThreads(threads).filter((entry) => listed(entry) && (project ? entry.projectId === project.id : !projectKnown(entry.projectId)))
  return {
    label: project ? `Threads in ${project.name}` : 'Other threads',
    threads: sortSidebarThreads(peers).map((entry) => ({ id: entry.id, name: threadName(entry) }))
  }
}

/**
 * How many leading segments drop into the "…" menu so the path fits `available` pixels. `widths` are
 * the segments' own widths, the current thread last; `moreWidth` is the "…" segment's. The topmost go
 * first and the current thread always stays: when even it alone does not fit, every other segment is
 * hidden and the thread's title is cut short instead.
 */
export function hiddenSegmentCount(widths: readonly number[], moreWidth: number, available: number): number {
  const last = widths.length - 1
  if (last <= 0) return 0
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= available) return 0
  let rest = total
  for (let hide = 1; hide < last; hide++) {
    rest -= widths[hide - 1]!
    if (moreWidth + rest <= available) return hide
  }
  return last
}
