import type { Thread } from './types'

/**
 * Sidebar rows follow persisted `order` only.
 * User sends bump a thread to the front; agent streaming must not.
 */
export function compareSidebarThreads(a: Thread, b: Thread): number {
  if (a.order !== b.order) return a.order - b.order
  return a.id.localeCompare(b.id)
}

export function sortSidebarThreads<T extends Thread>(threads: readonly T[]): T[] {
  return [...threads].sort(compareSidebarThreads)
}
