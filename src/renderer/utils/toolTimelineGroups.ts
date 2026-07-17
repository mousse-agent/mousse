import type { ChatMessage } from '../../shared/types'

export type ChatTimelineGroup =
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool-group'; messages: ChatMessage[] }

function isVisibleToolMessage(message: ChatMessage): boolean {
  return Boolean(message.toolCall) && message.kind !== 'thinking'
}

/**
 * Coalesce adjacent tool timeline entries without changing their persisted order.
 * Thinking and ordinary chat messages intentionally break a group because they are
 * visible chronology boundaries.
 */
export function groupChatTimeline(messages: ChatMessage[]): ChatTimelineGroup[] {
  const groups: ChatTimelineGroup[] = []

  for (const message of messages) {
    const previous = groups.at(-1)
    if (isVisibleToolMessage(message) && previous?.type === 'tool-group') {
      previous.messages.push(message)
      continue
    }

    if (isVisibleToolMessage(message)) {
      groups.push({ type: 'tool-group', messages: [message] })
    } else {
      groups.push({ type: 'message', message })
    }
  }

  return groups
}
