import { describe, expect, it } from 'vitest'
import { LONG_PASTE_BYTES, isLongPaste, pastedTextBlock, pastedTextName } from '../../src/renderer/lib/longPaste'

describe('which pastes become a text file', () => {
  it.each([
    ['ASCII just under the size', 'a'.repeat(LONG_PASTE_BYTES - 1), Infinity, false],
    ['ASCII at the size', 'a'.repeat(LONG_PASTE_BYTES), Infinity, true],
    // A third as many characters, three UTF-8 bytes each: the size is in bytes, not characters.
    ['three-byte characters at the size', '€'.repeat(Math.ceil(LONG_PASTE_BYTES / 3)), Infinity, true],
    ['short text with no room left in the message', 'abc', 2, true],
    ['short text that fits what is left', 'abc', 3, false]
  ])('%s', (_case, text, room, expected) => {
    expect(isLongPaste(text, room)).toBe(expected)
  })
})

describe("a pasted text file's name", () => {
  it.each([
    ['one line', 'only', 'Pasted text, 1 line'],
    ['a last line break ends the last line', 'a\nb\n', 'Pasted text, 2 lines'],
    ['thousands are grouped', 'x\n'.repeat(1240), 'Pasted text, 1,240 lines']
  ])('%s', (_case, text, expected) => {
    expect(pastedTextName(text)).toBe(expected)
  })
})

describe('a long paste written into the message', () => {
  it('is fenced past any backticks in it, so the text cannot close the block early', () => {
    expect(pastedTextBlock('Pasted text, 3 lines', 'a\n`````\nb')).toBe('Pasted text, 3 lines:\n``````\na\n`````\nb\n``````')
  })

  it('measures the fence on a paste with very many runs of backticks', () => {
    const text = '`a'.repeat(150_000)
    expect(pastedTextBlock('Pasted text, 1 line', text).startsWith('Pasted text, 1 line:\n```\n')).toBe(true)
  })
})
