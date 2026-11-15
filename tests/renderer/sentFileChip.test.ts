// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'

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

function show(content: string): void {
  const [message] = mousseToUIMessages([{ id: 'u1', role: 'user', content, timestamp: new Date().toISOString() }])
  act(() => root.render(createElement(UserMessage, { message: message! })))
}

describe('a file sent with a message, in the transcript', () => {
  it('shows its name, not its path, and opens the file where it was sent from', () => {
    const path = 'C:\\My Videos (old)\\clip, final.mp4'
    show(`cut the intro\n\n[Attached files: clip, final.mp4 (${path})]`)
    expect(host.textContent).toContain('clip, final.mp4')
    expect(host.textContent).not.toContain('My Videos')

    const opened = vi.fn()
    window.addEventListener('mousse:open-file', (event) => opened((event as CustomEvent).detail))
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Open clip, final.mp4"]')!.click())
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ path }))
  })

  it('shows a file named in an older message, without a path, as a chip that opens nothing', () => {
    show('review\n\n[Attached files: notes.md]')
    expect(host.textContent).toContain('notes.md')
    expect(host.querySelector('button[aria-label="Open notes.md"]')).toBeNull()
  })
})
