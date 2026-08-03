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
function startsTurn(group: ChatTimelineGroup): boolean {
  return group.type === 'message' && group.message.role === 'user'
}

/**
 * Split the rendered timeline into one block per user turn. Each block becomes the
 * containing block of its own sticky prompt, so a prompt pins for exactly as long as its
 * turn is on screen and the next turn pushes it out without any scroll bookkeeping.
 */
export function chunkTimelineIntoTurns(groups: ChatTimelineGroup[]): ChatTimelineGroup[][] {
  const turns: ChatTimelineGroup[][] = []

  for (const group of groups) {
    if (startsTurn(group) || turns.length === 0) {
      turns.push([group])
      continue
    }
    turns[turns.length - 1].push(group)
  }

  return turns
}

export function turnChunkKey(chunk: ChatTimelineGroup[], index: number): string {
  const first = chunk[0]
  if (!first) return `turn:${index}`
  return `turn:${first.type === 'tool-group' ? first.messages[0].id : first.message.id}`
}

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
