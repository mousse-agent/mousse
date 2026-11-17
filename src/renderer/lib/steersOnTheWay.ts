import type { ChatImageAttachment, ChatMessage } from '../../shared/types'

/**
 * A steer sent here that the transcript does not show yet: painted in the reply at the click, so the message never
 * leaves the screen between the composer (or the queue) and the copy the service writes into the turn.
 */
export interface SteerOnTheWay {
  key: string
  threadId: string
  /** The words as the service writes them (trimmed). */
  text: string
  images?: ChatImageAttachment[]
  /** The queued message it is, when known: its copy in the turn carries the id. */
  itemId?: string
  /** When it was sent (ISO). */
  at: string
  /** How many user messages had these words when it was sent: one more means it landed. */
  before: number
}

const ROW_PREFIX = 'steer-on-the-way:'

/** User messages with these words, shown or not (a copy a Stop withdrew still counts: it landed once). */
export function countUserMessages(messages: readonly ChatMessage[], text: string): number {
  let count = 0
  for (const message of messages) if (message.role === 'user' && message.content.trim() === text) count++
  return count
}

export function steerOnTheWay(
  key: string,
  threadId: string,
  content: string,
  messages: readonly ChatMessage[],
  extra?: { itemId?: string; images?: ChatImageAttachment[] }
): SteerOnTheWay {
  const text = content.trim()
  return {
    key,
    threadId,
    text,
    ...(extra?.images?.length ? { images: extra.images } : {}),
    ...(extra?.itemId ? { itemId: extra.itemId } : {}),
    at: new Date().toISOString(),
    before: countUserMessages(messages, text)
  }
}

/** The service's copy is in the transcript: as a steer of the turn, or as the prompt of a turn of its own. */
export function steerLanded(steer: SteerOnTheWay, messages: readonly ChatMessage[]): boolean {
  if (steer.itemId && messages.some((message) => message.role === 'user' && (message.steerItemId === steer.itemId || message.queueItemId === steer.itemId))) return true
  return countUserMessages(messages, steer.text) > steer.before
}

/**
 * The transcript with this thread's steers on their way painted last, as the steered messages they will be. The
 * same array when there is nothing to paint.
 */
export function withSteersOnTheWay(messages: ChatMessage[], steers: readonly SteerOnTheWay[], threadId: string | null): ChatMessage[] {
  if (!threadId || steers.length === 0) return messages
  const shown = steers.filter((steer) => steer.threadId === threadId && (steer.text || steer.images?.length) && !steerLanded(steer, messages))
  if (shown.length === 0) return messages
  // After every row, whatever the clocks: the service writes a steer's copy last in the turn.
  let last = messages.reduce((latest, message) => Math.max(latest, Date.parse(message.timestamp) || 0), 0)
  const rows = shown.map((steer): ChatMessage => {
    last = Math.max(last + 1, Date.parse(steer.at) || 0)
    return {
      id: `${ROW_PREFIX}${steer.key}`,
      role: 'user',
      content: steer.text,
      timestamp: new Date(last).toISOString(),
      steered: true,
      ...(steer.images ? { images: steer.images } : {}),
      ...(steer.itemId ? { steerItemId: steer.itemId } : {})
    }
  })
  return [...messages, ...rows]
}
