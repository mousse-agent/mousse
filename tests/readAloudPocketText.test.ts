import { describe, expect, it } from 'vitest'
import { UnigramTokenizer, preparePocketText, splitPocketChunks, type PocketTextOptions } from '../src/renderer/readAloud/pocketText'

const MARK = '▁'

/**
 * A tiny unigram model: the pieces below, plus every byte as `<0xNN>`. Longer pieces score higher,
 * so "▁hello" wins over "▁" + "h" + "ello".
 */
function tokenizerJson(normalizer: unknown = { type: 'Prepend', prepend: MARK }): string {
  const pieces: Array<[string, number]> = [['<unk>', 0], ['<s>', 0], ['</s>', 0], ['<pad>', 0]]
  for (let byte = 0; byte < 256; byte += 1) pieces.push([`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`, 0])
  const words = [MARK, `${MARK}hello`, `${MARK}world`, `${MARK}a`, `${MARK}b`, `${MARK}c`, 'h', 'e', 'l', 'o', 'w', 'r', 'd', '.', '!', '?', ',', ';', '1', '3', '4']
  for (const word of words) pieces.push([word, -Array.from(word).length])
  return JSON.stringify({ normalizer, model: { type: 'Unigram', unk_id: 0, byte_fallback: true, vocab: pieces } })
}

const OPTIONS: PocketTextOptions = {
  removeSemicolons: false,
  appendTerminalPunctuation: true,
  capitalizeFirstLetter: true,
  padWithSpacesForShortInputs: false,
  replaceCharacters: {},
  maxTokensPerChunk: 50
}

describe('UnigramTokenizer', () => {
  const tokenizer = new UnigramTokenizer(tokenizerJson())

  it('puts the longest-scoring pieces together, starting every word with a space mark', () => {
    const ids = tokenizer.encode('hello world')
    expect(tokenizer.decode(ids)).toBe('hello world')
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('falls back to single pieces when a word is not in the vocabulary', () => {
    expect(tokenizer.encode('low')).toHaveLength(4)
    expect(tokenizer.decode(tokenizer.encode('hold'))).toBe('hold')
  })

  it('writes a character the model lacks as its UTF-8 bytes and reads it back', () => {
    const ids = tokenizer.encode('a “')
    // "▁a", "▁", then the three bytes of the quote mark
    expect(ids).toHaveLength(5)
    expect(tokenizer.decode(ids)).toBe('a “')
    expect(tokenizer.decode(tokenizer.encode('’'))).toBe('’')
  })

  it('decodes a run of tokens without the leading space', () => {
    expect(tokenizer.decode(tokenizer.encode('hello'))).toBe('hello')
    expect(tokenizer.decode([])).toBe('')
  })

  it('accepts the space-mark prepend alone or inside a sequence and rejects other normalizers', () => {
    expect(() => new UnigramTokenizer(tokenizerJson({ type: 'Sequence', normalizers: [{ type: 'Prepend', prepend: MARK }] }))).not.toThrow()
    expect(() => new UnigramTokenizer(tokenizerJson({ type: 'NFKC' }))).toThrow('normalizer')
    expect(() => new UnigramTokenizer(tokenizerJson({ type: 'Sequence', normalizers: [{ type: 'NFKC' }, { type: 'Prepend', prepend: MARK }] }))).toThrow(
      'normalizer'
    )
    expect(() => new UnigramTokenizer(JSON.stringify({ model: { type: 'BPE' } }))).toThrow('unigram')
  })
})

describe('preparePocketText', () => {
  it('capitalizes the first letter and ends the text with a period', () => {
    expect(preparePocketText('hello there friend of mine again', OPTIONS)).toEqual({ text: 'Hello there friend of mine again.', framesAfterEos: 1 })
  })

  it('waits three frames after the end for four words or fewer', () => {
    expect(preparePocketText('Hello there friend.', OPTIONS).framesAfterEos).toBe(3)
    expect(preparePocketText('One two three four.', OPTIONS).framesAfterEos).toBe(3)
    expect(preparePocketText('One two three four five.', OPTIONS).framesAfterEos).toBe(1)
  })

  it.each([
    ['Done!', 'Done!'],
    ['Really?', 'Really?'],
    ['Wait...', 'Wait...'],
    ['She said "hi."', 'She said "hi."'],
    ['Go, then,', 'Go, then.'],
    ['Go then:', 'Go then.'],
    ['Go then -', 'Go then.'],
    ['He said "go"', 'He said "go".'],
    ['Plain text', 'Plain text.'],
    ['(Almost done)', '(Almost done).']
  ])('closes %s as %s', (input, expected) => {
    expect(preparePocketText(input, OPTIONS).text).toBe(expected)
  })

  it('turns line breaks into spaces and trims', () => {
    expect(preparePocketText('  first line\nsecond line\r\n', OPTIONS).text).toBe('First line second line.')
  })

  it('applies the optional rules of a language', () => {
    expect(preparePocketText('a; b', { ...OPTIONS, removeSemicolons: true }).text).toBe('A, b.')
    expect(preparePocketText('hello', { ...OPTIONS, capitalizeFirstLetter: false, appendTerminalPunctuation: false }).text).toBe('hello')
    expect(preparePocketText('hi there', { ...OPTIONS, padWithSpacesForShortInputs: true }).text).toBe(`${' '.repeat(8)}Hi there.`)
    expect(preparePocketText('He said “hi”: (ok)', { ...OPTIONS, replaceCharacters: { '“': '', '”': '', '(': '', ')': '', ':': ',' } }).text).toBe(
      'He said hi, ok.'
    )
  })

  it('rejects empty text', () => {
    expect(() => preparePocketText('  \n ', OPTIONS)).toThrow('empty')
  })
})

describe('splitPocketChunks', () => {
  const tokenizer = new UnigramTokenizer(tokenizerJson())

  it('keeps a short text in one chunk', () => {
    expect(splitPocketChunks('hello world', tokenizer, OPTIONS)).toEqual([{ text: 'Hello world.', framesAfterEos: 5 }])
  })

  it('groups sentences up to the token limit and starts a new chunk beyond it', () => {
    const text = 'hello. world. hello. world.'
    const wide = splitPocketChunks(text, tokenizer, OPTIONS)
    expect(wide).toHaveLength(1)
    // Every sentence takes two or three tokens, so four of them do not fit in five.
    const narrow = splitPocketChunks(text, tokenizer, { ...OPTIONS, maxTokensPerChunk: 5 })
    expect(narrow.length).toBeGreaterThan(1)
    expect(narrow.map((chunk) => chunk.text).join(' ').replace(/\./g, '').toLowerCase()).toBe('hello world hello world')
  })

  it('does not end a sentence at the dot of a decimal number', () => {
    const chunks = splitPocketChunks('hello 3.4 world', tokenizer, { ...OPTIONS, maxTokensPerChunk: 8 })
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Hello 3.4 world.'])
  })

  it('splits an over-long sentence at commas', () => {
    const chunks = splitPocketChunks('hello, world, hello, world', tokenizer, { ...OPTIONS, maxTokensPerChunk: 6 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.endsWith('.')).toBe(true)
  })

  it('gives every chunk two frames more than the text length suggests', () => {
    const [first, second] = splitPocketChunks('hello world hello world hello world. a b c.', tokenizer, { ...OPTIONS, maxTokensPerChunk: 14 })
    expect(first.framesAfterEos).toBe(3)
    expect(second.framesAfterEos).toBe(5)
  })
})
