import { afterEach, describe, expect, it } from 'vitest'
import {
  STREAMING_TOKENIZE_MS,
  codeHighlighter,
  extendTokens
} from '../../src/renderer/chat/components/agent-elements/code-highlighter'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'

const themes: ['github-light', 'github-dark'] = ['github-light', 'github-dark']
type Result = NonNullable<ReturnType<typeof codeHighlighter.highlight>>

const flat = (result: Result) => result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
/** A line is coloured when one of its tokens has a theme style. */
const coloured = (line: Result['tokens'][number]) => line.some((token) => Object.keys(token.htmlStyle ?? {}).length > 0)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Highlights `code` and waits for the coloured result. */
function settle(code: string, language: string): Promise<Result> {
  return new Promise((resolve) => {
    const sync = codeHighlighter.highlight({ code, language: language as never, themes }, resolve)
    if (sync && sync.tokens.some(coloured)) resolve(sync)
  })
}

afterEach(() => stopRenderCounts())

describe('a code block streaming in', () => {
  it('tokenises at most once per throttle window, shows every delta at once, and never loses a colour', async () => {
    let code = 'fn main() {\n    let rows = vec![1, 2, 3];\n'
    const first = await settle(code, 'rust')
    expect(first.tokens.some(coloured)).toBe(true)
    const counts = startRenderCounts()
    // Each delivered result, with the text the block had reached when it arrived.
    const delivered: Array<{ result: Result; latest: string }> = []
    const deltas = 40
    for (let i = 0; i < deltas; i++) {
      code += i % 3 === 2 ? `    println!("{}", rows[${i % 3}]);\n` : `    let v${i} = ${i};`
      const shown = codeHighlighter.highlight({ code, language: 'rust' as never, themes }, (result) => delivered.push({ result, latest: code }))
      // Every delta is on screen at once, and the lines coloured before keep their colours.
      expect(shown).not.toBeNull()
      expect(flat(shown!)).toBe(code)
      expect(coloured(shown!.tokens[0]!)).toBe(true)
      expect(coloured(shown!.tokens[1]!)).toBe(true)
      await sleep(10)
    }
    // 40 deltas over about 400 ms: one pass per 250 ms window, far below one per delta.
    expect(counts.tokenize ?? 0).toBeLessThanOrEqual(deltas / 5)
    await sleep(STREAMING_TOKENIZE_MS * 3)
    // Every result carries the whole text the block had reached when it arrived: no frame goes back to shorter text.
    expect(delivered.length).toBeGreaterThan(0)
    for (const { result, latest } of delivered) expect(flat(result)).toBe(latest)
    expect(flat(delivered.at(-1)!.result)).toBe(code)
    expect(delivered.at(-1)!.result.tokens.filter(coloured).length).toBeGreaterThan(5)
  })

  it('grows a late first result to the text the block has since reached', async () => {
    const start = 'package main\n\nfunc main() {\n'
    const later = start + '\tx := 1\n'
    const firstDelivered = new Promise<Result>((resolve) => {
      codeHighlighter.highlight({ code: start, language: 'go' as never, themes }, resolve)
    })
    // The block grows before its first pass ends: it shows plain, with all of its text.
    const shown = codeHighlighter.highlight({ code: later, language: 'go' as never, themes }, () => {})
    expect(shown).not.toBeNull()
    expect(flat(shown!)).toBe(later)
    // The first pass ends: the block gets colours with its newer text, never the shorter one.
    expect(flat(await firstDelivered)).toBe(later)
  })
})

describe('a block that reaches its final text from the cache', () => {
  it('is not set back by a result for its shorter text that arrives later', async () => {
    // The same fence twice in a reply: the second copy's final text is in the cache already.
    const full = 'def main():\n    rows = [1, 2, 3]\n    for row in rows:\n        print(row)\n'
    await settle(full, 'python')
    const partial = full.slice(0, 20)
    await settle(partial, 'python')
    const delivered: Result[] = []
    // The copy grows past its first pass; a throttled pass for this text is now waiting.
    const grown = full.slice(0, 40)
    codeHighlighter.highlight({ code: grown, language: 'python' as never, themes }, (result) => delivered.push(result))
    // It reaches its final text, which the cache answers at once.
    const final = codeHighlighter.highlight({ code: full, language: 'python' as never, themes })
    expect(flat(final!)).toBe(full)
    await sleep(STREAMING_TOKENIZE_MS * 3)
    // The late pass for the shorter text delivers the final text, not the shorter one.
    expect(delivered.length).toBeGreaterThan(0)
    for (const result of delivered) expect(flat(result)).toBe(full)
  })
})

describe('extendTokens', () => {
  it('keeps the tokens of known lines and adds the new text plain', () => {
    const previous = {
      code: 'let a\nlet b',
      result: {
        bg: '#fff', fg: '#000',
        tokens: [
          [{ content: 'let', color: '#f00', htmlStyle: { color: '#f00' }, offset: 0 }, { content: ' a', color: '#000', htmlStyle: { color: '#000' }, offset: 3 }],
          [{ content: 'let', color: '#f00', htmlStyle: { color: '#f00' }, offset: 6 }, { content: ' b', color: '#000', htmlStyle: { color: '#000' }, offset: 9 }]
        ]
      } as unknown as Result
    }
    const next = extendTokens(previous, 'let a\nlet bc\nlet d')
    expect(next.tokens[0]).toBe(previous.result.tokens[0])
    expect(next.tokens[1]!.slice(0, 2)).toEqual(previous.result.tokens[1])
    expect(next.tokens[1]![2]).toMatchObject({ content: 'c', color: 'inherit', offset: 11 })
    expect(next.tokens[2]).toEqual([expect.objectContaining({ content: 'let d', color: 'inherit', offset: 13 })])
    expect(next.bg).toBe('#fff')
  })
})
