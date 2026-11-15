/**
 * Text pasted at or over this size (UTF-8 bytes) goes on the message as a text file instead of into the box: a long
 * log or file stays out of the way, and the agent reads it in full from the file.
 */
export const LONG_PASTE_BYTES = 32 * 1024

const utf8 = new TextEncoder()

/**
 * Whether pasted `text` becomes a text file on the message rather than text in the box: it is long, or it would take
 * the message past what the message can carry (`room`, in characters).
 */
export function isLongPaste(text: string, room = Infinity): boolean {
  if (text.length > room) return true
  // Each UTF-16 unit is at most 3 UTF-8 bytes, so short text is decided without encoding it.
  if (text.length * 3 < LONG_PASTE_BYTES) return false
  return text.length >= LONG_PASTE_BYTES || utf8.encode(text).byteLength >= LONG_PASTE_BYTES
}

function lineCount(text: string): number {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1
  // A last line break ends the last line; it does not start another.
  return text.endsWith('\n') && lines > 1 ? lines - 1 : lines
}

/** What the chip and the message call a pasted text file: "Pasted text, 1,240 lines". */
export function pastedTextName(text: string): string {
  const lines = lineCount(text)
  return `Pasted text, ${lines.toLocaleString('en-US')} ${lines === 1 ? 'line' : 'lines'}`
}

/** A long paste as the file the message carries: plain text, with a file name that is safe on every computer. */
export function longPasteFile(text: string, now = Date.now()): File {
  return new File([text], `pasted-text-${now}.txt`, { type: 'text/plain' })
}

/**
 * A long paste written into the message itself, for a thread whose agent runs on another computer (no file there to
 * read): its name, then the text in a fence longer than any run of backticks in it.
 */
export function pastedTextBlock(name: string, text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${name}:\n${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
}
