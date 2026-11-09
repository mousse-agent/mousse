import { describe, expect, it } from 'vitest'
import {
  PREVIEW_CODE_PLACEHOLDER,
  cappedWords,
  markdownPreviewText
} from '../../src/renderer/chat/components/agent-elements/utils/preview-text'

describe('markdownPreviewText', () => {
  it('drops emphasis, strikethrough and inline code markers', () => {
    expect(markdownPreviewText('**The Night Shift of the Machines**')).toBe('The Night Shift of the Machines')
    expect(markdownPreviewText('a *soft* and _quiet_ ~~old~~ `npm test` run, __done__')).toBe('a soft and quiet old npm test run, done')
    // Underscores and asterisks inside words stay.
    expect(markdownPreviewText('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
  })

  it('drops heading marks, list bullets, task boxes and quote marks', () => {
    expect(markdownPreviewText('# Title\n\n## Part two ##\n\n- one\n* two\n+ three\n1. four\n2) five\n- [x] six')).toBe(
      'Title Part two one two three four five six'
    )
    expect(markdownPreviewText('> quoted\n> > nested')).toBe('quoted nested')
  })

  it('keeps link text, drops images and HTML tags', () => {
    expect(markdownPreviewText('See [the docs](https://x.test/docs) and [ref][1]. ![chart](a.png)<br>Next <b>bold</b>')).toBe(
      'See the docs and ref. Next bold'
    )
    expect(markdownPreviewText('Mail <mailto:a@x.test> or <https://x.test>')).toBe('Mail mailto:a@x.test or https://x.test')
  })

  it('reads a table as its cells, without pipes or the divider', () => {
    expect(markdownPreviewText('| Name | Size |\n| --- | ---: |\n| a.ts | 2 KB |')).toBe('Name Size a.ts 2 KB')
  })

  it('stands a short placeholder in for a fenced code block', () => {
    expect(markdownPreviewText('Run this:\n\n```bash\nnpm test\n```\n\nThen check.')).toBe(`Run this: ${PREVIEW_CODE_PLACEHOLDER} Then check.`)
    expect(markdownPreviewText('~~~\nunclosed fence\nstill code')).toBe(PREVIEW_CODE_PLACEHOLDER)
  })

  it('collapses whitespace and line breaks, and decodes entities and escapes', () => {
    expect(markdownPreviewText('  one\n\n\n   two\tthree  \r\n---\nfour  ')).toBe('one two three four')
    expect(markdownPreviewText('Tom &amp; Jerry &#8212; \\*not bold\\*')).toBe('Tom & Jerry — *not bold*')
  })

  it('reads only the start of a long message and marks the cut', () => {
    const long = 'word '.repeat(1000)
    const text = markdownPreviewText(long, 100)
    expect(text.endsWith(' …')).toBe(true)
    expect(text.length).toBeLessThan(110)
    expect(markdownPreviewText('')).toBe('')
  })
})

describe('cappedWords', () => {
  it('keeps the first words and ends with an ellipsis when there were more', () => {
    expect(cappedWords('write a long poem', 10)).toBe('write a long poem')
    expect(cappedWords('one two three four', 2)).toBe('one two…')
  })

  it('previews a reply as the rail does', () => {
    const reply = '**The Night Shift of the Machines**\n\n*In the hum of the server room,*\n*the fans begin their song.*'
    expect(cappedWords(markdownPreviewText(reply), 13)).toBe('The Night Shift of the Machines In the hum of the server room,…')
  })
})
