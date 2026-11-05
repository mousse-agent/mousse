import type { Thread } from './types'

/**
 * Pinned threads come first, then the rest; each part follows persisted `order`, which is most recent first:
 * user sends bump a thread to the front, agent streaming does not.
 */
export function compareSidebarThreads(a: Thread, b: Thread): number {
  const pinned = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt))
  if (pinned !== 0) return pinned
  if (a.order !== b.order) return a.order - b.order
  return a.id.localeCompare(b.id)
}

export function sortSidebarThreads<T extends Thread>(threads: readonly T[]): T[] {
  return [...threads].sort(compareSidebarThreads)
}
