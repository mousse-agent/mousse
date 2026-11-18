import { useMemo } from 'react'

import type { Thread, ThreadActivitySnapshot } from '../../shared/types'
import { threadAttention } from '../../shared/threadAttention'
import { hiddenFromOwner, rollUpActivities, visibleThreads } from '../../shared/threadLineage'
import { isThreadStarted } from '../../shared/threadTitle'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { useBotsStore } from '../stores/botsStore'

function newestFirst(a: Thread, b: Thread): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/**
 * The threads that wait for the person (an answer or an approval, their own or a subagent's below them), newest
 * first. `hidden` holds threads another list shows (agent chats). A thread a bot keeps out of the sidebar is left out,
 * like its banners, unless the person chose to hear about bot threads (`notifyBotThreads`); its bot's chat lists it.
 */
export function needsMeThreads(
  threads: readonly Thread[],
  activity: ThreadActivitySnapshot,
  hidden: ReadonlySet<string | undefined> = new Set(),
  notifyBotThreads = false
): Thread[] {
  const rolledUp = rollUpActivities(threads, activity)
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  return visibleThreads(threads)
    .filter((thread) =>
      !thread.settledAt &&
      isThreadStarted(thread) &&
      !hidden.has(thread.id) &&
      (notifyBotThreads || !hiddenFromOwner(thread.id, (id) => byId.get(id))) &&
      threadAttention(rolledUp[thread.id] ?? activity[thread.id]) === 'needs-me')
    .sort(newestFirst)
}

/** `needsMeThreads` for the open profile, kept current. */
export function useNeedsMeThreads(): Thread[] {
  const threads = useAppStore((s) => s.threads)
  const activity = useAppStore((s) => s.threadActivity)
  const agentChats = useChatsStore((s) => s.snapshot.chats)
  const notifyBotThreads = useAppStore((s) => s.notifyBotThreads)
  return useMemo(
    () => needsMeThreads(threads, activity, new Set(agentChats.map((chat) => chat.threadId)), notifyBotThreads),
    [threads, activity, agentChats, notifyBotThreads]
  )
}

/** Threads and bots waiting on an answer, one per bot regardless of its number of open cards. */
export function useNeedsMeCounts(): { threads: number; bots: number } {
  const threads = useNeedsMeThreads()
  const bots = useBotsStore((s) => s.bots)
  return { threads: threads.length, bots: bots.filter((bot) => bot.state !== 'paused' && (bot.needsOwner || bot.state === 'needs_you')).length }
}
