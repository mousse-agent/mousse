import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  MAX_MATCHES,
  buildFindIndex,
  cleanQuery,
  findOccurrences,
  formatFindCount,
  identityOf,
  initialMatch,
  normalizeForSearch,
  reselect,
  searchableParts,
  stepMatch,
  type FindMatch,
  type FindTurn
} from '../src/renderer/chat/components/agent-elements/find/find-index'
import { markdownToSearchBlocks, plainTextToSearchBlocks } from '../src/renderer/chat/components/agent-elements/find/search-text'

const message = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown): UIMessage =>
  ({ id, role, parts, metadata }) as unknown as UIMessage
const user = (id: string, text: string) => message(id, 'user', [{ type: 'text', text }])
const assistant = (id: string, ...texts: string[]) => message(id, 'assistant', texts.map((text) => ({ type: 'text', text })))

const turn = (key: string, userMsg: UIMessage | undefined, ...assistantMsgs: UIMessage[]): FindTurn => ({ key, userMsg, assistantMsgs })

describe('markdownToSearchBlocks', () => {
  it('reads the text a reader sees: emphasis, links and headings lose their syntax', () => {
    expect(markdownToSearchBlocks('# A **bold** and _soft_ ~~gone~~ [link](https://x.test) word')).toEqual(['A bold and soft gone link word'])
    expect(markdownToSearchBlocks('See [the docs][d] now.\n\n[d]: https://x.test/docs')).toEqual(['See the docs now.'])
  })

  it('keeps code verbatim, even when it looks like Markdown', () => {
    expect(markdownToSearchBlocks('Use `**x**` here')).toEqual(['Use **x** here'])
    expect(markdownToSearchBlocks('```ts\nconst a = "**name**";\nsecond line\n```')).toEqual(['const a = "**name**";\nsecond line'])
  })

  it('starts a block for each paragraph, quote, list item and table cell', () => {
    expect(markdownToSearchBlocks('one\n\n> two\n\n- three\n  - four\n\n| a | b |\n| - | - |\n| c | d |')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'a',
      'b',
      'c',
      'd'
    ])
  })

  it('drops what is not prose: image alt text, html, definitions, rules', () => {
    expect(markdownToSearchBlocks('before ![alt words](x.png) after\n\n<div>raw</div>\n\n---\n\n[d]: https://x.test')).toEqual(['before  after'])
  })

  it('resolves escapes and entities, as the page shows them', () => {
    expect(markdownToSearchBlocks('a \\*star\\* &amp; b')).toEqual(['a *star* & b'])
  })

  it('reads a soft break as a space in prose and a hard break as a boundary', () => {
    expect(markdownToSearchBlocks('first line\nsecond line')).toEqual(['first line second line'])
    expect(markdownToSearchBlocks('first line  \nsecond line')).toEqual(['first line', 'second line'])
  })

  it('leaves out fences the page draws as diagrams, and math while math is parsed', () => {
    expect(markdownToSearchBlocks('```mermaid\ngraph TD; A-->B\n```\n\ntext')).toEqual(['text'])
    expect(markdownToSearchBlocks('Cost $x+y$ here\n\n$$\nz\n$$', { math: true })).toEqual(['Cost  here'])
    // Math off: the page shows the source as text.
    expect(markdownToSearchBlocks('Cost $x+y$ here')).toEqual(['Cost $x+y$ here'])
  })

  it('reads a prompt as one block with line breaks as spaces', () => {
    expect(plainTextToSearchBlocks('a\nb\r\nc')).toEqual(['a b  c'])
    expect(plainTextToSearchBlocks('')).toEqual([])
  })
})

describe('normalizeForSearch', () => {
  it('lowercases and keeps the length for every input, so offsets map back', () => {
    for (const text of ['İstanbul', 'Straße', 'ẞ', '日本語 TEXT', '🎉 Party 🎉', 'é needle', 'ΣΑΣ', '']) {
      expect(normalizeForSearch(text).length).toBe(text.length)
    }
    expect(normalizeForSearch('Hello WORLD')).toBe('hello world')
    // `İ` lowercases to two code units; it stays as it is.
    expect(normalizeForSearch('İ')).toBe('İ')
  })

  it('does not normalize Unicode forms, so the offset of a later word does not move', () => {
    const decomposed = 'é needle'
    expect(normalizeForSearch(decomposed)).toBe(decomposed)
    expect(normalizeForSearch(decomposed).indexOf('needle')).toBe(3)
    // Known limit: a precomposed accent does not match a decomposed one.
    expect(findOccurrences(normalizeForSearch('café'), normalizeForSearch('café'))).toEqual([])
  })

  it('turns pasted line breaks in a query into spaces', () => {
    expect(cleanQuery('a\nb')).toBe('a b')
  })
})

