const DEFAULT_THREAD_NAMES = new Set(['New Thread', 'New Chat'])

/** True when the thread still has the auto-created empty-thread label. */
export function isDefaultThreadName(name: string): boolean {
  return DEFAULT_THREAD_NAMES.has(name.trim())
}

/**
 * True once a chat belongs in the sidebar.
 * Prefer `startedAt` (set when the user commits the first send). Fall back to a
 * non-default title so older threads with real names stay visible even before
 * startedAt is backfilled.
 */
export function isThreadStarted(thread: { startedAt?: string; name?: string }): boolean {
  if (thread.startedAt) return true
  if (thread.name && !isDefaultThreadName(thread.name)) return true
  return false
}

/**
 * Return the newest empty draft for a sidebar context. New-chat actions reuse
 * this hidden thread so its composer draft and per-thread model survive while
 * the user visits another thread or project.
 */
export function findUnstartedThread<T extends {
  projectId?: string
  settledAt?: string
  startedAt?: string
  name?: string
  updatedAt: string
}>(threads: T[], projectId?: string): T | undefined {
  return threads
    .filter(
      (thread) =>
        !thread.settledAt &&
        thread.projectId === projectId &&
        !isThreadStarted(thread)
    )
    .reduce<T | undefined>((newest, thread) => {
      if (!newest) return thread
      return thread.updatedAt > newest.updatedAt ? thread : newest
    }, undefined)
}
