import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThinkingMarkdown } from '../src/renderer/components/ChatMessageContent'

describe('ThinkingMarkdown', () => {
  it('renders rich Markdown using the chat theme conventions', () => {
    const markup = renderToStaticMarkup(
      createElement(ThinkingMarkdown, {
        content:
          '**important** with `inline()`\n\n- first\n- second\n\n[Documentation](https://example.com)\n\n```ts\nconst answer = 42\n```'
      })
    )

    expect(markup).toContain('<strong>important</strong>')
    expect(markup).toContain('<code>inline()</code>')
    expect(markup).toContain('<ul>')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('<pre><code class="hljs language-ts">')
  })

  it('does not render unsafe link protocols', () => {
    const markup = renderToStaticMarkup(
      createElement(ThinkingMarkdown, { content: '[unsafe](javascript:alert(1))' })
    )

    expect(markup).not.toContain('javascript:')
  })
})
