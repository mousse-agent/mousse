import { useEffect, useMemo, useState } from 'react'

import type { PendingUserQuestions, Thread, ThreadActivitySnapshot } from '../../shared/types'
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
 * The threads whose wait the bot that started them answers (`PendingUserQuestions.supervised`): every request each
 * waits on is marked. A question asked without waiting is no wait.
 */
export function supervisedWaits(pending: readonly PendingUserQuestions[]): Set<string> {
  const waits = new Map<string, boolean>()
  for (const entry of pending) {
    if (!entry.threadId || entry.wait === false) continue
    waits.set(entry.threadId, (waits.get(entry.threadId) ?? true) && entry.supervised === true)
  }
  return new Set([...waits].filter(([, supervised]) => supervised).map(([threadId]) => threadId))
}

/**
 * The threads that wait for the person (an answer or an approval, their own or a subagent's below them), newest
 * first. `hidden` holds threads another list shows (agent chats). A thread a bot keeps out of the sidebar is left out,
 * like its banners, unless the person chose to hear about bot threads (`notifyBotThreads`); its bot's chat lists it.
 * A thread whose own wait its bot answers (`supervised`) waits on no one, wherever it is listed; a subagent's
 * question below it still counts.
 */
export function needsMeThreads(
  threads: readonly Thread[],
  activity: ThreadActivitySnapshot,
  hidden: ReadonlySet<string | undefined> = new Set(),
  notifyBotThreads = false,
  supervised: ReadonlySet<string> = new Set()
): Thread[] {
  if (supervised.size) {
    const quiet: ThreadActivitySnapshot = { ...activity }
    for (const threadId of supervised) if (quiet[threadId] === 'awaiting_input') quiet[threadId] = 'processing'
    activity = quiet
  }
  const rolledUp = rollUpActivities(threads, activity)
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  return visibleThreads(threads)
    .filter((thread) =>
      !thread.archivedAt &&
      isThreadStarted(thread) &&
      !hidden.has(thread.id) &&
      (notifyBotThreads || !hiddenFromOwner(thread.id, (id) => byId.get(id))) &&
      threadAttention(rolledUp[thread.id] ?? activity[thread.id]) === 'needs-me')
    .sort(newestFirst)
}

/**
 * `supervisedWaits` for the open profile: read again when the set of waiting threads changes, a request is asked or
 * settled, or a bot's state changes (a paused bot's threads wait on the owner again). A thread that starts waiting
 * counts as supervised until that read comes back, so a wait its bot answers never flashes into Needs me.
 */
export function useSupervisedWaits(): ReadonlySet<string> {
  const key = useAppStore((state) => Object.keys(state.threadActivity).filter((threadId) => state.threadActivity[threadId] === 'awaiting_input').sort().join('\n'))
  const botsKey = useBotsStore((state) => state.bots.map((bot) => `${bot.id}:${bot.state}`).join('\n'))
  // What the last read found, and for which waiting threads.
  const [read, setRead] = useState<{ key: string; threads: ReadonlySet<string> }>(() => ({ key: '', threads: new Set() }))
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const orchestrator = window.mousse?.orchestrator
    if (!orchestrator?.onQuestionsPending) return
    const bump = () => setRevision((value) => value + 1)
    const offPending = orchestrator.onQuestionsPending(bump)
    const offCleared = orchestrator.onQuestionsCleared(bump)
    return () => {
      offPending()
      offCleared()
    }
  }, [])

  useEffect(() => {
    const pendingQuestions = window.mousse?.orchestrator?.pendingQuestions
    // Nothing waits, or nothing to read: no thread is supervised.
    if (!key || !pendingQuestions) {
      setRead((current) => (current.key === key && !current.threads.size ? current : { key, threads: new Set() }))
      return
    }
    let live = true
    void pendingQuestions()
      .then((pending) => {
        if (live) setRead({ key, threads: supervisedWaits(pending ?? []) })
      })
      .catch(() => {
        // Unread: every waiting thread counts, as before.
        if (live) setRead({ key, threads: new Set() })
      })
    return () => {
      live = false
    }
  }, [key, botsKey, revision])

  return useMemo(() => {
    const readable = typeof window !== 'undefined' && Boolean(window.mousse?.orchestrator?.pendingQuestions)
    if (read.key === key || !readable) return read.threads
    const known = new Set(read.key ? read.key.split('\n') : [])
    const quiet = new Set(read.threads)
    for (const threadId of key ? key.split('\n') : []) if (!known.has(threadId)) quiet.add(threadId)
    return quiet
  }, [read, key])
}

/** `needsMeThreads` for the open profile, kept current. */
export function useNeedsMeThreads(): Thread[] {
  const threads = useAppStore((s) => s.threads)
  const activity = useAppStore((s) => s.threadActivity)
  const agentChats = useChatsStore((s) => s.snapshot.chats)
  const notifyBotThreads = useAppStore((s) => s.notifyBotThreads)
  const supervised = useSupervisedWaits()
  return useMemo(
    () => needsMeThreads(threads, activity, new Set(agentChats.map((chat) => chat.threadId)), notifyBotThreads, supervised),
    [threads, activity, agentChats, notifyBotThreads, supervised]
  )
}

/** Threads and bots waiting on an answer, one per bot regardless of its number of open cards. */
export function useNeedsMeCounts(): { threads: number; bots: number } {
  const threads = useNeedsMeThreads()
  const bots = useBotsStore((s) => s.bots)
  return { threads: threads.length, bots: bots.filter((bot) => bot.state !== 'paused' && (bot.needsOwner || bot.state === 'needs_you')).length }
}
