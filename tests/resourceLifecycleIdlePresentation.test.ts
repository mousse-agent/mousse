import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'

it.each(['ready', 'error', 'submitted', 'streaming'] as const)('renders a retained final user message honestly when the task is %s', (status) => {
  const html = renderToStaticMarkup(createElement(MessageList, {
    messages: [{ id: 'retained-user', role: 'user', parts: [{ type: 'text', text: 'Retained request after restore or interruption' }] }],
    status
  }))
  expect(html).toContain('Retained request after restore or interruption')
  // The live turn status replaced the old "Processing..." shimmer row.
  expect(html.includes('Working for')).toBe(status === 'submitted' || status === 'streaming')
})
