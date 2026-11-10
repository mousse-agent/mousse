import { describe, expect, it } from 'vitest'
import { parseMarkdownIntoBlocks } from 'streamdown'
import {
  createIncrementalNormalizer,
  createIncrementalSplitter,
  stableCut
} from '../../src/renderer/chat/components/agent-elements/streaming-markdown'
import { normalizeCodeFenceLanguages, normalizeMarkdown } from '../../src/renderer/chat/components/agent-elements/markdown'

const normalize = (text: string) => normalizeCodeFenceLanguages(normalizeMarkdown(text), false)

const fence = (n: number) => '```ts title=x\nexport function step' + n + '(rows: Array<{ id: string }>): Map<string, number> {\n  const out = new Map<string, number>()\n\n  for (const row of rows) out.set(row.id, ' + n + ')\n  return out\n}\n```\n'

/** Replies with the shapes a model writes: prose, lists that continue after blank lines, tables, fences, quotes. */
const REPLIES: Record<string, string> = {
  prose: '## Plan\n\nThe renderer keeps a bounded window of rows.\nIt recycles their nodes.\n\n\n\nA third paragraph with **bold** and `code`.\n',
  lists: 'Steps:\n\n- one\n- two\n\n- loose three\n\n  continued under three\n\n1.\n\nnumbered after a bare number\n\n2) second\n\nAfter the list.\n',
  table: 'Before.\n\n| Metric | Before | After |\n|---|---:|---:|\n| a | 1 | 2 |\n| b | 3 | 4 |\n\nAfter the table.\n',
  fences: 'Intro.\n\n' + fence(1) + '\nBetween.\n\n' + fence(2) + '\n~~~\nraw ~~~ fence\n\nwith a blank line\n~~~\n\nEnd.\n',
  quote: '> [!NOTE]\n> A note.\n\n> plain quote\n\nText.\n\n---\n\nAfter a rule.\n',
  links: 'See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com\n',
  html: 'Text.\n\n<details>\n<summary>More</summary>\n\nInside.\n\n</details>\n\nAfter.\n',
  mousseLinks: 'Open [the file](mousse-file://open?path=a.ts).\n\nThen [another](mousse-file://open?path=b.ts).\n',
  // Fence markers that only the line-start fence rules see, or only `normalizeMarkdown` sees.
  inlineFence: 'Wrap code in ``` to fence it.\n\nIntro:\n\n- one\n\n- two\n\nClose with ``` too.\n\nAfter.\n',
  tildeFence: 'Before.\n\n~~~\ncode\n\n- not a list\n\n- still code\n~~~\n\n- a real\n\n- list\n',
  fourBackticks: 'Before.\n\n````md\n```js\nx\n```\n\n- a\n\n- b\n````\n\n- c\n\n- d\n',
  fenceInFence: 'Before.\n\n```md\n```js\n\n- a\n\n- b\n```\n\nText.\n\n- e\n\n- f\n'
}

/** Feeds `text` as a stream: one call per `step` characters, as deltas arrive. */
function stream(text: string, step: number): string[] {
  const out: string[] = []
  for (let end = step; end < text.length + step; end += step) out.push(text.slice(0, Math.min(end, text.length)))
  return out
}

describe('incremental Markdown while a reply streams', () => {
  for (const [name, reply] of Object.entries(REPLIES)) {
    for (const step of [1, 7, 23]) {
      it(`normalises and splits "${name}" exactly as the whole text, ${step} characters at a time`, () => {
        const normalizeLive = createIncrementalNormalizer(normalize)
        const splitLive = createIncrementalSplitter(parseMarkdownIntoBlocks)
        for (const text of stream(reply, step)) {
          const normalized = normalizeLive(text)
          expect(normalized).toBe(normalize(text))
          expect(splitLive(normalized)).toEqual(parseMarkdownIntoBlocks(normalized))
        }
      })
    }
  }

  it('starts over when the text is replaced rather than extended', () => {
    const splitLive = createIncrementalSplitter(parseMarkdownIntoBlocks)
    splitLive('First.\n\nSecond.\n\nThird')
    const other = 'Other.\n\nText.\n\nHere'
    expect(splitLive(other)).toEqual(parseMarkdownIntoBlocks(other))
  })

  it('splits only the live tail once the earlier blocks are final', () => {
    const calls: string[] = []
    const splitLive = createIncrementalSplitter((text) => {
      calls.push(text)
      return parseMarkdownIntoBlocks(text)
    })
    const reply = REPLIES.fences!
    for (const text of stream(reply, 5)) splitLive(text)
    // Each call splits the tail, and a finished block is split once more when the cut moves past it:
    // never the whole reply again.
    const longest = Math.max(...calls.map((text) => text.length))
    expect(longest).toBeLessThan(reply.length / 2)
  })
})

describe('stableCut', () => {
  it('cuts after a blank line before a new block, never inside a fence', () => {
    const text = 'One.\n\n```\na\n\nb\n```\n\nTwo.\n\nThree'
    // The line still being written could yet become a list item, so the cut stays before the complete one.
    expect(text.slice(stableCut(text).cut)).toBe('Two.\n\nThree')
    expect(stableCut('One.\n\n```\na\n\nb').cut).toBe('One.\n\n'.length)
  })

  it('does not cut before a list item or indented text', () => {
    expect(stableCut('- a\n\n- b\n\n  more\n').cut).toBe(0)
  })

  it('does not cut text with syntax that ties blocks together', () => {
    expect(stableCut('A.\n\nB [x][y].\n\n[y]: https://x\n\nC').cut).toBe(0)
    expect(stableCut('A.\n\n<div>\n\nB\n\n</div>\n\nC').cut).toBe(0)
    expect(stableCut('A.\n\n$$\nx\n$$\n\nC').cut).toBe(0)
  })

  it('works on the whole text when its fences are read differently by different steps', () => {
    // A triple backtick in prose, a longer fence, a backtick fence inside a tilde fence, a fence line with an info
    // string inside an open fence, and one still being written.
    for (const text of [
      'Use ``` here.\n\nA.\n\nB',
      'A.\n\n````md\nx\n````\n\nB.\n\nC',
      'A.\n\n~~~\n```\n~~~\n\nB.\n\nC',
      'A.\n\n```md\n```js\n```\n\nB.\n\nC',
      'A.\n\nB.\n\nC ```'
    ]) expect(stableCut(text)).toEqual({ cut: 0, tied: true })
    // Plain fences, opened with an info string and closed by a bare line, keep the incremental path.
    expect(stableCut('A.\n\n```ts\nx\n```\n\nB.\n\nC').tied).toBe(false)
  })

  it('ignores markup inside code', () => {
    const text = 'Use `<div>` here.\n\n```ts\nconst m: Map<string, number> = new Map()\n```\n\nNext.\n\nLast'
    expect(text.slice(stableCut(text).cut)).toBe('Next.\n\nLast')
  })
})
