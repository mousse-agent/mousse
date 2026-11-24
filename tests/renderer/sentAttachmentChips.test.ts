// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'
import { formatChatReferences } from '../../src/shared/chatReferences'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('a sent prompt shows each attachment named in its text as a chip at that place, which opens it', () => {
  const settings = { id: 'r1', kind: 'file' as const, title: 'SettingsPanel.tsx', path: '/work/app/src/settings/SettingsPanel.tsx' }
  const content = [
    'make the header in [file: SettingsPanel.tsx] match [image 1: login-screen.png], see [file: notes.txt] and [file: elsewhere.txt]',
    '[Attached files: notes.txt (/tmp/mousse-attachments/t/notes.txt)]',
    formatChatReferences([settings])
  ].join('\n\n')
  const [message] = mousseToUIMessages([{
    id: 'u1', role: 'user', content, timestamp: new Date().toISOString(),
    images: [{ name: 'login-screen.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
  } as never])
  act(() => root.render(createElement(UserMessage, { message: message! })))

  const prompt = host.querySelector('.chat-user-text')!
  const read = [...prompt.querySelectorAll('.sent-attachment-chip')].map((chip) => chip.textContent)
  expect(read).toEqual(['SettingsPanel.tsx', 'login-screen.png', 'notes.txt'])
  // A name that is not an attachment of the message stays as the text the agent got.
  expect(prompt.textContent).toContain('[file: elsewhere.txt]')
  expect(prompt.textContent).toMatch(/^make the header in SettingsPanel\.tsx match login-screen\.png, see notes\.txt and/)

  const opened = vi.fn()
  window.addEventListener('mousse:open-file', (event) => opened((event as CustomEvent).detail))
  act(() => (prompt.querySelectorAll('.sent-attachment-chip')[2] as HTMLElement).click())
  expect(opened).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/mousse-attachments/t/notes.txt' }))
})
