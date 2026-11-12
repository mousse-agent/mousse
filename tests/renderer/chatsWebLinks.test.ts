// @vitest-environment jsdom
/**
 * A web link in a chat message. In a thread it opens a tab in the Browser panel. In Chats (a bot's chat) the Browser
 * panel would swap the chat for the Projects workspace and the bot's thread composer, so it opens in the person's own
 * browser and the bot's chat stays on screen.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '../../src/renderer/components/editors/MarkdownPreview'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initial = useAppStore.getInitialState()
let root: Root
let host: HTMLElement
let open: ReturnType<typeof vi.fn>

beforeEach(() => {
  open = vi.fn(() => null)
  vi.stubGlobal('open', open)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  useAppStore.setState(initial)
})

async function clickLink() {
  await act(async () => root.render(createElement(MarkdownPreview, { value: 'See [the page](https://example.com/a).' })))
  const link = host.querySelector('a')!
  await act(async () => { link.click() })
}

describe('a web link in a message', () => {
  it('in a bot chat opens in the browser and leaves the chat on screen', async () => {
    useAppStore.setState({ sidebarMode: 'chats', mainView: 'files', mainAreaOpen: false, activeThreadId: 'thread_a', browserTabs: [] })
    await clickLink()
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
    expect(useAppStore.getState()).toMatchObject({ sidebarMode: 'chats', mainView: 'files', mainAreaOpen: false, browserTabs: [] })
  })

  it('in a thread opens a Browser panel tab, as before', async () => {
    useAppStore.setState({ sidebarMode: 'projects', mainView: 'files', mainAreaOpen: false, activeThreadId: 'thread_a', browserTabs: [] })
    await clickLink()
    expect(open).not.toHaveBeenCalled()
    const state = useAppStore.getState()
    expect(state).toMatchObject({ sidebarMode: 'projects', mainView: 'browser', mainAreaOpen: true })
    expect(state.browserTabs.map((tab) => tab.url)).toEqual(['https://example.com/a'])
  })
})
