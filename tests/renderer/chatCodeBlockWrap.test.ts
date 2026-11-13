// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { addCodeWrapToggles } from '../../src/renderer/chat/components/agent-elements/code-block-wrap'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'

function mount(markup: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = markup
  document.body.replaceChildren(host)
  return host.firstElementChild as HTMLElement
}

describe('code block Wrap toggle', () => {
  it('adds one Wrap toggle before Copy, which switches the block between wrapped and scrolling', () => {
    const root = mount(renderToStaticMarkup(createElement(Markdown, { content: '```ts\nconst a = 1\n```\n' })))
    addCodeWrapToggles(root)
    addCodeWrapToggles(root)
    const block = root.querySelector<HTMLElement>('[data-streamdown="code-block"]')!
    const toggles = root.querySelectorAll<HTMLButtonElement>('.an-code-wrap')
    expect(toggles).toHaveLength(1)
    const toggle = toggles[0]!
    expect(toggle.nextElementSibling?.getAttribute('aria-label')).toBe('Copy Code')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    expect(block.dataset.wrap).toBe('off')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    expect(block.dataset.wrap).toBe('on')
  })

  it('leaves command previews and tool output without a toggle', () => {
    const root = mount(renderToStaticMarkup(createElement(Markdown, { content: '```bash\nls\n```\n', className: 'an-tool-quiet-output' })))
    addCodeWrapToggles(root)
    expect(root.querySelector('.an-code-wrap')).toBeNull()
  })
})

describe('finished and streaming replies', () => {
  it('reads a finished reply as written: an unclosed backtick stays a backtick', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { content: 'Press the ` key.' }))
    expect(markup).not.toContain('<code')
    expect(markup).toContain('Press the ` key.')
  })

  it('closes a code span still being written while the reply streams', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { content: 'Run `npm te', streaming: true }))
    expect(markup).toMatch(/<code[^>]*>npm te<\/code>/)
  })

  it('caps a tall code block at 640px', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join('\n')
    const markup = renderToStaticMarkup(createElement(Markdown, { content: `\`\`\`ts\n${lines}\n\`\`\`\n` }))
    expect(markup).toMatch(/data-streamdown="code-block-body"[^>]*style="max-height:640px"/)
  })

  it('numbers a list item that holds a code block on the same line as its text', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { content: '1. Install the tool:\n\n   ```bash\n   npm i\n   ```\n\n2. Then check.' }))
    // No line break before the item's first paragraph, so the number sits beside it.
    expect(markup).toMatch(/<li[^>]*><p[^>]*>Install the tool:/)
  })
})
