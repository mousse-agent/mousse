import { isSubagentThread, visibleThreads } from '../../shared/threadLineage'
import { sortSidebarThreads } from '../../shared/threadSidebarSort'
import { qualifyId } from '../../shared/threadRef'
import type { Project, Thread } from '../../shared/types'
import { openableThread } from './threadHistory'

/**
 * One step of the title bar's path: the open thread's project, the threads above it, the thread itself, and,
 * while one of its native subagents is open on its own page, that subagent.
 */
export type PathSegment =
  | { kind: 'project'; id: string; name: string; none?: boolean }
  | { kind: 'thread'; id: string; name: string; current: boolean }
  | { kind: 'native'; id: string; name: string }

const threadName = (thread: Pick<Thread, 'name' | 'lineage'>): string =>
  thread.name.trim() || (isSubagentThread(thread) ? 'Subagent' : 'New thread')

/** The threads by id, and this computer's stand-ins for subagents on other computers by the thread that runs them there. */
interface ThreadIndex {
  byId: Map<string, Thread>
  standIns: Map<string, Thread>
}

function indexThreads(threads: readonly Thread[]): ThreadIndex {
  const standIns = new Map<string, Thread>()
  for (const thread of threads) if (thread.runsOn?.ref && isSubagentThread(thread)) standIns.set(thread.runsOn.ref, thread)
  return { byId: new Map(threads.map((thread) => [thread.id, thread])), standIns }
}

/**
 * The thread `thread` sits below, wherever either runs: a subagent's parent; for the thread another computer
 * runs for a subagent of this one, the parent of this computer's stand-in for it (`runsOn.ref`); or, for the
 * thread this computer runs for a subagent of another computer, the thread whose agent started it there
 * (`startedFrom.agent` with `subagent`). That thread is named there by its id on its own computer: qualified here,
 * or plain when its computer is this one and the row is another's. A thread an agent started with `thread_create`,
 * on this computer or another, sits below none, as one started by `createdByThreadId` does.
 */
function parentOf(thread: Thread, { byId, standIns }: ThreadIndex): Thread | undefined {
  if (isSubagentThread(thread)) return byId.get(thread.lineage!.parentThreadId)
  const standIn = standIns.get(thread.id)
  if (standIn) return byId.get(standIn.lineage!.parentThreadId)
  const from = thread.startedFrom
  if (!from?.agent?.subagent) return undefined
  return byId.get(qualifyId(from.node, from.agent.thread)) ?? (thread.node && thread.node !== from.node ? byId.get(from.agent.thread) : undefined)
}

/**
 * The path to `threadId`: its project (when it has one that is listed), the threads above it, top first,
 * and the thread. A thread is below the one that started it as a subagent, on this computer or another; a thread
 * an agent started as its own and a fork name no thread they came from. Empty for an unknown thread.
 */
export function threadPath(threadId: string | null, threads: readonly Thread[], projects: readonly Pick<Project, 'id' | 'name'>[]): PathSegment[] {
  if (!threadId) return []
  const index = indexThreads(threads)
  const current = index.byId.get(threadId)
  if (!current) return []
  const chain: Thread[] = [current]
  const seen = new Set([current.id])
  for (let parent = parentOf(current, index); parent && !seen.has(parent.id); parent = parentOf(parent, index)) {
    seen.add(parent.id)
    chain.unshift(parent)
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

/**
 * The path with the open native subagent (its call id and name) after the thread: the thread becomes a step
 * above it, and the subagent is where the window is. Unchanged without one.
 */
export function withNativeSubagent(segments: PathSegment[], native: { id: string; name: string } | null): PathSegment[] {
  if (!native || segments.length === 0) return segments
  return [
    ...segments.map((segment) => (segment.kind === 'thread' && segment.current ? { ...segment, current: false } : segment)),
    { kind: 'native', id: native.id, name: native.name }
  ]
}

export interface SiblingMenu {
  label: string
  threads: { id: string; name: string }[]
}

/**
 * The threads beside `threadId` at its level, itself included, for the menu its path segment opens: a
 * subagent (`parentOf`) the other subagents of its parent, or a top thread's fellow threads in its project (or,
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
  const index = indexThreads(threads)
  const parent = parentOf(thread, index)
  if (parent) {
    // A stand-in whose thread on the other computer is listed gives way to it: that is the one the path opens.
    const standInShown = (entry: Thread) => Boolean(entry.runsOn?.ref && index.byId.has(entry.runsOn.ref))
    const children = threads.filter((entry) => listed(entry) && parentOf(entry, index)?.id === parent.id && (entry.id === threadId || !standInShown(entry)))
    return { label: `Subagents of ${threadName(parent)}`, threads: sortSidebarThreads(children).map((entry) => ({ id: entry.id, name: threadName(entry) })) }
  }
  const projectKnown = (id: string | undefined) => Boolean(id && projects.some((project) => project.id === id))
  const project = projectKnown(thread.projectId) ? projects.find((entry) => entry.id === thread.projectId) : undefined
  const peers = visibleThreads(threads).filter((entry) => listed(entry) && (project ? entry.projectId === project.id : !projectKnown(entry.projectId)))
  return {
    label: project ? `Threads in ${project.name}` : 'No project',
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
