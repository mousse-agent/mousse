import type { ChatReference } from '../../shared/chatReferences'
import { parseThreadLink, threadLink } from '../../shared/threadLink'
import { isQualifiedId, qualifyId } from '../../shared/threadRef'
import { isLocalOnlyThread } from '../../shared/threadLineage'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

/**
 * A thread's reference: its `mousse://thread/<id>` link, copied from any place a thread shows and pasted into a
 * composer, where it becomes a thread pill. The agent that gets the message reads the thread with its thread tools, as
 * far as it may (see `docs/chat-links-and-references.md`).
 */

/** The most thread links one paste turns into pills. */
const PASTE_MAX_LINKS = 20

/** The id a thread is referenced by: a thread of another computer (`node`) by its qualified id. */
export function referenceIdOf(threadId: string, node?: string): string {
  return node && !isQualifiedId(threadId) ? qualifyId(node, threadId) : threadId
}

/** Puts the thread's reference on the clipboard. */
export function copyThreadReference(threadId: string, node?: string): Promise<void> {
  return navigator.clipboard.writeText(threadLink(referenceIdOf(threadId, node)))
}

/**
 * The threads a pasted text names when it is nothing but thread links (one or more, separated by white space), else
 * null: a link inside other text stays text.
 */
export function threadIdsOfPaste(text: string): string[] | null {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (!parts.length || parts.length > PASTE_MAX_LINKS) return null
  const ids: string[] = []
  for (const part of parts) {
    const id = parseThreadLink(part)
    if (!id) return null
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The thread this window lists under `threadId`, if any. */
function listedThread(threadId: string): Thread | undefined {
  return useAppStore.getState().threads.find((thread) => thread.id === threadId)
}

/** A thread pill for `threadId`, titled as this window lists it. */
export function threadReferenceOf(threadId: string): ChatReference {
  const listed = listedThread(threadId)
  return {
    id: `thread:${threadId}`,
    kind: 'thread',
    title: listed?.name?.trim() || 'Thread',
    threadId,
    ...(listed?.projectId ? { projectId: listed.projectId } : {})
  }
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
