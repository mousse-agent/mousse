import { isToolTimelineMessage, type ChatMessage } from '../../shared/types'

export type ChatTimelineGroup =
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool-group'; messages: ChatMessage[] }

function isVisibleToolMessage(message: ChatMessage): boolean {
  return message.kind !== 'thinking' && isToolTimelineMessage(message) && Boolean(message.toolCall)
}

/**
 * A provider can emit an empty streaming assistant block before each tool call. Those
 * blocks are useful while the stream is live (they reserve the response area), but they
 * have no user-facing content and should not split one run of tools into several
 * "Used Tools" disclosures. Keep them buffered until we know whether a real message
 * follows; if another tool follows, the placeholder is omitted from the rendered
 * timeline, otherwise it is retained in its original position.
 */
function isEmptyAssistantPlaceholder(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.streaming === true &&
    !message.kind &&
    !message.toolCall &&
    !message.content.trim()
  )
}

/**
 * Coalesce adjacent tool timeline entries without changing their persisted order.
 * Thinking and ordinary chat messages intentionally break a group because they are
 * visible chronology boundaries. Empty provider placeholders are transparent only
 * between tool entries because they render no user-facing content.
 */
function startsTurn(group: ChatTimelineGroup): boolean {
  if (group.type !== 'message') return false
  if (group.message.role === 'user') return true
  return group.message.kind === 'plan_card'
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
  let pendingPlaceholders: ChatMessage[] = []

  const flushPlaceholders = () => {
    for (const placeholder of pendingPlaceholders) {
      groups.push({ type: 'message', message: placeholder })
    }
    pendingPlaceholders = []
  }

  for (const message of messages) {
    if (isEmptyAssistantPlaceholder(message)) {
      pendingPlaceholders.push(message)
      continue
    }

    const isToolMessage = isVisibleToolMessage(message)
    const previous = groups.at(-1)
    if (isToolMessage && previous?.type === 'tool-group') {
      previous.messages.push(message)
      pendingPlaceholders = []
      continue
    }

    flushPlaceholders()
    if (isToolMessage) {
      groups.push({ type: 'tool-group', messages: [message] })
    } else {
      groups.push({ type: 'message', message })
    }
  }

  flushPlaceholders()
  return groups
}
