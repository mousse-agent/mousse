/**
 * Terminal output as an agent reads it: plain lines, without color codes and cursor controls, numbered from the first
 * line the terminal ever printed, and read from the end a page at a time.
 */

/** Escape sequences: CSI (colors, cursor moves), OSC (titles, links), and the two-byte and charset ones. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[P^_][\s\S]*?(?:\u001b\\|$)|\u001b[()*+][0-9A-Za-z]|\u001b[ -/]*[0-~]/g
/** Control characters other than the line breaks, tab, backspace and carriage return handled below. */
const CONTROLS = /[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g

/** Lines an agent is given by default, and the most one call returns. */
export const TERMINAL_READ_DEFAULT_LINES = 80
export const TERMINAL_READ_MAX_LINES = 500
/** The most characters of output one call returns, and of one line. */
export const TERMINAL_READ_MAX_CHARS = 16_000
export const TERMINAL_READ_LINE_CHARS = 1_000

/**
 * One line as the screen would show it: a carriage return starts the line over (a progress bar keeps its last state),
 * a backspace takes back the character before it.
 */
function settleLine(line: string): string {
  let text = line
  if (text.includes('\r')) {
    const parts = text.split('\r')
    // The last state a redrawn line reached (a progress bar, a spinner). Programs that redraw a shorter text clear the
    // line first, so the last non-empty part is what the screen shows.
    text = parts.reverse().find((part) => part.length > 0) ?? ''
  }
  if (text.includes('\b')) {
    const out: string[] = []
    for (const char of text) {
      if (char === '\b') out.pop()
      else out.push(char)
    }
    text = out.join('')
  }
  return text.replace(/\s+$/, '')
}

/** Raw terminal output as plain lines (the last one may still be growing). */
export function terminalLines(raw: string): string[] {
  const plain = raw.replace(ESCAPES, '').replace(/\r\n/g, '\n').replace(CONTROLS, '')
  return plain.split('\n').map(settleLine)
}

export interface TerminalPage {
  /** The first and last line returned, numbered from the terminal's first line (1). 0 when there are none. */
  fromLine: number
  toLine: number
  /** The number of the terminal's last line. */
  lastLine: number
  text: string
  /** Older lines are still kept: pass `fromLine` as `before` to read them. */
  more: boolean
  /** Some lines were cut at `TERMINAL_READ_LINE_CHARS`, or fewer lines than asked fit in `TERMINAL_READ_MAX_CHARS`. */
  cut?: true
}

/**
 * The page of `raw` that ends just before line `before` (or at the end), at most `lines` lines and
 * `TERMINAL_READ_MAX_CHARS` characters. `droppedLines` is how many lines the terminal printed before the start of `raw`,
 * so a line keeps its number while older output falls out of the buffer. Trailing blank lines (an empty prompt line) are
 * not counted as output.
 */
export function terminalPage(raw: string, options: { lines?: number; before?: number; droppedLines?: number } = {}): TerminalPage {
  const dropped = options.droppedLines ?? 0
  const all = terminalLines(raw)
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  const lastLine = dropped + all.length
  const wanted = Math.max(1, Math.min(TERMINAL_READ_MAX_LINES, Math.floor(options.lines ?? TERMINAL_READ_DEFAULT_LINES)))
  // `before` is a line number: the page ends at the line before it, never past what is kept.
  const endIndex = Math.max(0, Math.min(all.length, (options.before ?? lastLine + 1) - 1 - dropped))
  const picked: string[] = []
  let chars = 0
  let cut = false
  for (let index = endIndex - 1; index >= 0 && picked.length < wanted; index--) {
    let line = all[index]
    if (line.length > TERMINAL_READ_LINE_CHARS) {
      line = `${line.slice(0, TERMINAL_READ_LINE_CHARS)}…`
      cut = true
    }
    if (chars + line.length + 1 > TERMINAL_READ_MAX_CHARS && picked.length > 0) {
      cut = true
      break
    }
    picked.push(line)
    chars += line.length + 1
  }
  picked.reverse()
  const startIndex = endIndex - picked.length
  return {
    fromLine: picked.length ? dropped + startIndex + 1 : 0,
    toLine: picked.length ? dropped + endIndex : 0,
    lastLine,
    text: picked.join('\n'),
    more: startIndex > 0,
    ...(cut ? { cut: true as const } : {})
  }
}

/** How many line breaks `text` holds: what a buffer that drops `text` from its start adds to its dropped lines. */
export function countLineBreaks(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++
  return count
}
