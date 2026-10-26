import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/chat/components/agent-elements/markdown'
import { MarkdownPreview } from '../src/renderer/components/editors/MarkdownPreview'
import { setRenderMath } from '../src/renderer/markdown/math/renderMathSetting'

function render(content: string): string {
  return renderToStaticMarkup(createElement(Markdown, { content }))
}

describe('chat Markdown list rendering', () => {
  it('keeps nested lists attached inside their parent item', () => {
    const content = [
      'Both are old:',
      '',
      '- **agent worktree** (`edd06374...`)',
      '',
      '  - Branch created: **Aug 27, 22:25:11 +0530**',
      '',
      '  - Folder born: Aug 27, 22:25:21 2026',
      '',
      '  - Last commit: `469e782 - Make native rebuild script cross-platform`',
      '',
      '- **thread worktree** (`430a2fa7.../main`)',
      '',
      '  - Branch created: **today, Sep 3, 16:01:51 +0530**',
      '',
      "  - It's just pinned at same commit as your `master` (`30dda4e`)",
      '',
    ].join('\n')
    const markup = render(content)

    // Tight items: no paragraph wrappers anywhere in the list.
    expect(markup).not.toMatch(/<li[^>]*>\s*<p>/)
    // The nested <ul> must be a direct child of the parent <li> — the
    // compact nested-list CSS (`li > .an-md-ul`) depends on this shape.
    expect(markup).toMatch(/agent worktree[\s\S]*<ul[^>]*>[\s\S]*Branch created/)
    expect(markup).toContain('Last commit:')
    expect(markup).toContain('30dda4e')
  })

  it('resets white-space on nested lists so inter-item whitespace collapses', () => {
    // Regression guard for the 21px phantom-line bug: global.css gives
    // `.an-md-li` white-space: pre-line, which a nested <ul> would inherit
    // — turning whitespace text nodes between <li>s into hard line breaks.
    // No layout engine in node tests, so assert the cascade directly: a
    // normal rule targeted at the nested list must exist (direct rules
    // beat inheritance, no !important required).
    const css = readFileSync(
      new URL(
        '../src/renderer/chat/components/agent-elements/agent-ui.css',
        import.meta.url,
      ),
      'utf8',
    )
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    const nestedRules = blocks.filter(([, selector]) =>
      selector.includes('.an-md-li > .an-md-ul'),
    )
    expect(nestedRules.length).toBeGreaterThan(0)
    expect(
      nestedRules.some(([, , body]) => /white-space\s*:\s*normal/.test(body)),
    ).toBe(true)
  })

  it('preserves canonical file targets through Streamdown sanitization', () => {
    const target = 'mousse-file://open?path=C%3A%5Crepo%5Csrc%5Ca.ts&line=12&column=3'
    const markup = render(`[Open source](${target})`)
    expect(markup).toContain('href="mousse-file://open?path=C%3A%5Crepo%5Csrc%5Ca.ts&amp;line=12&amp;column=3"')
    expect(markup).toContain('Open source')
  })

  it('removes executable source targets', () => {
    const markup = render('[unsafe](javascript:alert(1))')
    expect(markup).not.toContain('javascript:')
  })

  it('keeps ordinary https links external and non-opener', () => {
    const markup = render('[Documentation](https://example.com)')
    expect(markup).toContain('href="https://example.com')
    expect(markup).toContain('rel="noopener noreferrer"')
  })

  it('renders inline code compactly without the roomy default pill', () => {
    const markup = render('- item with (`abc123`) code')

    expect(markup).toContain('an-md-code')
    expect(markup).not.toContain('px-1.5')
    // Code hugs the parens — no rendered whitespace beyond the source's.
    expect(markup).toContain('(<code')
    expect(markup).toContain('</code>)')
  })
})

describe('chat Markdown GitHub alerts', () => {
  it('renders each alert kind as a labeled callout without the marker', () => {
    for (const [marker, title] of [['NOTE', 'Note'], ['TIP', 'Tip'], ['IMPORTANT', 'Important'], ['WARNING', 'Warning'], ['CAUTION', 'Caution']]) {
      const markup = render(`> [!${marker}]\n> Back up the database first.`)
      expect(markup).toContain(`an-md-alert-${marker.toLowerCase()}`)
      expect(markup).toContain(`>${title}</p>`)
      expect(markup).toContain('Back up the database first.')
      expect(markup).not.toContain(`[!${marker}]`)
      expect(markup).not.toContain('<blockquote')
    }
  })

  it('keeps later paragraphs inside the callout', () => {
    const markup = render('> [!TIP]\n>\n> First.\n>\n> Second.')
    expect(markup).toContain('an-md-alert-tip')
    expect(markup).toMatch(/First\.[\s\S]*Second\./)
  })

  it('accepts lowercase markers', () => {
    expect(render('> [!note]\n> Body')).toContain('an-md-alert-note')
  })

  it('keeps a quote when the marker shares its line with text', () => {
    const markup = render('> [!NOTE] inline text')
    expect(markup).toContain('<blockquote')
    expect(markup).not.toContain('an-md-alert')
  })

  it('keeps ordinary blockquotes and unknown markers', () => {
    for (const content of ['> Just a quote', '> [!DANGER]\n> Body']) {
      const markup = render(content)
      expect(markup).toContain('<blockquote')
      expect(markup).not.toContain('an-md-alert')
    }
  })
})

