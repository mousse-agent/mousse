import { describe, expect, it } from 'vitest'
import {
  COMPOSER_MARKDOWN_MAX_LENGTH,
  composerMarkdownSpans,
  listContinuation
} from '../src/renderer/lib/composerMarkdown'

/** The styled pieces of `text`, as `piece:kind+kind`; unstyled pieces are left out. */
function styled(text: string): string[] {
  return composerMarkdownSpans(text)
    .filter((span) => span.kinds.length > 0)
    .map((span) => `${text.slice(span.start, span.end)}:${span.kinds.join('+')}`)
}

describe('composer Markdown spans', () => {
  it('cover the draft end to end, in order, so the backdrop paints every character once', () => {
    const text = '# Plan\n1. **fix** the `parser`\n- [ ] _test_ it\n> note\n```\ncode **not bold**\n```\nend'
    const spans = composerMarkdownSpans(text)
    expect(spans.map((span) => text.slice(span.start, span.end)).join('')).toBe(text)
    spans.forEach((span, index) => expect(span.start).toBe(index === 0 ? 0 : spans[index - 1].end))
  })

  it.each([
    ['**bold** text', ['**:bold+marker', 'bold:bold', '**:bold+marker']],
    ['__bold__', ['__:bold+marker', 'bold:bold', '__:bold+marker']],
    ['an *italic* word', ['*:italic+marker', 'italic:italic', '*:italic+marker']],
    ['an _italic_ word', ['_:italic+marker', 'italic:italic', '_:italic+marker']],
    ['~~gone~~', ['~~:strike+marker', 'gone:strike', '~~:strike+marker']],
    ['run `npm test`', ['`:code+marker', 'npm test:code', '`:code+marker']],
    ['**bold `code`**', ['**:bold+marker', 'bold :bold', '`:bold+code+marker', 'code:bold+code', '`:bold+code+marker', '**:bold+marker']],
    ['`**literal**`', ['`:code+marker', '**literal**:code', '`:code+marker']],
    ['see [docs](https://x.dev)', ['[:marker', 'docs:link', '](https://x.dev):marker']],
    ['## Heading', ['##:heading+marker', 'Heading:heading']],
    ['> quoted', ['>:quote+marker', ' quoted:quote']],
    ['- item', ['-:list']],
    ['  * item', ['*:list']],
    ['12. item', ['12.:list']],
    ['- [x] done', ['-:list', '[x] :list']]
  ])('%s', (text, expected) => {
    expect(styled(text)).toEqual(expected)
  })

  it.each([
    ['snake_case_name stays plain', 'underscores inside a word'],
    ['2 * 3 * 4', 'stars with spaces around them'],
    ['** not bold **', 'markers next to spaces'],
    ['**unclosed bold', 'an unclosed marker'],
    ['-item', 'a dash with no space after it'],
    ['#hashtag', 'a hash with no space after it']
  ])('leaves %s plain (%s)', (text) => {
    expect(styled(text)).toEqual([])
  })

  it('keeps a fenced block literal, fences included', () => {
    expect(styled('```ts\n**x**\n```')).toEqual(['```ts:codeblock+marker', '**x**:codeblock', '```:codeblock+marker'])
  })

  it('paints a draft over the size limit plain', () => {
    const text = `**a** ${'x'.repeat(COMPOSER_MARKDOWN_MAX_LENGTH)}`
    expect(composerMarkdownSpans(text)).toEqual([{ start: 0, end: text.length, kinds: [] }])
  })
})

/** Applies the continuation at the caret marked `|` and returns the new draft with the caret marked. */
function newLine(draft: string): string | null {
  const caret = draft.indexOf('|')
  const value = draft.replace('|', '')
  const edit = listContinuation(value, caret, caret)
  if (!edit) return null
  const next = value.slice(0, edit.start) + edit.text + value.slice(edit.end)
  const at = edit.start + edit.text.length
  return `${next.slice(0, at)}|${next.slice(at)}`
}

describe('list continuation on a new line', () => {
  it.each([
    ['1. first|', '1. first\n2. |'],
    ['9) ninth|', '9) ninth\n10) |'],
    ['- one|', '- one\n- |'],
    ['* one|', '* one\n* |'],
    ['+ one|', '+ one\n+ |'],
    ['  - nested|', '  - nested\n  - |'],
    ['- [x] done|', '- [x] done\n- [ ] |'],
    ['1.   wide gap|', '1.   wide gap\n2.   |'],
    ['1. split| here', '1. split\n2. | here'],
    ['intro\n1. a\n2. b|\nafter', 'intro\n1. a\n2. b\n3. |\nafter']
  ])('%j becomes %j', (draft, expected) => {
    expect(newLine(draft)).toBe(expected)
  })

  it.each([
    ['1. first\n2. |', '1. first\n|'],
    ['- one\n- |', '- one\n|'],
    ['- [ ] |', '|']
  ])('an empty item %j ends the list: %j', (draft, expected) => {
    expect(newLine(draft)).toBe(expected)
  })

  it.each([
    ['plain text|'],
    ['-not a list|'],
    ['```\n- inside a fence|']
  ])('%j gets a plain new line', (draft) => {
    expect(newLine(draft)).toBeNull()
  })
})
