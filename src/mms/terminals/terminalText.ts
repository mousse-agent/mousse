/**
 * Terminal output as an agent reads it: plain lines, without color codes and cursor controls, numbered from the first
 * line the terminal ever printed, and read from the end a page at a time.
 */

/**
 * One escape sequence or control character at a time: CSI (colors, cursor moves, erases), OSC (titles, links), DCS and
 * the like, two-byte escapes, carriage return, backspace and tab. Anything else is text.
 */
const TOKENS = /\u001b\[([0-?]*)[ -/]*([@-~])|\u009b([0-?]*)[ -/]*([@-~])|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[P^_X][\s\S]*?(?:\u001b\\|$)|\u001b[()*+][0-9A-Za-z]|\u001b[ -/]*[0-~]?|[\r\b\t]|[\u0000-\u0007\u000b-\u001f\u007f]/g

/** Lines an agent is given by default, and the most one call returns. */
export const TERMINAL_READ_DEFAULT_LINES = 80
export const TERMINAL_READ_MAX_LINES = 500
/** The most characters of output one call returns, and of one line. */
export const TERMINAL_READ_MAX_CHARS = 16_000
export const TERMINAL_READ_LINE_CHARS = 1_000

/**
 * One line (up to a line feed) as the screen shows it. The line is laid out in rows of `columns` characters, as the
 * terminal wraps it: a carriage return goes back to the start of the row the cursor is on, a backspace and cursor moves
 * move along it, an erase clears it, and text overwrites what is there. So a progress bar keeps its last state, a
 * cleared spinner leaves nothing, and a shell that redraws the second row of a long typed command keeps the first.
 */
function screenLine(line: string, columns: number): string {
  const rows: string[][] = [[]]
  let row = 0
  let col = 0
  const put = (char: string): void => {
    if (col >= columns) {
      row += 1
      col = 0
      rows[row] ??= []
    }
    const cells = rows[row]
    while (cells.length < col) cells.push(' ')
    cells[col] = char
    col += 1
  }
  const csi = (params: string, final: string): void => {
    const n = Number.parseInt(params.split(';')[0] || '', 10)
    const count = Number.isFinite(n) && n > 0 ? n : 1
    const cells = rows[row]
    switch (final) {
      case 'K': {
        const mode = Number.isFinite(n) ? n : 0
        if (mode === 2) rows[row] = []
        else if (mode === 1) for (let i = 0; i <= col && i < cells.length; i++) cells[i] = ' '
        else cells.length = Math.min(cells.length, col)
        break
      }
      case 'G': col = Math.max(0, count - 1); break
      case 'C': col += count; break
      case 'D': col = Math.max(0, col - count); break
      case 'A': row = Math.max(0, row - count); break
      case 'B': row += count; rows[row] ??= []; break
      default: break
    }
    for (let i = 0; i <= row; i++) rows[i] ??= []
  }
  let last = 0
  for (const match of line.matchAll(TOKENS)) {
    for (const char of line.slice(last, match.index)) put(char)
    last = match.index + match[0].length
    const token = match[0]
    if (token === '\r') col = 0
    else if (token === '\b') col = Math.max(0, col - 1)
    else if (token === '\t') { const stop = (Math.floor(col / 8) + 1) * 8; while (col < stop) put(' ') }
    else if (match[2] !== undefined) csi(match[1], match[2])
    else if (match[4] !== undefined) csi(match[3], match[4])
  }
  for (const char of line.slice(last)) put(char)
  return rows.map((cells) => cells.join('')).join('').replace(/\s+$/, '')
}

/**
 * Raw terminal output as plain lines (the last one may still be growing). `columns` is the terminal's width, where long
 * lines wrap; without it nothing wraps.
 */
export function terminalLines(raw: string, columns = Number.POSITIVE_INFINITY): string[] {
  return raw.split('\n').map((line) => screenLine(line, columns))
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
 * `TERMINAL_READ_MAX_CHARS` characters, laid out at `columns` (the terminal's width). `droppedLines` is how many lines the terminal printed before the start of `raw`,
 * so a line keeps its number while older output falls out of the buffer. Trailing blank lines (an empty prompt line) are
 * not counted as output.
 */
export function terminalPage(raw: string, options: { lines?: number; before?: number; droppedLines?: number; columns?: number } = {}): TerminalPage {
  const dropped = options.droppedLines ?? 0
  const all = terminalLines(raw, options.columns)
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
