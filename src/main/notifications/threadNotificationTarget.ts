import type { Thread } from '../../shared/types'
import { isSubagentThread, nearestVisibleAncestor } from '../../shared/threadLineage'
import type { ThreadNotificationKind } from './threadNotification'

type NotificationThread = Pick<Thread, 'id' | 'name' | 'lineage' | 'projectId'>

/** What a notification is about once subagents are folded under their parents. */
export interface ThreadNotificationTarget {
  /** The thread the notification opens and is judged against: the nearest ancestor shown in the sidebar. */
  threadId: string
  /** Set when a subagent's question is announced under its parent; the parent's name. */
  parentName?: string
  /** The thread that raised the notification, when that is a subagent; viewing it counts as viewing the target. */
  viaThreadId?: string
}

/**
 * Who a notification is for. A subagent finishing or pausing is not news: the parent reports the
 * outcome when it hears back. A subagent's question is, so it is announced under its nearest
 * visible ancestor's name. A thread nobody knows lineage for notifies as itself.
 */
export function resolveThreadNotification(
  threadId: string,
  kind: ThreadNotificationKind,
  threads: ReadonlyMap<string, NotificationThread>
): ThreadNotificationTarget | null {
  const thread = threads.get(threadId)
  if (!thread || !isSubagentThread(thread)) return { threadId }
  const ancestorId = nearestVisibleAncestor(threadId, [...threads.values()])
  // A subagent whose parent is gone is listed as a normal thread, so it notifies as one.
  if (!ancestorId || ancestorId === threadId) return { threadId }
  if (kind !== 'question') return null
  return { threadId: ancestorId, parentName: threads.get(ancestorId)?.name?.trim() || undefined, viaThreadId: threadId }
}

/** A notification target with what the banner names: the thread it opens and that thread's project. */
export interface NamedThreadNotificationTarget extends ThreadNotificationTarget {
  threadName?: string
  projectName?: string
}

function rowsOf(data: unknown, key: 'threads' | 'projects'): unknown[] | null {
  const rows = Array.isArray(data) ? data : (data as Record<string, unknown> | null)?.[key]
  return Array.isArray(rows) ? rows : null
}

/** The thread rows and project names the main process has seen, per profile, for resolving notifications. */
export class NotificationThreadIndex {
  private readonly byProfile = new Map<string, Map<string, NotificationThread>>()
  private readonly projectNames = new Map<string, Map<string, string>>()

  /** Replaces a profile's rows from a thread list, or from an event or reply carrying `{ threads }`. */
  note(profileId: string, data: unknown): void {
    const rows = rowsOf(data, 'threads')
    if (!rows) return
    const next = new Map<string, NotificationThread>()
    for (const row of rows as NotificationThread[]) {
      if (row && typeof row.id === 'string') next.set(row.id, { id: row.id, name: row.name, lineage: row.lineage, projectId: row.projectId })
    }
    this.byProfile.set(profileId, next)
  }

  /** Replaces a profile's project names from a project list, or from an event carrying `{ projects }`. */
  noteProjects(profileId: string, data: unknown): void {
    const rows = rowsOf(data, 'projects')
    if (!rows) return
    const next = new Map<string, string>()
    for (const row of rows as Array<{ id?: unknown; name?: unknown } | null>) {
      if (row && typeof row.id === 'string' && typeof row.name === 'string') next.set(row.id, row.name)
    }
    this.projectNames.set(profileId, next)
  }

  resolve(profileId: string, threadId: string, kind: ThreadNotificationKind): NamedThreadNotificationTarget | null {
    const threads = this.byProfile.get(profileId) ?? new Map<string, NotificationThread>()
    const target = resolveThreadNotification(threadId, kind, threads)
    if (!target) return null
    const thread = threads.get(target.threadId)
    const threadName = thread?.name?.trim() || undefined
    const projectName = thread?.projectId ? this.projectNames.get(profileId)?.get(thread.projectId)?.trim() || undefined : undefined
    return { ...target, ...(threadName ? { threadName } : {}), ...(projectName ? { projectName } : {}) }
  }
}
