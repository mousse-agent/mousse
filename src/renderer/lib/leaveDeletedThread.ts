import { isQualifiedId } from '../../shared/threadRef'
import { visibleThreads } from '../../shared/threadLineage'
import { findUnstartedThread } from '../../shared/threadTitle'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { selectOrSettle } from './threadActions'

/**
 * A window leaves the thread it shows once that thread is deleted, wherever the delete came from: this window,
 * another window, the CLI, the thread's expiry, or the deletion of its parent (a subagent goes with it). It goes where
 * a delete from the sidebar goes: the first thread that is not archived, or else a new chat.
 */

/**
 * True when the shown thread was in the list before and is not now. Only this computer's threads count: a row of
 * another computer leaves the list while that computer is out of reach. A thread not listed yet (just made, or still
 * the Send's pending row) was never in the list, so it is not taken for a deleted one.
 */
export function shownThreadLeftList(previous: readonly Pick<Thread, 'id'>[], next: readonly Pick<Thread, 'id'>[], shownId: string | null): shownId is string {
  if (!shownId || isQualifiedId(shownId) || previous === next) return false
  return previous.some((thread) => thread.id === shownId) && !next.some((thread) => thread.id === shownId)
}

/** The thread a window goes to after its thread was deleted: the first listed one that is not archived or a subagent. */
export function threadAfterDeletion(threads: readonly Thread[], deletedId: string): string | undefined {
  return visibleThreads(threads).find((thread) => thread.id !== deletedId && !thread.settledAt)?.id
}

export interface LeaveDeletedThreadDeps {
  /**
   * The thread as the service has it now: null once it is gone for good. An error (the service out of reach, or the
   * thread's delete still under way, which may yet put it back) leaves the answer open.
   */
  getThread(threadId: string): Promise<Thread | null>
  /** Shows a listed thread (the store switches at once, then the service is asked). */
  open(threadId: string): Promise<void>
  /** Makes a new chat, or takes the one another window of this profile just made, and shows it. */
  createNew(): Promise<void>
}

const defaultDeps: LeaveDeletedThreadDeps = {
  getThread: (threadId) => window.mousse.threads.get(threadId),
  open: async (threadId) => {
    useAppStore.getState().switchToThread(threadId)
    await selectOrSettle(threadId)
  },
  createNew: async () => {
    const store = useAppStore.getState()
    // The newest empty chat is reused, as the new-chat command does; a private one is not.
    const draft = findUnstartedThread(visibleThreads(store.threads).filter((entry) => !entry.localOnly && !entry.settledAt))
    const thread = draft ?? await window.mousse.threads.newChatAfterDelete()
    store.upsertThread(thread)
    store.switchToThread(thread.id)
    await selectOrSettle(thread.id)
  }
}

/** The window still shows `threadId`, and no newer list brought it back. */
function stillShownAndGone(threadId: string): boolean {
  const state = useAppStore.getState()
  return state.activeThreadId === threadId && !state.threads.some((thread) => thread.id === threadId)
}

/**
 * Leaves `threadId` when the window still shows it and the service says it is gone. `stays`: the service still has
 * it (a refused delete put it back), or the window moved on. `unknown`: the service could not say yet.
 */
export async function leaveDeletedThread(threadId: string, deps: LeaveDeletedThreadDeps = defaultDeps): Promise<'left' | 'stays' | 'unknown'> {
  let thread: Thread | null
  try {
    thread = await deps.getThread(threadId)
  } catch {
    return 'unknown'
  }
  if (thread || !stillShownAndGone(threadId)) return 'stays'
  const next = threadAfterDeletion(useAppStore.getState().threads, threadId)
  if (next) await deps.open(next)
  else await deps.createNew()
  return 'left'
}

/** Waits between asks while the answer is open; about a minute in all, longer than a delete may take. */
export const LEAVE_RETRY_DELAYS_MS: readonly number[] = [300, 600, 1_200, 2_400, 5_000, 10_000, 15_000, 25_000]

/**
 * Watches the store's thread list: when the shown thread leaves it, the window leaves the thread, asking again while the
 * service cannot say yet. Returns the unsubscribe function.
 */
export function watchDeletedShownThread(deps: LeaveDeletedThreadDeps = defaultDeps, delays: readonly number[] = LEAVE_RETRY_DELAYS_MS): () => void {
  const leaving = new Set<string>()
  let stopped = false
  const leave = async (threadId: string): Promise<void> => {
    for (let attempt = 0; !stopped && stillShownAndGone(threadId); attempt++) {
      if (await leaveDeletedThread(threadId, deps) !== 'unknown') return
      if (attempt >= delays.length) return
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.threads === previous.threads) return
    const shown = state.activeThreadId
    if (!shownThreadLeftList(previous.threads, state.threads, shown) || leaving.has(shown)) return
    leaving.add(shown)
    void leave(shown)
      .catch((error: unknown) => console.warn('the window could not leave a deleted thread', error))
      .finally(() => leaving.delete(shown))
  })
  return () => {
    stopped = true
    unsubscribe()
  }
}
