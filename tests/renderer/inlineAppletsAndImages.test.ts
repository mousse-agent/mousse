// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppletCard } from '../../src/renderer/components/applets/AppletCard'
import { DocumentPanel } from '../../src/renderer/components/DocumentPanel'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { FileAttachment } from '../../src/renderer/chat/components/agent-elements/input/file-attachment'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { AppletReference } from '../../src/shared/applets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reference: AppletReference = {
  appletId: 'applet-1',
  revisionId: 'rev-1',
  sourceHash: 'hash-1',
  title: 'Image test',
  description: 'A landscape'
}

let root: Root
let host: HTMLElement
const initialStore = useAppStore.getState()

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  ;(window as unknown as { mousse: unknown }).mousse = {
    applets: {
      // The native guest never mounts here: these tests cover the DOM around it.
      mount: vi.fn(() => new Promise(() => {})),
      unmount: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      appearance: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({})),
      suspend: vi.fn(async () => {}),
      onEvent: vi.fn(() => () => {}),
      get: vi.fn(async () => ({ source: { html: '<p>hi</p>', css: '', js: '' } })),
      export: vi.fn(async () => {})
    }
  }
  useAppStore.setState({ activeThreadId: 'thread-1', profileId: 'profile-1', documentTabs: [], activeDocumentTabId: null, documentsTabVisible: false, mainAreaOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialStore, true)
  vi.unstubAllGlobals()
})

const render = (element: Parameters<Root['render']>[0]) => act(() => root.render(element))
const lightbox = () => document.querySelector('[role="dialog"]')
const press = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('inline applets', () => {
  it('show only the content under a small name, with no card, toolbar or footer', () => {
    render(createElement(AppletCard, { reference }))
    const applet = host.querySelector('.mousse-applet')!
    expect(applet.querySelector('header, footer, .mousse-applet-header, .mousse-applet-actions')).toBeNull()
    expect(applet.textContent).not.toContain('Offline applet')
    const buttons = [...applet.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Image test'])
    expect(applet.querySelector('.mousse-applet-preview')).not.toBeNull()
  })

  it('open in the side panel from their name, where the toolbar lives', async () => {
    render(createElement(AppletCard, { reference }))
    const name = host.querySelector<HTMLButtonElement>('button.mousse-applet-name')!
    expect(name.disabled).toBe(false)
    act(() => name.click())
    const state = useAppStore.getState()
    expect(state.mainView).toBe('documents')
    expect(state.mainAreaOpen).toBe(true)
    expect(state.documentTabs).toHaveLength(1)
    expect(state.documentTabs[0]).toMatchObject({ title: 'Image test', applet: { threadId: 'thread-1', reference } })
    expect(state.activeDocumentTabId).toBe(state.documentTabs[0].id)

    // A second click reuses the tab.
    act(() => name.click())
    expect(useAppStore.getState().documentTabs).toHaveLength(1)

    act(() => root.unmount())
    root = createRoot(host)
    render(createElement(DocumentPanel))
    const labels = [...host.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual(expect.arrayContaining(['Restart', 'Source', 'Export HTML', 'Export source', 'Export PNG']))
    expect(host.querySelector('[title="Offline applet · interactions stay on this device"]')).not.toBeNull()
    expect(host.querySelector('.mousse-applet-stage .mousse-applet-preview')).not.toBeNull()
  })

  it('do not open the image lightbox when clicked', () => {
    render(createElement(AppletCard, { reference }))
    act(() => (host.querySelector('.mousse-applet-preview') as HTMLElement).click())
    act(() => (host.querySelector('.mousse-applet') as HTMLElement).click())
    expect(lightbox()).toBeNull()
  })
})

describe('images in messages', () => {
  it('open large from a reply image and close with Esc', async () => {
    await act(async () => root.render(createElement(Markdown, { content: 'Here:\n\n![Chart](https://example.com/chart.png)\n' })))
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open image: Chart"]')
    expect(open).not.toBeNull()
    // A native button: Enter on the focused image activates it like a click.
    expect(open!.tagName).toBe('BUTTON')
    open!.focus()
    act(() => open!.click())
    const dialog = lightbox()
    expect(dialog).not.toBeNull()
    expect(dialog!.querySelector('img')!.getAttribute('src')).toBe('https://example.com/chart.png')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close fullscreen (Esc)')
    press('Escape')
    expect(lightbox()).toBeNull()
    expect(document.activeElement).toBe(open)
  })

  it('open large from an attached screenshot, closed by a click outside', () => {
    render(createElement(FileAttachment, { id: 'a', filename: 'Screenshot.png', isImage: true, url: 'data:image/png;base64,AAAA' }))
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open Screenshot.png"]')
    expect(open).not.toBeNull()
    act(() => open!.click())
    expect(lightbox()).not.toBeNull()
    act(() => (lightbox() as HTMLElement).click())
    expect(lightbox()).toBeNull()
  })
})
