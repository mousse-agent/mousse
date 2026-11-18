// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BLACKSPHERE_TOKEN_COLORS, clearTokenColors, injectTokenColors, type VsCodeTokenColor } from '../../src/shared/vscodeTheme'

/** A highlighted code block as Markdown renders it, with one token of each kind asked for. */
function token(kind: string): CSSStyleDeclaration {
  const span = document.createElement('span')
  span.className = kind
  document.body.append(span)
  return getComputedStyle(span)
}

afterEach(() => {
  clearTokenColors()
  document.body.replaceChildren()
})

describe('code block colours from the theme', () => {
  it('give keywords, strings and comments their own colours, with only comments italic, in the bundled theme', () => {
    injectTokenColors(BLACKSPHERE_TOKEN_COLORS)
    const keyword = token('hljs-keyword')
    const string = token('hljs-string')
    const comment = token('hljs-comment')
    expect(keyword.fontStyle).toBe('normal')
    expect(string.fontStyle).toBe('normal')
    expect(comment.fontStyle).toBe('italic')
    expect(new Set([keyword.color, string.color, comment.color]).size).toBe(3)
  })

  const theme = (...rules: VsCodeTokenColor[]) => rules
  it.each([
    ['a later rule for another scope does not reach keywords',
      theme({ scope: 'keyword', settings: { foreground: '#ff0000' } }, { scope: 'markup.italic.markdown', settings: { foreground: '#00ff00', fontStyle: 'italic' } }),
      'rgb(255, 0, 0)', 'normal'],
    ['the more specific scope wins, whatever its order',
      theme({ scope: 'keyword.control', settings: { foreground: '#0000ff' } }, { scope: 'keyword', settings: { foreground: '#ff0000' } }),
      'rgb(0, 0, 255)', 'normal'],
    ['a rule that only adds a style keeps the colour from a broader rule',
      theme({ scope: ['keyword'], settings: { foreground: '#ff0000' } }, { scope: 'keyword.control', settings: { fontStyle: 'italic' } }),
      'rgb(255, 0, 0)', 'italic'],
    ['a scope list written as one comma-separated string matches each entry',
      theme({ scope: 'storage, keyword', settings: { foreground: '#ff0000' } }),
      'rgb(255, 0, 0)', 'normal'],
    ['a descendant scope does not colour every keyword',
      theme({ scope: 'meta.embedded keyword', settings: { foreground: '#00ff00' } }),
      'rgb(0, 0, 0)', 'normal']
  ])('%s', (_name, rules, color, fontStyle) => {
    injectTokenColors(rules)
    const keyword = token('hljs-keyword')
    expect(keyword.color).toBe(color)
    expect(keyword.fontStyle || 'normal').toBe(fontStyle)
  })
})
