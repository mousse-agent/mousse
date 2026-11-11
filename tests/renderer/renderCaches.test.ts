// @vitest-environment jsdom
/**
 * The chat's bounded render caches: parsed Markdown per block and message (markdown-cache.tsx) and
 * highlighted code per language, themes and code (code-highlighter.ts), both LRU by bytes.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ByteLruCache } from '../../src/renderer/lib/byteLruCache'
import { readWindowCounters } from '../../src/renderer/lib/windowCounters'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { markdownCache, MARKDOWN_CACHE_BYTES, parsedTreeBytes, parsedTreeShape } from '../../src/renderer/chat/components/agent-elements/markdown-cache'
import {
  codeHighlighter,
  highlightCache,
  highlightCacheKey,
  highlightResultBytes,
  HIGHLIGHT_CACHE_BYTES,
} from '../../src/renderer/chat/components/agent-elements/code-highlighter'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { setRenderMath } from '../../src/renderer/markdown/math/renderMathSetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  markdownCache.clear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stopRenderCounts()
  setRenderMath(undefined)
})

describe('ByteLruCache', () => {
  it('evicts the least recently used entries until the bytes fit the budget', () => {
    const cache = new ByteLruCache<string, string>(100)
    cache.set('a', 'A', 40)
    cache.set('b', 'B', 40)
    expect(cache.get('a')).toBe('A') // a is now newer than b
    cache.set('c', 'C', 40)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.bytes).toBe(80)
    // One large entry pushes out as many as it needs.
    cache.set('d', 'D', 90)
    expect([...['a', 'c', 'd'].filter((key) => cache.has(key))]).toEqual(['d'])
    expect(cache.bytes).toBe(90)
  })

  it('keeps nothing larger than the whole budget and counts a replaced entry once', () => {
    const cache = new ByteLruCache<string, string>(100)
    cache.set('huge', 'H', 101)
    expect(cache.size).toBe(0)
    cache.set('a', 'A', 30)
    expect(cache.bytes).toBe(30)
    cache.set('a', 'A2', 50)
    expect(cache.bytes).toBe(50)
    expect(cache.peek('a')).toBe('A2')
    cache.delete('a')
    expect(cache.bytes).toBe(0)
  })

  it('drops an entry replaced by one too large to keep', () => {
    const cache = new ByteLruCache<string, string>(100)
    cache.set('a', 'A', 40)
    cache.set('a', 'A2', 101)
    expect(cache.has('a')).toBe(false)
    expect(cache.bytes).toBe(0)
  })

  it('has budgets of about 10 MB for Markdown and 50 MB for code', () => {
    expect(MARKDOWN_CACHE_BYTES).toBe(10 * 1024 * 1024)
    expect(HIGHLIGHT_CACHE_BYTES).toBe(50 * 1024 * 1024)
  })
})

const heavyReply = [
  '## Results',
  '',
  'The renderer keeps a bounded window of rows and recycles their nodes as the list scrolls.',
  '',
  '- one item with `inline code`',
  '- two items with **bold** text',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> [!NOTE]',
  '> A note.',
].join('\n')

const mountMarkdown = (content: string, streaming = false) =>
  act(() => root.render(createElement(Markdown, { content, streaming })))
const unmountMarkdown = () => act(() => root.render(createElement('div')))

describe('parsed Markdown', () => {
  it('is parsed once, and drawn from the cache when it mounts again, with the same HTML', () => {
    const counts = startRenderCounts()
    mountMarkdown(heavyReply)
    const parsed = counts.blockParse ?? 0
    const split = counts.blocksSplit ?? 0
    expect(parsed).toBeGreaterThan(3)
    const html = host.innerHTML
    unmountMarkdown()
    const hitsBefore = markdownCache.hits
    mountMarkdown(heavyReply)
    expect(counts.blockParse).toBe(parsed)
    expect(counts.blocksSplit).toBe(split)
    expect(markdownCache.hits - hitsBefore).toBe(parsed + 1)
    expect(host.innerHTML).toBe(html)
  })

  it('is parsed again when math rendering is turned on or off, which parses the text differently', () => {
    const reply = 'Energy is $E = mc^2$ here.\n\nAnd a second paragraph.'
    setRenderMath(true)
    const counts = startRenderCounts()
    mountMarkdown(reply)
    const withMath = counts.blockParse ?? 0
    unmountMarkdown()
    setRenderMath(false)
    mountMarkdown(reply)
    expect(counts.blockParse).toBeGreaterThan(withMath)
    expect(host.innerHTML).not.toContain('E = mc^2</span>')
  })

  it('weighs a block by its elements and pieces of text, so a dense list weighs more than prose of the same length', () => {
    const denseList = Array.from({ length: 12 }, (_, k) => `- item ${k} uses \`fn${k}()\` and [docs](https://example.com/${k}) with **bold**`).join('\n')
    const prose = 'The renderer keeps a bounded window of rows and recycles their nodes as the list scrolls. '.repeat(Math.ceil(denseList.length / 90)).slice(0, denseList.length)
    const weigh = (content: string) => {
      markdownCache.clear()
      mountMarkdown(content)
      unmountMarkdown()
      return markdownCache.bytes
    }
    const dense = weigh(denseList)
    const plain = weigh(prose)
    expect(dense).toBeGreaterThan(plain * 3)
    // The estimate counts each element, each piece of text, the text and the key.
    const tree = createElement('ul', null, createElement('li', null, 'one ', createElement('code', null, 'x')), createElement('li', null, 'two'))
    expect(parsedTreeShape(tree)).toEqual({ elements: 4, texts: 3, chars: 8 })
    expect(parsedTreeBytes(tree, 'key')).toBeGreaterThan(parsedTreeBytes(createElement('p', null, 'one x two'), 'key'))
  })

  it('keeps only the text a streaming reply ends with, not each step on the way', () => {
    const counts = startRenderCounts()
    for (let end = 10; end < heavyReply.length + 10; end += 10) mountMarkdown(heavyReply.slice(0, end), true)
    mountMarkdown(heavyReply, false)
    const streamedEntries = markdownCache.size
    const streamedBytes = markdownCache.bytes
    expect(counts.blockParse).toBeGreaterThan(streamedEntries * 3)
    // Every block the reply ended with is kept: mounted again, nothing is parsed.
    unmountMarkdown()
    const parsed = counts.blockParse
    mountMarkdown(heavyReply, false)
    expect(counts.blockParse).toBe(parsed)
    // No more than the finished reply drawn on its own keeps: its blocks and its split.
    unmountMarkdown()
    markdownCache.clear()
    mountMarkdown(heavyReply, false)
    expect(streamedEntries).toBeLessThanOrEqual(markdownCache.size)
    expect(streamedBytes).toBeLessThanOrEqual(markdownCache.bytes)
  })

  it("gives the profiler's window breakdown its entries and estimated size only when asked, with no timer", () => {
    vi.useFakeTimers()
    try {
      mountMarkdown(heavyReply)
      // Filling the cache starts nothing: sizes are read only when the profiler asks.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    const { caches } = readWindowCounters()
    expect(caches.markdown).toEqual({ entries: markdownCache.size, kbEstimated: Math.round(markdownCache.bytes / 1024), limitKb: MARKDOWN_CACHE_BYTES / 1024 })
    expect(caches.markdown.entries).toBeGreaterThan(0)
    expect(caches.codeHighlight).toEqual({ entries: highlightCache.size, kbEstimated: Math.round(highlightCache.bytes / 1024), limitKb: HIGHLIGHT_CACHE_BYTES / 1024 })
  })

  it('drops the partial text a streaming block put there when it ends on text already held', () => {
    mountMarkdown('Hello world, the end.')
    unmountMarkdown()
    const held = markdownCache.size
    mountMarkdown('Hello world, the', true)
    expect(markdownCache.size).toBe(held + 1)
    // The same block reaches text the cache holds: the step on the way goes.
    mountMarkdown('Hello world, the end.', true)
    expect(markdownCache.size).toBe(held)
  })
})

describe('highlighted code', () => {
  const themes: ['github-light', 'github-dark'] = ['github-light', 'github-dark']
  const highlight = (code: string, language: string, names: [string, string] = themes) =>
    new Promise<NonNullable<ReturnType<typeof codeHighlighter.highlight>>>((resolve) => {
      const sync = codeHighlighter.highlight({ code, language: language as never, themes: names as never }, resolve)
      if (sync) resolve(sync)
    })

  it('is keyed by language and both themes as well as the code', () => {
    const key = highlightCacheKey('python', ['github-light', 'github-dark'], 'x = 1')
    expect(highlightCacheKey('javascript', ['github-light', 'github-dark'], 'x = 1')).not.toBe(key)
    expect(highlightCacheKey('python', ['github-light', 'nord'], 'x = 1')).not.toBe(key)
    expect(highlightCacheKey('python', ['github-light', 'github-dark'], 'x = 2')).not.toBe(key)
  })

  it('answers the same code and language from the cache, and misses for another language or theme', async () => {
    const code = 'value = [n * 2 for n in range(3)]'
    await highlight(code, 'python')
    expect(codeHighlighter.highlight({ code, language: 'python' as never, themes })).not.toBeNull()
    // The same text as another language, or with another theme, is tokenised again (asynchronously).
    expect(codeHighlighter.highlight({ code, language: 'ruby' as never, themes }, () => {})).toBeNull()
    expect(codeHighlighter.highlight({ code, language: 'python' as never, themes: ['github-dark', 'github-light'] as never }, () => {})).toBeNull()
  })

  it('weighs an entry by its text and tokens', async () => {
    const short = await highlight('a = 1', 'python')
    const long = await highlight('a = 1\n'.repeat(50), 'python')
    expect(highlightResultBytes(long)).toBeGreaterThan(highlightResultBytes(short) * 10)
    expect(highlightCache.bytes).toBeGreaterThan(0)
    // The key, which holds the code, is counted too: an entry weighs at least its key.
    const before = highlightCache.bytes
    const code = '# a comment that is long enough to see\n'.repeat(20)
    const tokens = await highlight(code, 'python')
    expect(highlightCache.bytes - before).toBeGreaterThanOrEqual(highlightResultBytes(tokens) + code.length * 2)
  })

  it('is drawn from the cache when a code block mounts again, without tokenising', async () => {
    const reply = 'Here:\n\n```ts\nexport function twice(n: number): number {\n  return n * 2\n}\n```'
    const counts = startRenderCounts()
    await act(async () => {
      root.render(createElement(Markdown, { content: reply }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const tokenized = counts.tokenize ?? 0
    expect(tokenized).toBeGreaterThan(0)
    const html = host.innerHTML
    unmountMarkdown()
    await act(async () => {
      root.render(createElement(Markdown, { content: reply }))
    })
    expect(counts.tokenize).toBe(tokenized)
    expect(host.innerHTML).toBe(html)
  })
})