describe('buildFindIndex', () => {
  const turns = [
    turn('t0', user('u0', 'Find the Needle please'), assistant('a0', 'A needle in **needle** hay.\n\nAnother NEEDLE.', 'second part needle')),
    turn('t1', user('u1', 'nothing here'), assistant('a1', 'only this')),
    turn('t2', user('u2', 'needle again'), assistant('a2', '`needle` and\nneedle across a line'))
  ]

  it('matches without regard to case, across turns, parts and messages, in reading order', () => {
    const matches = buildFindIndex(turns, 'NeEdLe')
    expect(matches.map((m) => [m.turnKey, m.messageId, m.partIndex, m.ordinal])).toEqual([
      ['t0', 'u0', 0, 0],
      ['t0', 'a0', 0, 0],
      ['t0', 'a0', 0, 1],
      ['t0', 'a0', 0, 2],
      ['t0', 'a0', 1, 0],
      ['t2', 'u2', 0, 0],
      ['t2', 'a2', 0, 0],
      ['t2', 'a2', 0, 1]
    ])
    expect(matches.every((m) => m.length === 6)).toBe(true)
  })

  it('finds matches in turns that are not mounted: it reads the messages, not the page', () => {
    // Nothing here knows which rows exist in the DOM; a far turn is as searchable as the first.
    const far = Array.from({ length: 1000 }, (_, i) =>
      turn(`k${i}`, user(`u${i}`, `prompt ${i}`), assistant(`a${i}`, i === 777 ? 'the zebra is here' : 'plain text'))
    )
    const matches = buildFindIndex(far, 'zebra')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ turnKey: 'k777', messageId: 'a777', partIndex: 0, ordinal: 0 })
  })

  it('does not match across a block boundary, and treats a soft break as a space', () => {
    expect(buildFindIndex([turn('t', undefined, assistant('a', 'end of one\n\nstart of two'))], 'one start')).toEqual([])
    expect(buildFindIndex([turn('t', undefined, assistant('a', '| a | b |\n| - | - |\n| left | right |'))], 'left right')).toEqual([])
    expect(buildFindIndex([turn('t', undefined, assistant('a', 'needle across a\nline here'))], 'a line')).toHaveLength(1)
  })

  it('matches text a reader sees and not the syntax around it', () => {
    const t = [turn('t', undefined, assistant('a', 'a **bold** claim with [a link](https://x.test/needle)'))]
    expect(buildFindIndex(t, 'bold claim')).toHaveLength(1)
    expect(buildFindIndex(t, '**')).toEqual([])
    expect(buildFindIndex(t, 'x.test')).toEqual([])
  })

  it('treats regex characters literally and does not overlap a match with itself', () => {
    const t = [turn('t', undefined, assistant('a', 'a.b a+b (a) [a] a*b aaaa'))]
    expect(buildFindIndex(t, 'a.b')).toHaveLength(1)
    expect(buildFindIndex(t, 'a+b')).toHaveLength(1)
    expect(buildFindIndex(t, '(a)')).toHaveLength(1)
    expect(buildFindIndex(t, '[a]')).toHaveLength(1)
    expect(buildFindIndex(t, '.*')).toEqual([])
    expect(buildFindIndex(t, 'aa').map((m) => m.offset)).toEqual([20, 22])
  })

  it('returns nothing for an empty query and caps a flood of matches', () => {
    expect(buildFindIndex(turns, '')).toEqual([])
    const many = [turn('t', undefined, assistant('a', 'x '.repeat(500)))]
    expect(buildFindIndex(many, 'x')).toHaveLength(500)
    const flood = [turn('t', undefined, assistant('a', 'x '.repeat(MAX_MATCHES + 50)))]
    expect(buildFindIndex(flood, 'x')).toHaveLength(MAX_MATCHES)
    expect(buildFindIndex(flood, 'x', { cap: 3 })).toHaveLength(3)
  })

  it('reads only what the page shows as text: no notices, handoffs, compaction or tool parts', () => {
    const notice = message('n', 'user', [{ type: 'text', text: 'needle from a subagent' }], {
      subagentNotice: [{ delegationId: 'd', childThreadId: 'c', runStatus: 'completed' }]
    })
    const handoff = message('h', 'assistant', [{ type: 'text', text: 'needle handoff' }], { contextHandoff: { from: {}, to: {} } })
    const compaction = message('c', 'assistant', [{ type: 'text', text: 'needle summary' }], { compaction: true })
    const tools = message('t', 'assistant', [
      { type: 'tool-Bash', toolCallId: 'x', state: 'output-available', input: { command: 'needle' }, output: 'needle' },
      { type: 'text', text: 'visible needle' }
    ])
    const matches = buildFindIndex([turn('t', notice, handoff, compaction, tools)], 'needle')
    expect(matches.map((m) => [m.messageId, m.partIndex])).toEqual([['t', 1]])
    expect(searchableParts(notice)).toEqual([])
  })

  it('keeps the message and part numbering stable when a reply grows', () => {
    const before = buildFindIndex([turn('t', user('u', 'q'), assistant('a', 'one needle'))], 'needle')
    const after = buildFindIndex([turn('t', user('u', 'q'), assistant('a', 'one needle\n\ntwo needle'))], 'needle')
    expect(identityOf(after[0]!)).toEqual(identityOf(before[0]!))
    expect(after).toHaveLength(2)
  })
})

