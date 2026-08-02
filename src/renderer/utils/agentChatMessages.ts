import type { ChatMessage } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'

/** Reconcile a possibly stale IPC snapshot without dropping newer rendered entries. */
export function reconcileAgentMessages(
  current: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]))
  const currentIds = new Set(current.map((message) => message.id))

  return [
    ...current
      .filter((message) => incomingById.has(message.id) || !message.streaming)
      .map((message) => incomingById.get(message.id) ?? message),
    ...incoming.filter((message) => !currentIds.has(message.id))
  ]
}

export function upsertAgentMessage(current: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = current.findIndex((entry) => entry.id === message.id)
  if (index === -1) return [...current, message]
  return current.map((entry) => (entry.id === message.id ? message : entry))
}

export function isAgentAwaitingResponse(messages: ChatMessage[]): boolean {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return false
  return !messages.slice(lastUserIndex + 1).some(
    (message) =>
      message.role === 'assistant' &&
      !isToolTimelineMessage(message) &&
      !message.streaming
  )
}
