import { parseThreadLink, threadLink } from '../../shared/threadLink'
import { isQualifiedId, qualifyId } from '../../shared/threadRef'
import { isLocalOnlyThread } from '../../shared/threadLineage'
import { useAppStore } from '../stores/appStore'

/**
 * A thread's reference: its `mousse://thread/<id>` link, copied from any place a thread shows and pasted into a
 * composer as text, in the line being typed; the sent message draws it as the thread's chip. The agent that gets the
 * message reads the thread with its thread tools, as far as it may (see `docs/chat-links-and-references.md`).
 */

/** The id a thread is referenced by: a thread of another computer (`node`) by its qualified id. */
export function referenceIdOf(threadId: string, node?: string): string {
  return node && !isQualifiedId(threadId) ? qualifyId(node, threadId) : threadId
}

/** Puts the thread's reference on the clipboard. */
export function copyThreadReference(threadId: string, node?: string): Promise<void> {
  return navigator.clipboard.writeText(threadLink(referenceIdOf(threadId, node)))
}

/** A thread link in text, its id checked by `parseThreadLink`. */
const THREAD_LINK_IN_TEXT = /mousse:\/\/thread\/[\w-]+(?::[\w-]+)?\/?/gi

/** The threads the links in `text` name, each once. */
export function threadIdsInText(text: string): string[] {
  const ids: string[] = []
  for (const [link] of text.matchAll(THREAD_LINK_IN_TEXT)) {
    const id = parseThreadLink(link)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Why a thread cannot be referenced from `from`, else null: a private thread only in a private one, since another
 * thread's agent could not read it.
 */
export function threadReferenceRefusal(threadId: string, from: { privateThread: boolean }): string | null {
  const { threads } = useAppStore.getState()
  const listed = threads.find((thread) => thread.id === threadId)
  if (listed && !from.privateThread && isLocalOnlyThread(listed, threads)) return `“${listed.name}” is private: only a private thread can reference it.`
  return null
}

/**
 * Why a bot cannot be given `threadId`, else null: a bot never reads a private thread. A thread this
 * window does not list (another computer's) is left to the bot's tools, which say why when it is out of reach.
 */
export function botThreadReferenceRefusal(threadId: string): string | null {
  const { threads } = useAppStore.getState()
  const listed = threads.find((thread) => thread.id === threadId)
  if (!listed) return null
  if (isLocalOnlyThread(listed, threads)) return `“${listed.name}” is private: bots can't read private threads.`
  return null
}