describe('stepMatch and formatFindCount', () => {
  it('steps forward and back and wraps at both ends', () => {
    expect(stepMatch(3, 0, 1)).toBe(1)
    expect(stepMatch(3, 2, 1)).toBe(0)
    expect(stepMatch(3, 0, -1)).toBe(2)
    expect(stepMatch(3, 1, -1)).toBe(0)
    expect(stepMatch(1, 0, 1)).toBe(0)
    expect(stepMatch(1, 0, -1)).toBe(0)
  })

  it('starts at either end when nothing is active, and has nowhere to go without matches', () => {
    expect(stepMatch(4, null, 1)).toBe(0)
    expect(stepMatch(4, null, -1)).toBe(3)
    expect(stepMatch(0, null, 1)).toBeNull()
    expect(stepMatch(0, 0, -1)).toBeNull()
  })

  it('reads "3 of 12", "No matches", or nothing for an empty field', () => {
    expect(formatFindCount(2, 12, 'x')).toBe('3 of 12')
    expect(formatFindCount(0, 1, 'x')).toBe('1 of 1')
    expect(formatFindCount(null, 0, 'x')).toBe('No matches')
    expect(formatFindCount(null, 5, 'x')).toBe('5 matches')
    expect(formatFindCount(null, 1, 'x')).toBe('1 match')
    expect(formatFindCount(null, 0, '')).toBe('')
    expect(formatFindCount(MAX_MATCHES - 1, MAX_MATCHES, 'x')).toBe(`${MAX_MATCHES} of ${MAX_MATCHES}+`)
  })
})

describe('initialMatch and reselect', () => {
  const at = (turnKey: string, messageId: string, messageOrder: number, partIndex: number, ordinal: number): FindMatch => ({
    turnKey,
    messageId,
    messageOrder,
    partIndex,
    ordinal,
    block: 0,
    offset: 0,
    length: 1
  })
  const order = ['t0', 't1', 't2', 't3']
  const matches = [at('t0', 'a0', 1, 0, 0), at('t1', 'a1', 3, 0, 0), at('t1', 'a1', 3, 0, 1), at('t3', 'a3', 7, 0, 0)]

  it('starts at the first match in the turn at the top of the view, or below it', () => {
    expect(initialMatch(matches, order, { anchorTurnKey: 't1' })).toBe(1)
    expect(initialMatch(matches, order, { anchorTurnKey: 't2' })).toBe(3)
    expect(initialMatch(matches, order, { anchorTurnKey: 't0' })).toBe(0)
    expect(initialMatch(matches, order, { anchorTurnKey: null })).toBe(0)
  })

  it('skips the occurrences already above the top edge inside that turn', () => {
    expect(initialMatch(matches, order, { anchorTurnKey: 't1', isAboveViewport: (m) => m.ordinal === 0 && m.turnKey === 't1' })).toBe(2)
  })

  it('wraps to the first match when everything is above, and has none for an empty list', () => {
    expect(initialMatch(matches, order, { anchorTurnKey: 't3', isAboveViewport: () => true })).toBe(0)
    expect(initialMatch([], order, { anchorTurnKey: 't1' })).toBeNull()
  })

  it('keeps the same occurrence when matches arrive before it', () => {
    const previous = identityOf(matches[2]!)
    const grown = [at('t0', 'a0', 1, 0, 0), at('t0', 'a0', 1, 0, 1), ...matches.slice(1)]
    expect(reselect(grown, previous)).toBe(grown.findIndex((m) => m.messageId === 'a1' && m.ordinal === 1))
  })

  it('moves to the next match when the selected one is gone', () => {
    const previous = identityOf(matches[1]!)
    const without = [matches[0]!, matches[3]!]
    expect(reselect(without, previous)).toBe(1)
    expect(reselect([matches[0]!], previous)).toBe(0)
    expect(reselect(matches, null)).toBeNull()
    expect(reselect([], previous)).toBeNull()
  })
})
