import { isId, type UserId } from './net/ids'
import type { HumanAuthor } from './types'

/** The longest name an author is shown with. */
export const AUTHOR_NAME_MAX = 64

/**
 * A stored author as it is read back: a valid user id, an optional valid node id and a non-empty name, cut to a
 * readable length. Anything else reads as no author (the owner).
 */
export function humanAuthorOf(value: unknown): HumanAuthor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { user?: unknown; node?: unknown; displayName?: unknown }
  if (!isId('user', raw.user)) return undefined
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, AUTHOR_NAME_MAX) : ''
  return {
    user: raw.user,
    ...(isId('node', raw.node) ? { node: raw.node } : {}),
    displayName: displayName || shortUserName(raw.user)
  }
}

/** A short name for a person known only by their id (`usr_…k3m9`), until a team roster names them. */
export function shortUserName(user: UserId): string {
  return `${user.slice(0, 4)}…${user.slice(-4)}`
}

/** The initial an author's avatar shows. */
export function authorInitial(author: Pick<HumanAuthor, 'displayName'>): string {
  const first = [...author.displayName.replace(/^usr_…/, '').trim()][0]
  return first ? first.toLocaleUpperCase() : '?'
}
