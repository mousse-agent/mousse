import type { QueuedMessage } from '../../shared/types'

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
