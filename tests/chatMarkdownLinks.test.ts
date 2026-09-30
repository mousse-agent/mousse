import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/chat/components/agent-elements/markdown'

describe('live chat Markdown links', () => {
  it('does not render unsafe link protocols as navigable links', () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, { content: '[unsafe](javascript:alert(1))' })
    )

    expect(markup).not.toMatch(/href="javascript:/i)
    expect(markup).not.toMatch(/<a[^>]+javascript:/i)
  })

  it('keeps ordinary https links external and non-opener', () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, { content: '[Documentation](https://example.com)' })
    )

    expect(markup).toContain('href="https://example.com')
    expect(markup).toContain('rel="noopener noreferrer"')
  })
})
