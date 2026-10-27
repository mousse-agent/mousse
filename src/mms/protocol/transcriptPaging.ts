/**
 * Pieces of a long transcript, for a reader that cannot take it whole: the newest messages that fit
 * a byte budget, a page of the messages before one, and one image by its place in a message. A
 * message's size is its JSON, so an image held inline counts in full.
 */

interface Identified {
  id: string
}

/** What is left before the first message a reader was given: load it from `before` with `thread.messages`. */
export interface EarlierMessages {
  /** The id of the oldest message the reader has. */
  before: string
  /** How many older messages there still are. */
  count: number
}

const sizeOf = (message: unknown): number => Buffer.byteLength(JSON.stringify(message) ?? '')

/** The messages of `end` or fewer that are the newest to fit `maxBytes`; always at least one when there is any. */
function takeNewest<T>(messages: readonly T[], end: number, maxBytes: number, maxCount: number): T[] {
  let bytes = 0
  let start = end
  while (start > 0 && end - start < maxCount) {
    const size = sizeOf(messages[start - 1])
    if (start < end && bytes + size > maxBytes) break
    bytes += size
    start -= 1
  }
  return messages.slice(start, end) as T[]
}

/**
 * The newest messages that fit `maxBytes` (the newest one always), in order. `earlier` names the
 * older ones left out, if any.
 */
export function newestMessages<T extends Identified>(
  messages: readonly T[],
  maxBytes: number
): { messages: T[]; earlier?: EarlierMessages } {
  const kept = takeNewest(messages, messages.length, maxBytes, Number.POSITIVE_INFINITY)
  const left = messages.length - kept.length
  return left > 0 ? { messages: kept, earlier: { before: kept[0].id, count: left } } : { messages: kept }
}

/**
 * Up to `limit` messages immediately before the message `before`, within `maxBytes`, in order.
 * Undefined when `before` is not in the transcript.
 */
export function messagesBefore<T extends Identified>(
  messages: readonly T[],
  before: string,
  limit: number,
  maxBytes: number
): { messages: T[]; earlier?: EarlierMessages } | undefined {
  const at = messages.findIndex((message) => message.id === before)
  if (at < 0) return undefined
  const kept = takeNewest(messages, at, maxBytes, limit)
  const left = at - kept.length
  return left > 0 && kept.length
    ? { messages: kept, earlier: { before: kept[0].id, count: left } }
    : { messages: kept }
}

interface WithImages {
  images?: Array<{ name: string; mimeType: string; data?: string }>
}

/** The message with each image reduced to its name and type; the data is fetched with `thread.messageImage`. */
export function withoutImageBytes<T extends WithImages>(message: T): T {
  if (!Array.isArray(message.images) || !message.images.length) return message
  return {
    ...message,
    images: message.images.map((image) => ({ name: image.name, mimeType: image.mimeType }))
  }
}

/** One image of a message or a queued message, whole (`data` is base64), or undefined when there is none at `index`. */
export function imageAt(
  owner: WithImages | undefined,
  index: number
): { name: string; mimeType: string; data: string } | undefined {
  const image = owner?.images?.[index]
  if (!image || typeof image.data !== 'string') return undefined
  return { name: image.name, mimeType: image.mimeType, data: image.data }
}
