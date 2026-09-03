import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/chat/components/agent-elements/markdown'

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

  it('renders inline code compactly without the roomy default pill', () => {
    const markup = render('- item with (`abc123`) code')

    expect(markup).toContain('an-md-code')
    expect(markup).not.toContain('px-1.5')
    // Code hugs the parens — no rendered whitespace beyond the source's.
    expect(markup).toContain('(<code')
    expect(markup).toContain('</code>)')
  })
})
