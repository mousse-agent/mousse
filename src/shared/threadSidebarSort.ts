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

/**
 * The Threads tab lists every project's threads together, newest first by when each was started (its
 * first message), so a thread goes to the top once and later messages do not move it. `order` cannot
 * be used: it is numbered within each project. A thread without `startedAt` falls back to its creation.
 */
export function compareThreadFeed(a: Thread, b: Thread): number {
  const started = (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt)
  return started || a.id.localeCompare(b.id)
}

/**
 * The Threads tab's rows. `arranged` is the order the person last dragged the rows into (ids, top first):
 * those threads keep it, and threads that started since (not in it) go above them, newest first.
 */
export function sortThreadFeed<T extends Thread>(threads: readonly T[], arranged: readonly string[] = []): T[] {
  const place = new Map(arranged.map((id, index) => [id, index]))
  return [...threads].sort((a, b) => {
    const left = place.get(a.id)
    const right = place.get(b.id)
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? -1 : 1
      return compareThreadFeed(a, b)
    }
    return left - right
  })
}

/**
 * The arrangement after dragging `moved` next to `target` (before it, or after it with `after`), or to the
 * end without a target. `shown` is the Threads tab's rows as listed, top first.
 */
export function arrangeThreadFeed(shown: readonly string[], moved: string, target?: string, after = false): string[] {
  const ids = shown.filter((id) => id !== moved)
  const index = target === undefined ? -1 : ids.indexOf(target)
  if (index === -1) return [...ids, moved]
  ids.splice(after ? index + 1 : index, 0, moved)
  return ids
}
