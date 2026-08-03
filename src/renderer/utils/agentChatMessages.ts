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

  const turn = messages.slice(lastUserIndex + 1)
  let lastAssistantIndex = -1
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const message = turn[index]
    if (
      message.role === 'assistant' &&
      !isToolTimelineMessage(message)
    ) {
      lastAssistantIndex = index
      break
    }
  }

  if (lastAssistantIndex < 0) return true
  if (turn[lastAssistantIndex].streaming) return true

  // An assistant can emit a short text block, then continue with thinking/tools before
  // the final answer. That intermediate block must not hide the working indicator.
  return turn.slice(lastAssistantIndex + 1).some((message) =>
    isToolTimelineMessage(message) || message.kind === 'progress' || message.kind === 'warning'
  )
}
