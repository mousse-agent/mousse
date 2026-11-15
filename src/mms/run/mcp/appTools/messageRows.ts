/**
 * The rows of `thread_read` view `messages`: one per message, from an index, each message's text cut to a number of
 * characters (the first one from `textOffset`). The computer that runs the thread builds them, here for its own agents
 * and for a routed `thread.messages` with `index` (an agent on another computer, issue #1160), so a page reads the same
 * on one computer or two and only what the tool returns crosses.
 */

/** Where a cut of `text` at `end` falls, moved back one so it never splits a surrogate pair. */
export function cutEnd(text: string, end: number): number {
  if (end >= text.length) return text.length
  const code = text.charCodeAt(end - 1)
  return end > 0 && code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

export interface TranscriptMessage {
  id: string
  role: string
  timestamp?: unknown
  content?: unknown
}

export interface MessageRow {
  index: number
  id: string
  role: string
  timestamp: unknown
  text: string
  textOffset?: number
  truncated?: true
  totalChars?: number
  nextTextOffset?: number
}

const textOf = (message: TranscriptMessage | undefined): string => (message && typeof message.content === 'string' ? message.content : '')

/** Why `textOffset` cannot be read in the message at `afterIndex`, or undefined when it can. */
export function textOffsetProblem(all: readonly TranscriptMessage[], afterIndex: number, textOffset: number): string | undefined {
  const first = textOf(all[afterIndex])
  if (textOffset > 0 && afterIndex < all.length && textOffset >= first.length)
    return `textOffset ${textOffset} is past the end of message ${afterIndex}, which has ${first.length} characters`
  return undefined
}

/** The rows from `afterIndex`, `limit` at most, built one at a time so a reader that stops early reads no further. */
export function* messageRows(
  all: readonly TranscriptMessage[],
  page: { afterIndex: number; limit: number; textOffset: number; maxChars: number }
): Generator<MessageRow> {
  for (let index = page.afterIndex; index < Math.min(all.length, page.afterIndex + page.limit); index += 1) {
    const message = all[index]!
    const text = textOf(message)
    const from = index === page.afterIndex ? page.textOffset : 0
    const end = cutEnd(text, from + page.maxChars)
    yield {
      index,
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      text: text.slice(from, end),
      ...(from > 0 ? { textOffset: from } : {}),
      ...(end < text.length ? { truncated: true as const, totalChars: text.length, nextTextOffset: end } : {})
    }
  }
}
