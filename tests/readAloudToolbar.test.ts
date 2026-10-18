import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'

const render = (showCopyToolbar: boolean) =>
  renderToStaticMarkup(
    createElement(MessageList, {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Please explain the build.' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The build bundles the renderer.' }] }
      ],
      status: 'ready',
      showCopyToolbar
    })
  )

it('renders the read aloud button immediately before the copy button under each message', () => {
  const html = render(true)
  const buttons = [...html.matchAll(/aria-label="Read aloud"/g)]
  expect(buttons).toHaveLength(2)

  for (const match of buttons) {
    const start = html.lastIndexOf('<button', match.index)
    const end = html.indexOf('</button>', match.index) + '</button>'.length
    const readAloud = html.slice(start, end)
    expect(readAloud).toContain('title="Read aloud"')
    expect(readAloud).toContain('tabindex="-1"')
    expect(readAloud).toContain('data-read-aloud="idle"')
    // The next element in the toolbar row is the copy button.
    const next = html.slice(end)
    expect(next.startsWith('<button type="button" tabindex="-1"')).toBe(true)
    expect(next.slice(0, next.indexOf('</button>'))).not.toContain('aria-label')
  }
})

it('omits the read aloud button when the copy toolbar is hidden', () => {
  expect(render(false)).not.toContain('Read aloud')
})
