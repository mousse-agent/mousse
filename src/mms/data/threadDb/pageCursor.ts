/**
 * Page cursors of a transcript: the message id a page starts or ends at. When an id appears more than once (a
 * message written twice by an older build), the cursor also says which occurrence, so paging never jumps between
 * the copies. Readers treat a cursor as opaque and send it back.
 */
const OCCURRENCE = '\u001f'

/** A cursor's message id, and which occurrence of it (from 0, oldest first) when it names one. */
export function parseCursor(cursor: string): { id: string; occurrence?: number } {
  const at = cursor.lastIndexOf(OCCURRENCE)
  if (at < 0) return { id: cursor }
  const text = cursor.slice(at + 1)
  const occurrence = Number(text)
  return /^\d+$/.test(text) && Number.isSafeInteger(occurrence) ? { id: cursor.slice(0, at), occurrence } : { id: cursor }
}

/** The cursor of an id's `occurrence`: the id alone when it does not repeat. */
export function formatCursor(id: string, occurrence: number, repeats: boolean): string {
  return repeats ? `${id}${OCCURRENCE}${occurrence}` : id
}

/**
 * Where a cursor points in `messages`: the named occurrence, or the last one for a bare id. -1 when it is not there.
 */
export function cursorIndex(messages: ReadonlyArray<{ id: string }>, cursor: string): number {
  const { id, occurrence } = parseCursor(cursor)
  if (occurrence === undefined) {
    for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.id === id) return index
    return -1
  }
  let seen = 0
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.id !== id) continue
    if (seen === occurrence) return index
    seen += 1
  }
  return -1
}

/** The cursor of the message at `index`. */
export function cursorAt(messages: ReadonlyArray<{ id: string }>, index: number): string {
  const id = messages[index]!.id
  let occurrence = 0
  let total = 0
  for (let at = 0; at < messages.length; at++) {
    if (messages[at]!.id !== id) continue
    if (at < index) occurrence += 1
    total += 1
  }
  return formatCursor(id, occurrence, total > 1)
}
