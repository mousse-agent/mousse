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

/**
 * One code block as Streamdown drives it: each new text is a new request with its own callback, and
 * the block shows the latest of the synchronous answer and any callback.
 */
function block(language: string) {
  const state = { code: '', shown: null as Result | null, delivered: [] as Array<{ result: Result; code: string }> }
  return {
    state,
    ask(code: string) {
      state.code = code
      const sync = codeHighlighter.highlight({ code, language: language as never, themes }, (result) => {
        state.delivered.push({ result, code: state.code })
        state.shown = result
      })
      if (sync) state.shown = sync
      return sync
    }
  }
}

afterEach(() => stopRenderCounts())

describe('a code block streaming in', () => {
  it('tokenises at most once per throttle window, shows every delta at once, and never loses a colour', async () => {
    let code = 'fn main() {\n    let rows = vec![1, 2, 3];\n'
    const first = await settle(code, 'rust')
    expect(first.tokens.some(coloured)).toBe(true)
    const counts = startRenderCounts()
    const live = block('rust')
    const deltas = 40
    for (let i = 0; i < deltas; i++) {
      code += i % 3 === 2 ? `    println!("{}", rows[${i % 3}]);\n` : `    let v${i} = ${i};`
      const shown = live.ask(code)
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
    expect(live.state.delivered.length).toBeGreaterThan(0)
    for (const { result, code: reached } of live.state.delivered) expect(flat(result)).toBe(reached)
    expect(flat(live.state.shown!)).toBe(code)
    expect(live.state.shown!.tokens.filter(coloured).length).toBeGreaterThan(5)
  })

  it('answers a late first pass with the text the block has since reached', async () => {
    const live = block('go')
    const start = 'package main\n\nfunc main() {\n'
    const later = start + '\tx := 1\n'
    expect(live.ask(start)).toBeNull()
    // The block grows before its first pass ends: it shows plain, with all of its text.
    const shown = live.ask(later)
    expect(flat(shown!)).toBe(later)
    await sleep(STREAMING_TOKENIZE_MS * 3)
    expect(live.state.delivered.length).toBeGreaterThan(0)
    for (const { result } of live.state.delivered) expect(flat(result)).toBe(later)
    expect(live.state.shown!.tokens.some(coloured)).toBe(true)
  })

  it('keeps two blocks of the same language apart', async () => {
    const a = block('java')
    const b = block('java')
    let codeA = 'class A {\n'
    let codeB = 'interface B {\n'
    a.ask(codeA)
    b.ask(codeB)
    for (let i = 0; i < 20; i++) {
      codeA += `  int a${i} = ${i};\n`
      codeB += `  void b${i}();\n`
      const shownA = a.ask(codeA)
      const shownB = b.ask(codeB)
      if (shownA) expect(flat(shownA)).toBe(codeA)
      if (shownB) expect(flat(shownB)).toBe(codeB)
      await sleep(15)
    }
    await sleep(STREAMING_TOKENIZE_MS * 3)
    // Each block only ever got its own text, at the length it had reached.
    for (const { result, code } of a.state.delivered) expect(flat(result)).toBe(code)
    for (const { result, code } of b.state.delivered) expect(flat(result)).toBe(code)
    expect(flat(a.state.shown!)).toBe(codeA)
    expect(flat(b.state.shown!)).toBe(codeB)
  })

  it('keeps the throttle when an older block of the same language is drawn again', async () => {
    const older = 'int main(void) {\n  return 0;\n}\n'
    await settle(older, 'c')
    let code = '#include <stdio.h>\n'
    await settle(code, 'c')
    const counts = startRenderCounts()
    const live = block('c')
    const deltas = 30
    for (let i = 0; i < deltas; i++) {
      code += `int v${i} = ${i};\n`
      live.ask(code)
      // A row scrolled back into view draws its finished block again.
      codeHighlighter.highlight({ code: older, language: 'c' as never, themes }, () => {})
      await sleep(10)
    }
    expect(counts.tokenize ?? 0).toBeLessThanOrEqual(deltas / 5)
    await sleep(STREAMING_TOKENIZE_MS * 3)
    expect(flat(live.state.shown!)).toBe(code)
  })
})

describe('a block that reaches its final text from the cache', () => {
  it('is not set back by a result for its shorter text that arrives later', async () => {
    // The same fence twice in a reply: the second copy's final text is in the cache already.
    const full = 'def main():\n    rows = [1, 2, 3]\n    for row in rows:\n        print(row)\n'
    await settle(full, 'python')
    const live = block('python')
    live.ask(full.slice(0, 20))
    await sleep(STREAMING_TOKENIZE_MS * 2)
    // The copy grows; a throttled pass for this text is now waiting.
    live.ask(full.slice(0, 40))
    // It reaches its final text, which the cache answers at once.
    expect(flat(live.ask(full)!)).toBe(full)
    await sleep(STREAMING_TOKENIZE_MS * 3)
    // The late pass for the shorter text never shows: the block keeps its final text.
    expect(flat(live.state.shown!)).toBe(full)
    for (const { result, code } of live.state.delivered) expect(flat(result)).toBe(code)
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
