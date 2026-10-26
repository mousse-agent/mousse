import { openSubagentParentRow, visibleThreads } from '../../shared/threadLineage'
import { findUnstartedThread } from '../../shared/threadTitle'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { orderedThreadIds } from './threadOrder'

/** Opens a thread in the main workspace after the navigation guards agree. */
export async function selectThread(threadId: string): Promise<void> {
  if (!await confirmNavigation()) return
  const store = useAppStore.getState()
  store.setSidebarMode('projects')
  // A page opened from the rail covers the workspace; the thread has to be visible.
  store.setScheduledOpen(false)
  store.setChannelsOpen(false)
  if (threadId === store.activeThreadId) return
  // One store update: highlight + restore cached transcript (if any) while
  // the daemon snapshot loads. Main also broadcasts thread:selected early.
  store.switchToThread(threadId)
  await window.mousse.threads.select(threadId)
}

/** Opens the newest empty draft thread, or creates one, and selects it. */
export async function createAndSelectThread(): Promise<void> {
  const store = useAppStore.getState()
  store.setThreadsSidebarView('threads')
  const thread = findUnstartedThread(visibleThreads(store.threads)) ?? await window.mousse.threads.create()
  store.upsertThread(thread)
  await selectThread(thread.id)
}

/** Moves to the next (1) or previous (-1) thread in the sidebar's order, wrapping at the ends. */
export async function selectAdjacentThread(direction: 1 | -1): Promise<void> {
  const { projects, threads, threadsSidebarView, activeThreadId } = useAppStore.getState()
  const excluded = new Set(useChatsStore.getState().snapshot.chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : [])))
  const ids = orderedThreadIds({ projects, threads, view: threadsSidebarView, excluded })
  if (ids.length === 0) return
  // A subagent thread has no row of its own; its parent's row is the one that is highlighted.
  const current = activeThreadId ? (openSubagentParentRow(activeThreadId, threads) ?? activeThreadId) : null
  const index = current ? ids.indexOf(current) : -1
  const next = index === -1
    ? (direction === 1 ? 0 : ids.length - 1)
    : (index + direction + ids.length) % ids.length
  if (ids[next] === current) return
  await selectThread(ids[next]!)
}
