import { create } from 'zustand'
import { isThreadStarted } from '../../shared/threadTitle'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { selectThread } from './threadActions'

/**
 * The window's thread history, like a browser's: every thread opened in this window, in order, and
 * where in that list the window is. Back and forward walk it; opening another thread after going back
 * drops what was ahead. Kept per window and never saved.
 */
export interface ThreadHistory {
  entries: string[]
  index: number
}

/** The most threads the history keeps; the oldest go first. */
export const THREAD_HISTORY_LIMIT = 100

export const EMPTY_THREAD_HISTORY: ThreadHistory = { entries: [], index: -1 }

/** The history after `threadId` was opened. Opening the thread the window is already on changes nothing. */
export function pushVisit(history: ThreadHistory, threadId: string, limit = THREAD_HISTORY_LIMIT): ThreadHistory {
  if (history.entries[history.index] === threadId) return history
  const entries = [...history.entries.slice(0, history.index + 1), threadId]
  const drop = Math.max(0, entries.length - limit)
  return { entries: drop ? entries.slice(drop) : entries, index: entries.length - 1 - drop }
}

/**
 * The index one step back (`-1`) or forward (`1`) that can still be opened, or null. Threads that were
 * deleted, archived or never started since are skipped, and so is the one the window is on.
 */
export function stepTarget(history: ThreadHistory, direction: 1 | -1, canOpen: (threadId: string) => boolean): number | null {
  const current = history.entries[history.index]
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const id = history.entries[index]!
    if (id !== current && canOpen(id)) return index
  }
  return null
}

/**
 * The entries behind (`-1`) or ahead of (`1`) the window that can be opened, nearest first, each thread
 * once (its nearest visit).
 */
export function historyList(history: ThreadHistory, direction: 1 | -1, canOpen: (threadId: string) => boolean): { index: number; threadId: string }[] {
  const seen = new Set([history.entries[history.index]])
  const list: { index: number; threadId: string }[] = []
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const id = history.entries[index]!
    if (seen.has(id) || !canOpen(id)) continue
    seen.add(id)
    list.push({ index, threadId: id })
  }
  return list
}

/** Whether a history entry can be opened: the thread is still listed, started, and not archived. */
export function openableThread(thread: Pick<Thread, 'settledAt' | 'startedAt' | 'name' | 'automationManager'> | undefined): boolean {
  return Boolean(thread && !thread.settledAt && !thread.automationManager && isThreadStarted(thread))
}

interface ThreadHistoryState extends ThreadHistory {
  /** Records a thread the window opened. */
  visit(threadId: string): void
  /** Forgets everything, as when the window switches profile. */
  reset(): void
}

export const useThreadHistoryStore = create<ThreadHistoryState>((set) => ({
  ...EMPTY_THREAD_HISTORY,
  visit: (threadId) => set((state) => pushVisit(state, threadId)),
  reset: () => set(EMPTY_THREAD_HISTORY)
}))

/** The thread ids the Chats tab owns: they live in Chats, not in the thread history. */
function chatThreadIds(): Set<string> {
  return new Set(useChatsStore.getState().snapshot.chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : [])))
}

/** `openableThread` against the current store. */
export function canOpenFromHistory(threadId: string): boolean {
  if (chatThreadIds().has(threadId)) return false
  return openableThread(useAppStore.getState().threads.find((thread) => thread.id === threadId))
}

/** Opens the history entry at `index`. When the switch is refused (unsaved changes kept), the window stays where it was. */
export async function goToHistoryIndex(index: number): Promise<void> {
  const store = useThreadHistoryStore.getState()
  const threadId = store.entries[index]
  if (threadId === undefined || index === store.index) return
  const from = store.index
  // Moved first, so the switch below is read as a step through the history, not a new visit.
  useThreadHistoryStore.setState({ index })
  try {
    await selectThread(threadId)
  } finally {
    if (useAppStore.getState().activeThreadId !== threadId && useThreadHistoryStore.getState().index === index) {
      useThreadHistoryStore.setState({ index: from })
    }
  }
}

/** One step back (`-1`) or forward (`1`). Nothing happens at either end. */
export function stepHistory(direction: 1 | -1): Promise<void> {
  const target = stepTarget(useThreadHistoryStore.getState(), direction, canOpenFromHistory)
  return target === null ? Promise.resolve() : goToHistoryIndex(target)
}

/**
 * Keeps the history in step with the open thread: every thread the window opens is a visit, except a
 * Chats conversation. A profile switch starts a new history. Returns what stops it.
 */
export function trackThreadHistory(): () => void {
  const record = (threadId: string | null) => {
    if (!threadId || chatThreadIds().has(threadId)) return
    useThreadHistoryStore.getState().visit(threadId)
  }
  record(useAppStore.getState().activeThreadId)
  return useAppStore.subscribe((state, previous) => {
    if (state.profileId !== previous.profileId) useThreadHistoryStore.getState().reset()
    if (state.activeThreadId !== previous.activeThreadId) record(state.activeThreadId)
  })
}

/** The mouse's back and forward buttons, as `MouseEvent.button` reports them. */
export const MOUSE_BACK_BUTTON = 3
export const MOUSE_FORWARD_BUTTON = 4

/**
 * The history step a mouse button asks for, or null for every other button. The browser panel's page
 * gets its own mouse events, so its buttons keep navigating that page.
 */
export function mouseHistoryDirection(event: Pick<MouseEvent, 'button'>): 1 | -1 | null {
  if (event.button === MOUSE_BACK_BUTTON) return -1
  if (event.button === MOUSE_FORWARD_BUTTON) return 1
  return null
}

/**
 * Listens for the mouse's back and forward buttons on a window-like target. The step runs on release,
 * as in a browser; the press is swallowed so nothing else reads it. Returns what removes the listeners.
 */
export function attachMouseHistory(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  run: (direction: 1 | -1) => void
): () => void {
  const swallow = (event: MouseEvent) => {
    if (mouseHistoryDirection(event) !== null) event.preventDefault()
  }
  const release = (event: MouseEvent) => {
    const direction = mouseHistoryDirection(event)
    if (direction === null) return
    event.preventDefault()
    run(direction)
  }
  target.addEventListener('mousedown', swallow)
  target.addEventListener('auxclick', swallow)
  target.addEventListener('mouseup', release)
  return () => {
    target.removeEventListener('mousedown', swallow)
    target.removeEventListener('auxclick', swallow)
    target.removeEventListener('mouseup', release)
  }
}
