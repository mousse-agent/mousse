/**
 * Puts dictated text into the message box. The text replaces the selection (or goes at the caret),
 * with a space added on either side when it would otherwise run into neighbouring words.
 * Returns the new value and where the caret belongs afterwards (just after the inserted text).
 */
export function insertTranscript(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string
): { value: string; caret: number } {
  const text = transcript.trim()
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  if (!text) return { value, caret: end }
  const before = value.slice(0, start)
  const after = value.slice(end)
  const sepBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const sepAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const inserted = `${before}${sepBefore}${text}`
  return { value: `${inserted}${sepAfter}${after}`, caret: inserted.length }
}