describe('chat Markdown math', () => {
  afterEach(() => setRenderMath(true))

  // KaTeX loads on first use: the first render shows the source, a render after
  // the chunk has arrived shows typeset math.
  async function renderTypeset(content: string): Promise<string> {
    render(content)
    await import('../src/renderer/markdown/math/math-typeset')
    await new Promise((resolve) => setTimeout(resolve, 0))
    return render(content)
  }

  it('typesets $, $$, \\( \\) and \\[ \\] math', async () => {
    const markup = await renderTypeset(
      [
        'Inline $a^2 + b^2 = c^2$ and \\(x_1\\) and $$y$$ and \\[z\\].',
        '',
        '$$',
        '\\int_0^1 x\\,dx',
        '$$',
        '',
        '\\[',
        'E = mc^2',
        '\\]',
      ].join('\n'),
    )
    expect(markup.match(/class="katex"/g)?.length).toBe(6)
    expect(markup.match(/class="katex-display"/g)?.length).toBe(4)
    expect(markup).toContain('data-math-tex="a^2 + b^2 = c^2"')
    expect(markup).toContain('data-math-tex="\\int_0^1 x\\,dx"')
    expect(markup).toContain('data-math-tex="E = mc^2"')
  })

  it('typesets ```math fences as display math', async () => {
    const markup = await renderTypeset('```math\n\\frac{1}{2}\n```')
    expect(markup).toContain('katex-display')
    expect(markup).not.toContain('<pre')
  })

  it('keeps a \\[ display with blank lines in it as one formula', async () => {
    const markup = await renderTypeset('\\[\nx\n\ny\n\\]\n\nafter')
    expect(markup.match(/class="katex-display"/g)?.length).toBe(1)
    expect(markup).toContain('after')
  })

  it('shows the source as written when a formula cannot be typeset', async () => {
    const markup = await renderTypeset('Bad $\\frac{$ and bad \\(x^\\) and\n\n\\[\n\\frac{\n\\]')
    expect(markup).not.toContain('class="katex"')
    expect(markup).toContain('$\\frac{$')
    expect(markup).toContain('\\(x^\\)')
    expect(markup).toContain('\\[\n\\frac{\n\\]')
  })

  it('shows an unfinished ```math fence as source until it closes', async () => {
    const markup = await renderTypeset('Before\n\n```math\n\\frac{1}{2}')
    expect(markup).not.toContain('katex')
    expect(markup).toContain('\\frac{1}{2}')
  })

  it('keeps prices, shell variables and code as text', async () => {
    const markup = await renderTypeset(
      'Plans cost $5 and $10 a month, set $HOME first, run `echo $x$` and `\\(y\\)`.',
    )
    expect(markup).not.toContain('katex')
    expect(markup).toContain('$5 and $10')
    expect(markup).toContain('set $HOME first')
    expect(markup).toContain('echo $x$')
  })

  it('leaves text without math delimiters on the plain path', () => {
    const markup = render('Just prose with `code`.')
    expect(markup).not.toContain('an-math')
    expect(markup).toContain('<code')
  })

  it('shows the source untouched when Render math is off', async () => {
    setRenderMath(false)
    const markup = await renderTypeset('Inline $x^2$ here\n\n$$\ny\n$$\n\n```math\nz\n```')
    expect(markup).not.toContain('katex')
    expect(markup).not.toContain('an-math')
    expect(markup).toContain('$x^2$')
    expect(markup).toContain('$$')
    expect(markup).toContain('language-text')
  })

  it('does not typeset raw HTML code tagged as math when Render math is off', () => {
    setRenderMath(false)
    const markup = render('<code class="language-math">x^2</code>')
    expect(markup).not.toContain('katex')
  })

  it('typesets math in the file preview and keeps the setting', async () => {
    const value = 'Inline $a^2$ and \\(b\\)\n\n$$\nc\n$$\n\n```math\nd\n```\n\nCosts $5 and $10.'
    const preview = () => renderToStaticMarkup(createElement(MarkdownPreview, { value }))
    preview()
    await import('../src/renderer/markdown/math/math-typeset')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const markup = preview()
    expect(markup.match(/class="katex"/g)?.length).toBe(4)
    expect(markup.match(/class="katex-display"/g)?.length).toBe(2)
    expect(markup).toContain('$5 and $10')
    setRenderMath(false)
    const off = preview()
    expect(off).not.toContain('katex')
    expect(off).toContain('$a^2$')
  })
})
