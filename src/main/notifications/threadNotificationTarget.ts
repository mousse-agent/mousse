import type { Thread } from '../../shared/types'
import { hiddenFromOwner, isSideChatThread, isSubagentThread, nearestVisibleAncestor } from '../../shared/threadLineage'
import type { ThreadNotificationKind } from './threadNotification'

type NotificationThread = Pick<Thread, 'id' | 'name' | 'lineage' | 'projectId' | 'hidden' | 'startedByBot'>

/** What a notification is about once subagents are folded under their parents. */
export interface ThreadNotificationTarget {
  /** The thread the notification opens and is judged against: the nearest ancestor shown in the sidebar. */
  threadId: string
  /** Set when a subagent's question is announced under its parent; the parent's name. */
  parentName?: string
  /** The thread that raised the notification, when that is a subagent; viewing it counts as viewing the target. */
  viaThreadId?: string
  /** Set when that thread is a side chat rather than a subagent. */
  sideChat?: true
}

/**
 * Who a notification is for. A subagent finishing or pausing is not news: the parent reports the
 * outcome when it hears back. A subagent's question is, so it is announced under its nearest
 * visible ancestor's name. A side chat is read in its parent's panel: only its question is news, announced under the
 * thread whose panel shows it. A thread nobody knows lineage for notifies as itself.
 */
export function resolveThreadNotification(
  threadId: string,
  kind: ThreadNotificationKind,
  threads: ReadonlyMap<string, NotificationThread>
): ThreadNotificationTarget | null {
  const thread = threads.get(threadId)
  if (thread && isSideChatThread(thread)) {
    const parentId = thread.lineage!.parentThreadId
    const listedId = threads.has(parentId) ? nearestVisibleAncestor(parentId, [...threads.values()]) : undefined
    if (kind !== 'question' || !listedId) return null
    return { threadId: listedId, parentName: threads.get(listedId)?.name?.trim() || undefined, viaThreadId: threadId, sideChat: true }
  }
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
      if (row && typeof row.id === 'string') {
        next.set(row.id, { id: row.id, name: row.name, lineage: row.lineage, projectId: row.projectId, ...(row.hidden ? { hidden: true as const } : {}), ...(row.startedByBot ? { startedByBot: row.startedByBot } : {}) })
      }
    }
    this.byProfile.set(profileId, next)
  }

  /** Puts one thread's row in, or takes it out, from a `threads.row` event (`{ thread }` or `{ removed }`). */
  noteRow(profileId: string, data: unknown): void {
    const row = data as { thread?: NotificationThread | null; removed?: unknown } | null
    const threads = this.byProfile.get(profileId)
    if (!threads) return
    const thread = row?.thread
    if (thread && typeof thread.id === 'string') {
      threads.set(thread.id, { id: thread.id, name: thread.name, lineage: thread.lineage, projectId: thread.projectId, ...(thread.hidden ? { hidden: true as const } : {}), ...(thread.startedByBot ? { startedByBot: thread.startedByBot } : {}) })
    } else if (typeof row?.removed === 'string') {
      threads.delete(row.removed)
    }
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

  /**
   * What to announce for `threadId`, or null for nothing. A thread a bot keeps out of the sidebar, or a subagent below
   * one, is quiet unless the person chose to hear about bot threads (`notifications.botThreads`).
   */
  resolve(profileId: string, threadId: string, kind: ThreadNotificationKind, notifyBotThreads = false): NamedThreadNotificationTarget | null {
    const threads = this.byProfile.get(profileId) ?? new Map<string, NotificationThread>()
    if (!notifyBotThreads && hiddenFromOwner(threadId, (id) => threads.get(id))) return null
    const target = resolveThreadNotification(threadId, kind, threads)
    if (!target) return null
    const thread = threads.get(target.threadId)
    const threadName = thread?.name?.trim() || undefined
    const projectName = thread?.projectId ? this.projectNames.get(profileId)?.get(thread.projectId)?.trim() || undefined : undefined
    return { ...target, ...(threadName ? { threadName } : {}), ...(projectName ? { projectName } : {}) }
  }

  /** The row the sidebar lists `threadId` under: itself, or for a subagent its nearest listed ancestor. */
  listedAs(profileId: string, threadId: string): string | undefined {
    const threads = this.byProfile.get(profileId)
    const thread = threads?.get(threadId)
    if (threads && thread && isSideChatThread(thread)) return nearestVisibleAncestor(thread.lineage!.parentThreadId, [...threads.values()])
    if (!threads || !thread || !isSubagentThread(thread)) return threadId
    return nearestVisibleAncestor(threadId, [...threads.values()])
  }

  /**
   * True when `threadId` is a known regular or subagent thread of `profileId` (never a side chat or an unlisted bot
   * home thread). Windows that are not viewing it do not consume its live transcript stream.
   */
  isUnwatchedTranscriptThread(profileId: string, threadId: string): boolean {
    const thread = this.byProfile.get(profileId)?.get(threadId)
    return Boolean(thread && !isSideChatThread(thread))
  }
}
