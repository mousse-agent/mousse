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
    expect(readAloud).toContain('data-read-aloud="idle"')
    // The next element in the toolbar row is the copy button.
    const next = html.slice(end)
    expect(next.startsWith('<button type="button" title="Copy" aria-label="Copy"')).toBe(true)
  }
})

it('lets the keyboard reach and see every message action, and announces a copy', () => {
  const html = render(true)
  // No action under a message is skipped by Tab.
  expect(html).not.toContain('tabindex="-1"')
  // Focus inside the toolbar shows it the way hover does.
  const toolbars = [...html.matchAll(/class="chat-message-toolbar [^"]*"/g)].map((m) => m[0])
  expect(toolbars).toHaveLength(2)
  for (const toolbar of toolbars) {
    expect(toolbar).toContain('focus-within:opacity-100')
    expect(toolbar).toContain('focus-within:pointer-events-auto')
  }
  // One polite status region per Copy button; it says "Copied" after a copy.
  expect(html.match(/<span class="sr-only" role="status" aria-live="polite"><\/span>/g)).toHaveLength(2)
})

it('omits the read aloud button when the copy toolbar is hidden', () => {
  expect(render(false)).not.toContain('Read aloud')
})
