import type { Thread } from '../../shared/types'

/**
 * Sidebar marks for unsent drafts. A thread's draft is the composer text kept for it (`composerDrafts`, saved with the
 * profile's workspace); whitespace alone is not a draft.
 */

/** The threads whose composer holds unsent text, as one string: a store selector that changes only when that set does. */
export function draftedThreadsKey(drafts: Readonly<Record<string, string>>): string {
  return Object.keys(drafts).filter((id) => Boolean(drafts[id]?.trim())).sort().join('\n')
}

export function draftedThreadIds(key: string): ReadonlySet<string> {
  return new Set(key ? key.split('\n') : [])
}

/** An unsent new chat's row title: its draft on one line. */
export function unsentChatTitle(draft: string | undefined): string {
  return (draft ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * A group's rows with its unsent new chats: after the pinned threads, above the rest. A chat sent from there is a new
 * thread, which lists in that same place, so its row does not move.
 */
export function withUnsentChats<T extends Pick<Thread, 'pinnedAt'>>(started: readonly T[], unsent: readonly T[]): T[] {
  if (!unsent.length) return [...started]
  const firstUnpinned = started.findIndex((thread) => !thread.pinnedAt)
  const at = firstUnpinned === -1 ? started.length : firstUnpinned
  return [...started.slice(0, at), ...unsent, ...started.slice(at)]
}
