import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { UserMessage } from '../src/renderer/chat/components/agent-elements/user-message'

const message = {
  id: 'u1',
  role: 'user',
  parts: [
    { type: 'text', text: 'What is wrong here?' },
    { type: 'file', mediaType: 'image/png', filename: 'error.png', url: 'data:image/png;base64,AAAA' },
    { type: 'image', url: 'data:image/png;base64,BBBB' }
  ]
} as unknown as UIMessage

it('makes each attached image a named button', () => {
  const html = renderToStaticMarkup(createElement(UserMessage, { message }))
  expect(html).not.toContain('alt="attachment"')
  expect(html).toMatch(/<button type="button" class="chat-user-image [^"]*" aria-label="Open error.png" title="error.png">/)
  expect(html).toContain('alt="error.png"')
  expect(html).toMatch(/<button type="button" class="chat-user-image [^"]*" aria-label="Open image 2">/)
  expect(html).toContain('alt="Image 2"')
})

it('keeps plain tiles when images do not open a preview', () => {
  const html = renderToStaticMarkup(createElement(UserMessage, { message, enableImagePreview: false }))
  expect(html).not.toContain('<button')
  expect(html).toContain('alt="error.png"')
})
