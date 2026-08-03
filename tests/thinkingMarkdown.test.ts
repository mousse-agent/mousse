import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ChatMessageContent,
  INLINE_THINKING_WORD_LIMIT,
  shouldRenderThinkingInline,
  ThinkingMarkdown
} from '../src/renderer/components/ChatMessageContent'

describe('thinking presentation', () => {
  it('renders short thinking updates inline', () => {
    expect(shouldRenderThinkingInline('Inspecting IPC channel allowlist')).toBe(true)
    const markup = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: 'system',
        content: '',
        kind: 'thinking',
        thinking: { content: 'Inspecting IPC channel allowlist', status: 'complete' }
      })
    )

    expect(markup).toContain('Inspecting IPC channel allowlist')
    expect(markup).not.toContain('>Thinking</span>')
  })

  it('keeps longer thinking content behind the Thinking disclosure', () => {
    const content = Array.from(
      { length: INLINE_THINKING_WORD_LIMIT + 1 },
      (_, index) => `word${index}`
    ).join(' ')
    expect(shouldRenderThinkingInline(content)).toBe(false)
    const markup = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: 'system',
        content: '',
        kind: 'thinking',
        thinking: { content, status: 'complete' }
      })
    )

    expect(markup).toContain('>Thinking</span>')
  })
})

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
