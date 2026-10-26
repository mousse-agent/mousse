import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  codeHighlighter,
  exceedsHighlightLimit,
  resolveHighlightLanguage,
} from '../src/renderer/chat/components/agent-elements/code-highlighter'
import { Markdown } from '../src/renderer/chat/components/agent-elements/markdown'

const themes: ['github-light', 'github-dark'] = ['github-light', 'github-dark']

function highlight(code: string, language: string) {
  return new Promise<NonNullable<ReturnType<typeof codeHighlighter.highlight>>>((resolve) => {
    const sync = codeHighlighter.highlight({ code, language: language as never, themes }, resolve)
    if (sync) resolve(sync)
  })
}

const styles = (result: { tokens: { htmlStyle?: unknown }[][] }) =>
  new Set(result.tokens.flat().map((token) => JSON.stringify(token.htmlStyle)))

const flat = (result: { tokens: { content: string }[][] }) =>
  result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')

describe('code highlighter size guard', () => {
  it('returns plain tokens synchronously for blocks over the character limit', () => {
    const code = 'const a = 1\n'.repeat(1) + 'x'.repeat(MAX_HIGHLIGHT_CHARS)
    let called = false
    const result = codeHighlighter.highlight(
      { code, language: 'typescript' as never, themes },
      () => {
        called = true
      },
    )
    expect(result).not.toBeNull()
    expect(flat(result!)).toBe(code)
    expect(result!.tokens[0][0].color).toBe('inherit')
    expect(called).toBe(false)
  })

  it('returns plain tokens synchronously for blocks over the line limit', () => {
    const code = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => `x${i}`).join('\n')
    expect(exceedsHighlightLimit(code)).toBe(true)
    const result = codeHighlighter.highlight({ code, language: 'python' as never, themes })
    expect(result).not.toBeNull()
    expect(result!.tokens).toHaveLength(MAX_HIGHLIGHT_LINES + 1)
  })

  it('does not apply the guard at the limits', () => {
    expect(exceedsHighlightLimit('x'.repeat(MAX_HIGHLIGHT_CHARS))).toBe(false)
    expect(exceedsHighlightLimit('x\n'.repeat(MAX_HIGHLIGHT_LINES - 1) + 'x')).toBe(false)
  })
})

describe('code highlighter languages', () => {
  it('resolves aliases to grammar ids', () => {
    expect(resolveHighlightLanguage('py')).toBe('python')
    expect(resolveHighlightLanguage('PY')).toBe('python')
    expect(resolveHighlightLanguage('sh')).toBe('shellscript')
    expect(resolveHighlightLanguage('ts')).toBe('typescript')
    expect(resolveHighlightLanguage('rust')).toBe('rust')
  })

  it('maps unknown and plain-text languages to text', () => {
    expect(resolveHighlightLanguage('definitely-not-a-language')).toBe('text')
    expect(resolveHighlightLanguage('toString')).toBe('text')
    expect(resolveHighlightLanguage('')).toBe('text')
    expect(resolveHighlightLanguage('plaintext')).toBe('text')
    expect(codeHighlighter.supportsLanguage('py' as never)).toBe(true)
    expect(codeHighlighter.supportsLanguage('definitely-not-a-language' as never)).toBe(false)
  })

  it('highlights a language that was never on the old allowlist', async () => {
    const result = await highlight('fn main() {\n    let x = 1;\n}', 'rust')
    expect(flat(result)).toBe('fn main() {\n    let x = 1;\n}')
    expect(styles(result).size).toBeGreaterThan(1)
  })

  it('highlights through an alias', async () => {
    const viaAlias = await highlight('def f():\n    return 1', 'py')
    const direct = await highlight('def f():\n    return 1', 'python')
    expect(viaAlias.tokens).toEqual(direct.tokens)
    expect(styles(viaAlias).size).toBeGreaterThan(1)
  })

  it('renders unknown languages as unstyled text', async () => {
    const result = await highlight('just some words', 'definitely-not-a-language')
    expect(flat(result)).toBe('just some words')
    expect(styles(result).size).toBe(1)
  })

  it('serves repeat requests from the cache synchronously', async () => {
    const code = 'select 1 from dual'
    await highlight(code, 'sql')
    const again = codeHighlighter.highlight({ code, language: 'sql' as never, themes })
    expect(again).not.toBeNull()
    expect(flat(again!)).toBe(code)
  })

  it('falls back to plain tokens when the theme is not loaded', async () => {
    const result = await new Promise<NonNullable<ReturnType<typeof codeHighlighter.highlight>>>(
      (resolve) => {
        codeHighlighter.highlight(
          { code: 'a = 1', language: 'python' as never, themes: ['nord', 'nord'] as never },
          resolve,
        )
      },
    )
    expect(flat(result)).toBe('a = 1')
  })
})

describe('chat Markdown fence languages', () => {
  const render = (content: string) => renderToStaticMarkup(createElement(Markdown, { content }))

  it('keeps the fence language and drops the rest of the info string', () => {
    const markup = render('```python title="x.py"\nprint(1)\n```')
    expect(markup).toContain('data-language="python"')
  })

  it('keeps languages outside the old allowlist', () => {
    expect(render('```rust\nfn main() {}\n```')).toContain('data-language="rust"')
    expect(render('```c++\nint x;\n```')).toContain('data-language="c++"')
  })

  it('treats an unusable info string as no language', () => {
    expect(render('```{.foo}\nx\n```')).not.toContain('data-language="{.foo}"')
  })
})
