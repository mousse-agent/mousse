// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The sections reach for the main process; this test is about the card around them.
vi.mock('../src/renderer/components/sideCard/DeviceSection', () => ({
  DeviceSection: () => createElement('button', { type: 'button', 'data-testid': 'first-control' }, 'Device')
}))
vi.mock('../src/renderer/components/sideCard/GitSection', () => ({ GitSection: () => null }))
vi.mock('../src/renderer/components/sideCard/ActionsSection', () => ({ ActionsSection: () => null }))
vi.mock('../src/renderer/components/sideCard/LineageSection', () => ({ LineageSection: () => null }))

import { ThreadSideCard } from '../src/renderer/components/sideCard/ThreadSideCard'
import { useAppStore } from '../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PANE_WIDTH = 900

let host: HTMLElement
let root: Root
let opener: HTMLButtonElement

/** A workspace the card can measure: jsdom has no layout, so the width is stubbed. */
function mount(width: number) {
  host = document.createElement('div')
  host.className = 'app-workspace'
  host.getBoundingClientRect = () => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  const pane = document.createElement('aside')
  pane.className = 'sidebar sidebar-full'
  host.append(pane)
  document.body.append(host)
  root = createRoot(pane)
  act(() => root.render(createElement(ThreadSideCard)))
}

const flushFrames = async (count = 6) => {
  for (let i = 0; i < count; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
}

const card = () => document.querySelector<HTMLElement>('.thread-side-card')
const layer = () => document.querySelector<HTMLElement>('.thread-side-card-layer')
const pane = () => host.querySelector<HTMLElement>('.sidebar')!
const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useAppStore.setState({
    sideCardOn: true,
    sideCardFits: null,
    sideCardOverlayOpen: false,
    mainAreaOpen: false,
    settingsOpen: false,
    sidebarMode: 'projects',
    threadsSidebarOpen: false,
    activeThreadId: 'thread-1'
  })
  opener = document.createElement('button')
  opener.textContent = 'Thread details'
  document.body.append(opener)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  opener.remove()
  vi.unstubAllGlobals()
})

describe('thread side card overlay', () => {
  it('opens nothing at launch in a narrow window, with the switch on', async () => {
    mount(PANE_WIDTH)
    await flushFrames()
    expect(useAppStore.getState().sideCardFits).toBe(false)
    expect(useAppStore.getState().sideCardOn).toBe(true)
    expect(card()).toBeNull()
    expect(layer()?.className).toContain('thread-side-card-layer--overlay')
  })

  it('reserves no room on the pane while it is open', async () => {
    mount(PANE_WIDTH)
    await flushFrames()
    opener.focus()
    act(() => useAppStore.getState().setSideCardOverlayOpen(true))
    await flushFrames()
    expect(card()?.getAttribute('data-shown')).toBe('true')
    expect(pane().style.getPropertyValue('--side-card-reserved')).toBe('0px')
  })

  it('moves focus into the card, and Escape closes it and returns focus to the opener', async () => {
    mount(PANE_WIDTH)
    await flushFrames()
    opener.focus()
    act(() => useAppStore.getState().setSideCardOverlayOpen(true))
    await flushFrames()
    expect(card()?.contains(document.activeElement)).toBe(true)

    escape()
    expect(useAppStore.getState().sideCardOverlayOpen).toBe(false)
    await flushFrames(2)
    expect(document.activeElement).toBe(opener)
    await flushFrames(14)
    expect(card()).toBeNull()
    expect(useAppStore.getState().sideCardOn).toBe(true)
  })

  it('closes when the scrim is clicked', async () => {
    mount(PANE_WIDTH)
    await flushFrames()
    act(() => useAppStore.getState().setSideCardOverlayOpen(true))
    await flushFrames()
    const scrim = document.querySelector<HTMLElement>('.thread-side-card-scrim')
    expect(scrim).not.toBeNull()
    act(() => scrim!.click())
    expect(useAppStore.getState().sideCardOverlayOpen).toBe(false)
  })

  it('closes on a thread change', async () => {
    mount(PANE_WIDTH)
    await flushFrames()
    act(() => useAppStore.getState().setSideCardOverlayOpen(true))
    await flushFrames()
    act(() => useAppStore.getState().setActiveThreadId('thread-2'))
    expect(useAppStore.getState().sideCardOverlayOpen).toBe(false)
  })
})

describe('thread side card when docked', () => {
  it('shows at launch in a wide window and reserves room only as far as the column needs it', async () => {
    mount(1100)
    await flushFrames()
    expect(useAppStore.getState().sideCardFits).toBe(true)
    expect(card()?.getAttribute('data-shown')).toBe('true')
    expect(card()?.getAttribute('role')).toBeNull()
    expect(document.querySelector('.thread-side-card-scrim')).toBeNull()
    expect(pane().style.getPropertyValue('--side-card-reserved')).toBe('172px')
  })

  it('reserves nothing in a window with room to spare', async () => {
    mount(1500)
    await flushFrames()
    expect(card()?.getAttribute('data-shown')).toBe('true')
    expect(pane().style.getPropertyValue('--side-card-reserved')).toBe('0px')
  })

  it('does not trap Escape: the card is part of the page', async () => {
    mount(1100)
    await flushFrames()
    escape()
    expect(useAppStore.getState().sideCardOn).toBe(true)
    expect(card()?.getAttribute('data-shown')).toBe('true')
  })
})
