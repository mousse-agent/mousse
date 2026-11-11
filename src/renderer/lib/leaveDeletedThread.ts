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

/** A thread the service no longer has (deleted, or in the middle of its delete): `threads.get` answers it is not found. */
function isGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not.found|thread_not_found|trashed/i.test(message)
}

export interface LeaveDeletedThreadDeps {
  /** The thread as the service has it now; null or a not-found error when it is gone. */
  getThread(threadId: string): Promise<Thread | null>
  /** Shows a listed thread (the store switches at once, then the service is asked). */
  open(threadId: string): Promise<void>
  /** Makes a new chat and shows it. */
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
    const thread = draft ?? await window.mousse.threads.create()
    store.upsertThread(thread)
    store.switchToThread(thread.id)
    await selectOrSettle(thread.id)
  }
}

/**
 * Leaves `threadId` when the window still shows it and the service confirms it is gone. A thread a refused delete put
 * back is still there, so the window stays on it.
 */
export async function leaveDeletedThread(threadId: string, deps: LeaveDeletedThreadDeps = defaultDeps): Promise<boolean> {
  try {
    if (await deps.getThread(threadId)) return false
  } catch (error) {
    if (!isGone(error)) return false
  }
  const state = useAppStore.getState()
  // The person moved on meanwhile, or a newer list brought the thread back.
  if (state.activeThreadId !== threadId || state.threads.some((thread) => thread.id === threadId)) return false
  const next = threadAfterDeletion(state.threads, threadId)
  if (next) await deps.open(next)
  else await deps.createNew()
  return true
}

/**
 * Watches the store's thread list: when the shown thread leaves it, the window leaves the thread. Returns the
 * unsubscribe function.
 */
export function watchDeletedShownThread(deps: LeaveDeletedThreadDeps = defaultDeps): () => void {
  const leaving = new Set<string>()
  return useAppStore.subscribe((state, previous) => {
    if (state.threads === previous.threads) return
    const shown = state.activeThreadId
    if (!shownThreadLeftList(previous.threads, state.threads, shown) || leaving.has(shown)) return
    leaving.add(shown)
    void leaveDeletedThread(shown, deps)
      .catch((error: unknown) => console.warn('the window could not leave a deleted thread', error))
      .finally(() => leaving.delete(shown))
  })
}
