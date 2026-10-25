import type { Thread } from '../../shared/types'
import { isSubagentThread, nearestVisibleAncestor } from '../../shared/threadLineage'
import type { ThreadNotificationKind } from './threadNotification'

type NotificationThread = Pick<Thread, 'id' | 'name' | 'lineage'>

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

/** The thread rows the main process has seen, per profile, for resolving notifications. */
export class NotificationThreadIndex {
  private readonly byProfile = new Map<string, Map<string, NotificationThread>>()

  /** Replaces a profile's rows from a thread list, or from an event or reply carrying `{ threads }`. */
  note(profileId: string, data: unknown): void {
    const rows = Array.isArray(data) ? data : (data as { threads?: unknown } | null)?.threads
    if (!Array.isArray(rows)) return
    const next = new Map<string, NotificationThread>()
    for (const row of rows as NotificationThread[]) {
      if (row && typeof row.id === 'string') next.set(row.id, { id: row.id, name: row.name, lineage: row.lineage })
    }
    this.byProfile.set(profileId, next)
  }

  resolve(profileId: string, threadId: string, kind: ThreadNotificationKind): ThreadNotificationTarget | null {
    return resolveThreadNotification(threadId, kind, this.byProfile.get(profileId) ?? new Map())
  }
}
