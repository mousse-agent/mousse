import { useMemo } from 'react'

import type { Thread, ThreadActivitySnapshot } from '../../shared/types'
import { threadAttention } from '../../shared/threadAttention'
import { rollUpActivities, visibleThreads } from '../../shared/threadLineage'
import { isThreadStarted } from '../../shared/threadTitle'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'

function newestFirst(a: Thread, b: Thread): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/**
 * The threads the sidebar lists that wait for the person (an answer or an approval, their own or a
 * subagent's below them), newest first. `hidden` holds threads another list shows (agent chats).
 */
export function needsMeThreads(
  threads: readonly Thread[],
  activity: ThreadActivitySnapshot,
  hidden: ReadonlySet<string | undefined> = new Set()
): Thread[] {
  const rolledUp = rollUpActivities(threads, activity)
  return visibleThreads(threads)
    .filter((thread) =>
      !thread.settledAt &&
      isThreadStarted(thread) &&
      !hidden.has(thread.id) &&
      threadAttention(rolledUp[thread.id] ?? activity[thread.id]) === 'needs-me')
    .sort(newestFirst)
}

/** `needsMeThreads` for the open profile, kept current. */
export function useNeedsMeThreads(): Thread[] {
  const threads = useAppStore((s) => s.threads)
  const activity = useAppStore((s) => s.threadActivity)
  const agentChats = useChatsStore((s) => s.snapshot.chats)
  return useMemo(
    () => needsMeThreads(threads, activity, new Set(agentChats.map((chat) => chat.threadId))),
    [threads, activity, agentChats]
  )
}
