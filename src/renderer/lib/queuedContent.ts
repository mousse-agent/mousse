import type { ChatImageAttachment, QueuedMessage } from '../../shared/types'

/**
 * An open edit of a queued message. It is kept by thread in the app store, outside the conversation drawn for one
 * thread, so it is still open with its draft after a switch to another thread and back, and after a reload.
 */
export interface QueueEditDraft {
  itemId: string
  /** The editor's width, from the bubble it replaced. */
  width: number | null
  /** The content the edit started from (or was last brought up to); a save expects the message still has it. */
  base: string
  draft: string
  /** The message's images, which the editor does not show; they go with a recovered draft. Never saved to disk. */
  images?: ChatImageAttachment[]
  /** A save is in flight: what the message leaving the queue means waits for its outcome. Never saved to disk. */
  saving?: boolean
}

/** Open edits as they are saved with the profile's workspace: without images or a save in flight. */
export function queueEditDraftsForStorage(drafts: Record<string, QueueEditDraft>): Record<string, QueueEditDraft> {
  return Object.fromEntries(Object.entries(drafts).map(([threadId, { images: _images, saving: _saving, ...kept }]) => [threadId, kept]))
}

/** Open edits read back from a saved workspace; anything malformed is dropped. */
export function queueEditDraftsFromStorage(value: unknown): Record<string, QueueEditDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const drafts: Record<string, QueueEditDraft> = {}
  for (const [threadId, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<QueueEditDraft> | null
    if (!entry || typeof entry.itemId !== 'string' || typeof entry.base !== 'string' || typeof entry.draft !== 'string') continue
    drafts[threadId] = { itemId: entry.itemId, base: entry.base, draft: entry.draft, width: typeof entry.width === 'number' ? entry.width : null }
  }
  return drafts
}

// Where the composer's markers start: attached files, voice messages, browser elements, references.
// The composer writes what was typed first and these after it; the agent reads them, the bubble hides them.
const MARKER_START = /\[(?:Attached files: |Voice message \(|Selected browser element\]|Mousse references data=")/

export const isOptimisticQueueItem = (item: QueuedMessage): boolean => item.id.startsWith('optimistic:')

/** A queued message's content split into the text a person typed and the composer markers after it. */
export function splitQueuedContent(content: string): { text: string; markers: string } {
  const at = content.search(MARKER_START)
  if (at < 0) return { text: content.trim(), markers: '' }
  return { text: content.slice(0, at).trim(), markers: content.slice(at).trim() }
}

/** `content` with its typed text replaced by `text`; the markers are kept as they are. */
export function queuedContentWithText(content: string, text: string): string {
  return [text.trim(), splitQueuedContent(content).markers].filter(Boolean).join('\n\n')
}

/** Whether the queue lets this item's text change: a pending message a person wrote. */
export function canEditQueued(item: QueuedMessage): boolean {
  return !isOptimisticQueueItem(item) &&
    item.state === 'pending' &&
    item.intent !== 'steer' &&
    !item.subagentNotice?.length &&
    !item.inboxIds?.length &&
    !item.workflowInvocationId
}
