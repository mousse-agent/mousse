/**
 * The rows of `thread_read` view `messages`: one per message, from an index, each message's text cut to a number of
 * characters (the first one from `textOffset`). The computer that runs the thread builds them, here for its own agents
 * and for a routed `thread.messages` with `index` (an agent on another computer, issue #1160), so a page reads the same
 * on one computer or two and only what the tool returns crosses.
 */

import { modelFacingReplyText } from '../../../../shared/applets'

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
  /** A reply's published applets, which read as one line each instead of their source (`modelFacingReplyText`). */
  presentationParts?: unknown
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

const textOf = (message: TranscriptMessage | undefined): string => (message ? modelFacingReplyText(message) : '')

/** Why `textOffset` cannot be read in the message at `afterIndex`, or undefined when it can. */
export function textOffsetProblem(all: readonly TranscriptMessage[], afterIndex: number, textOffset: number): string | undefined {
  const first = textOf(all[afterIndex])
  if (textOffset > 0 && afterIndex < all.length && textOffset >= first.length)
    return `textOffset ${textOffset} is past the end of message ${afterIndex}, which has ${first.length} characters`
  return undefined
}

/**
 * The rows from `afterIndex`, `limit` at most, built one at a time so a reader that stops early reads no further. A
 * system row with no text (a tool call's or a step's marker) says nothing to a reader and is left out, unless the page
 * reads on in it (`textOffset`); every row keeps its index in the transcript, so a page continues after its last row's
 * index (`nextAfterIndexOf`), not after as many rows as it holds.
 */
export function* messageRows(
  all: readonly TranscriptMessage[],
  page: { afterIndex: number; limit: number; textOffset: number; maxChars: number }
): Generator<MessageRow> {
  let yielded = 0
  for (let index = page.afterIndex; index < all.length && yielded < page.limit; index += 1) {
    const message = all[index]!
    const text = textOf(message)
    const from = index === page.afterIndex ? page.textOffset : 0
    if (message.role === 'system' && text.length === 0 && from === 0) continue
    yielded += 1
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

/**
 * Where the page after `rows` starts: after its last row's index (rows keep their transcript index, and empty system
 * rows are left out between them), or, on a page with no row, at the end of the transcript (`total`) when the page
 * started before it: every message left was one with nothing to read.
 */
export function nextAfterIndexOf(rows: ReadonlyArray<Pick<MessageRow, 'index'>>, afterIndex: number, total: number | undefined): number {
  const last = rows.at(-1)
  if (last) return last.index + 1
  return typeof total === 'number' ? Math.max(afterIndex, total) : afterIndex
}
