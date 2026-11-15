/**
 * A link to a Mousse thread, written in a thread's or a bot's reply: `mousse://thread/<threadId>`. The thread tools
 * return it as `link`; a chat draws it as a link that opens the thread in the app, labelled with the thread's title when
 * the link's text is the address itself.
 */
export const THREAD_LINK_PREFIX = 'mousse://thread/'

/** What a thread id may hold: letters, digits, `-` and `_`. */
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/

/** The link to `threadId`. */
export function threadLink(threadId: string): string {
  return `${THREAD_LINK_PREFIX}${threadId}`
}

/** The thread a `mousse://thread/<id>` link names, else null. */
export function parseThreadLink(href: string): string | null {
  const value = href.trim()
  if (value.slice(0, THREAD_LINK_PREFIX.length).toLowerCase() !== THREAD_LINK_PREFIX) return null
  const id = value.slice(THREAD_LINK_PREFIX.length).replace(/\/$/, '')
  return THREAD_ID.test(id) ? id : null
}
