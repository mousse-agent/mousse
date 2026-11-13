import { describe, expect, it } from 'vitest'
import {
  deleteQuoteTokenAt,
  expandQuoteTokens,
  findQuoteTokens,
  insertQuoteToken,
  quoteTokenAround,
  quoteTokenFor,
  type QuoteRegistry
} from '../src/renderer/lib/composerQuotes'

function registryWith(...texts: string[]): { registry: QuoteRegistry; tokens: string[] } {
  const registry: QuoteRegistry = new Map()
  const tokens = texts.map((text) => {
    const token = quoteTokenFor(text, registry)
    registry.set(token, text)
    return token
  })
  return { registry, tokens }
}

describe('Reply pills in the composer', () => {
  it('shows a Reply tag and the opening of the quote, shortened', () => {
    const { tokens } = registryWith('The cache is rebuilt whenever the schema version changes on startup.')
    const visible = tokens[0]!.replace(/[\u2068\u2069]/g, '').replace(/\u00a0/g, ' ')
    expect(visible.startsWith('Reply “The cache is rebuilt')).toBe(true)
    expect(visible.endsWith('…”')).toBe(true)
  })

  it('gives other words with the same opening their own token, and the same words the same one', () => {
    const registry: QuoteRegistry = new Map()
    const long = 'x'.repeat(40)
    const first = quoteTokenFor(`${long} one`, registry)
    registry.set(first, `${long} one`)
    expect(quoteTokenFor(`${long} one`, registry)).toBe(first)
    expect(quoteTokenFor(`${long} two`, registry)).not.toBe(first)
  })

  // What the agent receives: the quote in double quotes with one blank line above and below, wherever it sits.
  const rows: Array<{ name: string; typed: (t: string[]) => string; sent: string }> = [
    { name: 'between words', typed: ([a]) => `Why is ${a} true?`, sent: 'Why is\n\n"quoted words"\n\ntrue?' },
    { name: 'at the start', typed: ([a]) => `${a} explain this`, sent: '"quoted words"\n\nexplain this' },
    { name: 'at the end', typed: ([a]) => `About this: ${a} `, sent: 'About this:\n\n"quoted words"' },
    { name: 'alone', typed: ([a]) => a!, sent: '"quoted words"' },
    { name: 'after a line break', typed: ([a]) => `First line\n${a}\nnext`, sent: 'First line\n\n"quoted words"\n\nnext' },
    { name: 'two in a row', typed: ([a, b]) => `${a} ${b} compare`, sent: '"quoted words"\n\n"other\nlines"\n\ncompare' }
  ]
  for (const row of rows) {
    it(`expands a pill ${row.name}`, () => {
      const { registry, tokens } = registryWith('quoted words', 'other\nlines')
      expect(expandQuoteTokens(row.typed(tokens), registry)).toBe(row.sent)
    })
  }

  it('leaves text without pills, and a pill no longer registered, as typed', () => {
    const { tokens } = registryWith('quoted words')
    expect(expandQuoteTokens('plain  text\n', new Map())).toBe('plain  text\n')
    expect(expandQuoteTokens(`a ${tokens[0]} b`, new Map())).toBe(`a ${tokens[0]} b`)
  })

  it('stops treating a pill as one once its text is edited', () => {
    const { registry, tokens } = registryWith('quoted words')
    const edited = tokens[0]!.replace('Reply', 'Repl')
    expect(findQuoteTokens(`a ${edited}`, registry)).toEqual([])
  })

  it('inserts at the caret with spaces only where it touches words, and over a selection', () => {
    const token = '\u2068T\u2069'
    expect(insertQuoteToken('', 0, 0, token)).toEqual({ value: `${token} `, caret: token.length + 1 })
    expect(insertQuoteToken('ab', 1, 1, token)).toEqual({ value: `a ${token} b`, caret: token.length + 3 })
    expect(insertQuoteToken('a  b', 2, 2, token).value).toBe(`a ${token} b`)
    expect(insertQuoteToken('a xyz b', 2, 5, token).value).toBe(`a ${token} b`)
  })

  it('removes a whole pill with Backspace after it or Delete before it, and keeps the caret out of it', () => {
    const { registry, tokens } = registryWith('quoted words')
    const input = `hi ${tokens[0]} there`
    const spans = findQuoteTokens(input, registry)
    const start = 3
    const end = start + tokens[0]!.length
    expect(deleteQuoteTokenAt(input, spans, end, 'Backspace')).toEqual({ value: 'hi  there', caret: start })
    expect(deleteQuoteTokenAt(input, spans, start, 'Delete')).toEqual({ value: 'hi  there', caret: start })
    expect(deleteQuoteTokenAt(input, spans, start, 'Backspace')).toBeNull()
    expect(quoteTokenAround(spans, start + 2)?.index).toBe(start)
    expect(quoteTokenAround(spans, end)).toBeUndefined()
  })
})
