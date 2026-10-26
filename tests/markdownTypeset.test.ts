import { describe, expect, it } from 'vitest'
import { renderMath } from '../src/renderer/markdown/math/math-katex'
import { blockSource, inlineSource, readMathClass } from '../src/renderer/markdown/math/math-markup'

describe('math typesetting', () => {
  it('renders valid TeX with visual and MathML output', () => {
    const html = renderMath('x^2 + \\frac{1}{2}', false)
    expect(html).toContain('class="katex"')
    expect(html).toContain('<math')
    expect(html).not.toContain('katex-display')
  })

  it('renders display math in display mode', () => {
    expect(renderMath('\\sum_{i=1}^n i', true)).toContain('katex-display')
  })

  it('returns null for TeX KaTeX rejects, so the source is shown instead', () => {
    expect(renderMath('\\frac{', false)).toBeNull()
    expect(renderMath('\\undefinedmacro{x}', false)).toBeNull()
    expect(renderMath('x^', true)).toBeNull()
  })

  it('never produces a link, whether or not the command is accepted', () => {
    for (const tex of ['\\href{javascript:alert(1)}{x}', '\\url{https://example.com}', '\\includegraphics{x.png}']) {
      const html = renderMath(tex, false)
      expect(html === null || !/<a[\s>]|href=|<img/.test(html), tex).toBe(true)
    }
  })

  it('clamps sizes to maxSize', () => {
    const html = renderMath('\\rule{999em}{1em}', false)
    expect(html).toContain('border-right-width:20em')
    expect(html).not.toMatch(/width[:=]"?999/)
  })

  it('stops a macro that expands without end', () => {
    expect(renderMath('\\def\\a{\\a\\a}\\a', false)).toBeNull()
    expect(renderMath('\\def\\a{\\a\\a}\\a', true)).toBeNull()
  })

  it('stops a macro that fans out past the expansion limit', () => {
    const tex = '\\def\\a{xxxxxxxxxx}\\def\\b{\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a}\\def\\c{\\b\\b\\b\\b\\b\\b\\b\\b\\b\\b}\\c\\c\\c\\c\\c\\c\\c\\c\\c\\c'
    expect(renderMath(tex, false)).toBeNull()
  })

  it('refuses oversized input without parsing it', () => {
    expect(renderMath('x'.repeat(20_001), false)).toBeNull()
  })

  it('returns the same result for the same input', () => {
    expect(renderMath('a+b', false)).toBe(renderMath('a+b', false))
    expect(renderMath('\\frac{', false)).toBeNull()
    expect(renderMath('\\frac{', false)).toBeNull()
  })
})

describe('math source fallback', () => {
  it('writes inline math back with the delimiters the author used', () => {
    expect(inlineSource('x', 'dollar')).toBe('$x$')
    expect(inlineSource('x', 'dollars')).toBe('$$x$$')
    expect(inlineSource('x', 'paren')).toBe('\\(x\\)')
    expect(inlineSource('x', 'bracket')).toBe('\\[x\\]')
  })

  it('writes blocks back as $$, \\[ or a math fence', () => {
    expect(blockSource('x', 'dollars')).toBe('$$\nx\n$$')
    expect(blockSource('x', 'bracket')).toBe('\\[\nx\n\\]')
    expect(blockSource('x', undefined)).toBe('```math\nx\n```')
  })

  it('reads the classes remarkMousseMath writes', () => {
    expect(readMathClass('language-math math-inline language-math-delim-paren')).toEqual({
      display: false,
      delimiter: 'paren'
    })
    expect(
      readMathClass('language-math math-display language-math-display language-math-delim-bracket')
    ).toEqual({ display: true, delimiter: 'bracket' })
    expect(readMathClass('language-ts')).toBeNull()
    expect(readMathClass(undefined)).toBeNull()
  })
})
