import type { Project, Thread, ThreadActivitySnapshot } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import type { RemoteListsPort } from './remoteListsPort'
import type { ProtocolClientType, ProtocolEvent } from './types'

/**
 * Which threads a client is shown. The thread inventory is always complete; this is the one place
 * that decides who sees subagent threads. Only the desktop app does, and a routed call from another
 * of the user's computers (the same person, in the same app): it needs them to fold each under its
 * parent (Lineage, sidebar roll-up). Every other client (CLI, linked phones, tests,
 * unknown) gets lists without subagent threads. A client with no connection at all, such as a
 * phone's backend, is one of those.
 */
export function connectionSeesSubagents(connection: { readonly clientType?: ProtocolClientType } | undefined): boolean {
  return connection?.clientType === 'gui' || connection?.clientType === 'bridge'
}

/**
 * `threads` as `connection` should see them. `inventory` is the complete list parents are looked up
 * in; give it whenever `threads` is a slice (one project), so a slice never makes a parent look
 * missing and a subagent look orphaned. Filtering happens here, before any limit a caller applies.
 */
export function visibleThreadsFor(
  connection: { readonly clientType?: ProtocolClientType } | undefined,
  threads: readonly Thread[],
  inventory: readonly Thread[] = threads
): Thread[] {
  return connectionSeesSubagents(connection) ? [...threads] : visibleThreads(threads, inventory)
}

/** What a handler knows of its caller: who it is, and the merged lists of the profile it runs in. */
export interface ListedContext {
  readonly connection?: { readonly clientType?: ProtocolClientType }
  readonly mms?: { readonly remoteLists?: RemoteListsPort }
}

/**
 * `visibleThreadsFor` for a handler: the same threads, and for a window the rows of the user's other
 * computers after them. Every result a handler returns as the list of threads, and every event of the
 * list, goes through this, so a local rename or create never drops the rows of other computers. Give
 * `scope` when `threads` is one project's (or the standalone) slice, so only that group's remote rows
 * are added.
 */
export function listedThreadsFor(
  ctx: ListedContext,
  threads: readonly Thread[],
  inventory: readonly Thread[] = threads,
  scope?: { projectId: string | null }
): Thread[] {
  const local = visibleThreadsFor(ctx.connection, threads, inventory)
  if (ctx.connection?.clientType !== 'gui') return local
  const remote = ctx.mms?.remoteLists?.threads(scope)
  return remote?.length ? [...local, ...remote] : local
}

/** This computer's projects and, for a window, those of its other computers after them. */
export function listedProjectsFor(ctx: ListedContext, projects: readonly Project[]): Project[] {
  if (ctx.connection?.clientType !== 'gui') return [...projects]
  const remote = ctx.mms?.remoteLists?.projects()
  return remote?.length ? [...projects, ...remote] : [...projects]
}

/** Rows that are not another computer's: the ones an event or result of this computer wrote itself. */
const ownRows = <T extends { node?: string }>(rows: readonly T[]): T[] => rows.filter((row) => !row.node)

/**
 * The event as a window should see it, with the other computers' rows added to the lists it carries
 * (`threads.updated`, `projects.updated`) and their statuses to the activity snapshot. Undefined for any other event.
 */
function withRemoteLists(event: ProtocolEvent, remote: RemoteListsPort): ProtocolEvent | undefined {
  const data = event.data
  switch (event.type) {
    case 'threads.updated': {
      const rows = remote.threads()
      if (Array.isArray(data)) return { ...event, data: [...ownRows(data as Thread[]), ...rows] }
      if (data && typeof data === 'object' && Array.isArray((data as { threads?: unknown }).threads))
        return { ...event, data: { ...data, threads: [...ownRows((data as { threads: Thread[] }).threads), ...rows] } }
      return undefined
    }
    case 'projects.updated': {
      if (data && typeof data === 'object' && Array.isArray((data as { projects?: unknown }).projects))
        return {
          ...event,
          data: { ...data, projects: [...ownRows((data as { projects: Project[] }).projects), ...remote.projects()] }
        }
      return undefined
    }
    // A thread's own activity event also carries the whole map, which a window takes as the state of every thread.
    case 'activity':
    case 'activity.snapshot': {
      const activity = (data as { activity?: unknown } | null)?.activity
      if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return undefined
      return { ...event, data: { ...(data as object), activity: { ...(activity as ThreadActivitySnapshot), ...remote.activity() } } }
    }
    default:
      return undefined
  }
}

/**
 * A pushed `threads.updated` event as one client should receive it. The event in the replay ring
 * carries the complete inventory of this computer; each client gets its own projection, applied when the
 * event is delivered, buffered or replayed. A window also gets the other computers' rows (`remote`).
 * Other events, and events for clients that see subagents, are returned as they are.
 */
export function projectEventFor(
  clientType: ProtocolClientType | undefined,
  event: ProtocolEvent,
  remote?: RemoteListsPort
): ProtocolEvent {
  if (clientType === 'gui' && remote) {
    const merged = withRemoteLists(event, remote)
    if (merged) return merged
  }
  if (event.type !== 'threads.updated' || connectionSeesSubagents({ clientType })) return event
  const data = event.data
  if (Array.isArray(data)) return { ...event, data: visibleThreads(data as Thread[]) }
  if (data && typeof data === 'object' && Array.isArray((data as { threads?: unknown }).threads)) {
    return { ...event, data: { ...data, threads: visibleThreads((data as { threads: Thread[] }).threads) } }
  }
  return event
}
