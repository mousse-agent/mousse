/**
 * Terminal output as an agent reads it (`terminal_read`, a bot's `watch_list` with an id): plain lines, numbered from the
 * terminal's first line, read from the end a page at a time.
 */
import { describe, expect, it } from 'vitest'
import { TERMINAL_READ_LINE_CHARS, TERMINAL_READ_MAX_CHARS, terminalLines, terminalPage } from '../src/mms/terminals/terminalText'

describe('what a line reads as', () => {
  // The inputs a terminal prints that are not plain text.
  const rows: Array<[string, string, string[]]> = [
    ['colors', '\u001b[31mError:\u001b[0m boom\r\n', ['Error: boom', '']],
    ['bold and 256 colors', '\u001b[1;38;5;196mFAIL\u001b[m tests/a.test.ts\n', ['FAIL tests/a.test.ts', '']],
    ['a window title (OSC, ended by BEL)', '\u001b]0;npm run dev\u0007ready\n', ['ready', '']],
    ['a link (OSC 8, ended by ST)', '\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\\n', ['link', '']],
    ['a progress bar redrawn in place', '[#   ] 10%\r[### ] 70%\r[####] 100%\n', ['[####] 100%', '']],
    ['a line cleared before a shorter one', 'Downloading 10%\r\u001b[2KDone\n', ['Done', '']],
    ['backspaces', 'ab\bc\n', ['ac', '']],
    ['cursor moves and mode switches', '\u001b[?25l\u001b[2Jhello\u001b[?25h\u001b=\n', ['hello', '']],
    ['a bell and other controls', 'ding\u0007\u0000\n', ['ding', '']],
    ['trailing spaces', 'prompt $   \n', ['prompt $', '']],
    ['a partial last line', 'one\ntwo', ['one', 'two']]
  ]
  it.each(rows)('%s', (_name, raw, lines) => {
    expect(terminalLines(raw)).toEqual(lines)
  })
})

describe('a page of output', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n'

  it('is the last lines by default, numbered from the first, and says older ones are kept', () => {
    const page = terminalPage(numbered(200))
    expect(page).toMatchObject({ fromLine: 121, toLine: 200, lastLine: 200, more: true })
    expect(page.text.split('\n')[0]).toBe('line 121')
    expect(page.text.split('\n').at(-1)).toBe('line 200')
  })

  it('reads further back from a page\'s fromLine, down to the first line', () => {
    const page = terminalPage(numbered(200), { lines: 50, before: 121 })
    expect(page).toMatchObject({ fromLine: 71, toLine: 120, more: true })
    const first = terminalPage(numbered(200), { lines: 500, before: 71 })
    expect(first).toMatchObject({ fromLine: 1, toLine: 70, more: false })
  })

  it('keeps line numbers when older output fell out of the buffer', () => {
    // 1,000 lines were printed before what is kept: the kept first line is line 1,001.
    const page = terminalPage(numbered(10), { droppedLines: 1_000 })
    expect(page).toMatchObject({ fromLine: 1_001, toLine: 1_010, lastLine: 1_010, more: false })
  })

  it('does not count the empty prompt line at the end, and an empty terminal is an empty page', () => {
    expect(terminalPage('done\r\n\r\n')).toMatchObject({ fromLine: 1, toLine: 1, lastLine: 1, text: 'done' })
    expect(terminalPage('')).toMatchObject({ fromLine: 0, toLine: 0, lastLine: 0, text: '', more: false })
  })

  it('cuts a long line and stops at the size limit, saying so', () => {
    const long = terminalPage('x'.repeat(TERMINAL_READ_LINE_CHARS * 3))
    expect(long.text.length).toBe(TERMINAL_READ_LINE_CHARS + 1)
    expect(long.cut).toBe(true)
    const many = terminalPage(Array.from({ length: 400 }, () => 'y'.repeat(900)).join('\n'), { lines: 400 })
    expect(many.text.length).toBeLessThanOrEqual(TERMINAL_READ_MAX_CHARS)
    expect(many).toMatchObject({ toLine: 400, more: true, cut: true })
  })
})
