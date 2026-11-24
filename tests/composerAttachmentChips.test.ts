import { describe, expect, it } from 'vitest'
import { findSentChips, formatSentChip } from '../src/shared/inlineAttachments'
import { attachmentChipTokenFor, chipInsertion, plainOrphanChips, wordEdge, type AttachmentChipEntry } from '../src/renderer/lib/composerAttachmentChips'

describe('the sent text of an attachment chip', () => {
  it.each([
    ['an inline image, by its place', { kind: 'image', name: 'shot.png', image: 2 }, '[image 2: shot.png]'],
    ['a file sent as a path', { kind: 'file', name: 'notes.txt' }, '[file: notes.txt]'],
    ['a reference, by its kind', { kind: 'thread', name: 'Fix the login' }, '[thread: Fix the login]'],
    ['a name with brackets and new lines, flattened', { kind: 'file', name: 'a [b]\nc.txt' }, '[file: a b c.txt]']
  ] as const)('%s', (_, chip, sent) => {
    expect(formatSentChip(chip)).toBe(sent)
    expect(findSentChips(`see ${sent} now`)).toMatchObject([{ index: 4, length: sent.length }])
  })

  it.each([
    ['a place on a kind other than image', 'see [file 2: notes.txt]'],
    ['a kind that is not one', 'see [note: todo]'],
    ['an empty name', 'see [file:  ]']
  ])('is not read from %s', (_, text) => {
    expect(findSentChips(text)).toEqual([])
  })
})

describe('placing a chip in the text', () => {
  it.each([
    ['inside a word, to its nearer edge', 'use layout', 6, 4],
    ['inside a word, past its middle', 'use layout', 9, 10],
    ['between words, where it is', 'use layout', 4, 4],
    ['at the end, where it is', 'use layout', 10, 10]
  ])('a drop %s', (_, text, at, edge) => {
    expect(wordEdge(text, at)).toBe(edge)
  })

  it.each([
    ['spaces on both sides among words', 'ab', 1, ' T ', 3],
    ['no doubled space beside an existing one', 'a b', 2, 'T ', 2],
    ['no space at the end', 'ab', 2, ' T', 2]
  ])('%s', (_, text, at, inserted, caret) => {
    expect(chipInsertion(text, at, at, ['T'])).toEqual({ text: inserted, caret })
  })
})

it('a token whose attachment is gone reads as its plain name; a registered one stays a chip', () => {
  const registry = new Map<string, AttachmentChipEntry>()
  const kept: AttachmentChipEntry = { key: 'file:a', name: 'kept-file.txt', kind: 'file' }
  const keptToken = attachmentChipTokenFor(kept, registry)
  registry.set(keptToken, kept)
  const goneToken = attachmentChipTokenFor({ key: 'file:b', name: 'old notes.txt', kind: 'file' }, new Map())
  expect(plainOrphanChips(`${keptToken} and ${goneToken}`, registry)).toBe(`${keptToken} and old notes.txt`)
})
