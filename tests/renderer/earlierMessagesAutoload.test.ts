// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EarlierMessagesBar } from '../../src/renderer/components/EarlierMessagesBar'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * A long thread's older messages load as the reader scrolls up to the top of the center pane's transcript, with no
 * bar asking for them. Inputs: a scroll up into the top screen, a scroll down, a wheel turned up at the very top
 * (where nothing scrolls, so no scroll event comes), a page that leaves the reader at the top, a side chat's
 * transcript outside the pane, and a page that fails.
 */

let root: Root
let host: HTMLDivElement
let list: HTMLDivElement
let loadEarlier: ReturnType<typeof vi.fn>

/** The pane as the chat lays it out: the loader beside the transcript, whose scroll position the test sets. */
function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement('div', { 'data-mousse': 'chat' }, createElement(EarlierMessagesBar), createElement('div', { className: 'an-message-list', id: 'list' }))))
  list = host.querySelector<HTMLDivElement>('#list')!
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 })
}

function scrollTo(target: HTMLElement, top: number): void {
  Object.defineProperty(target, 'scrollTop', { configurable: true, value: top })
  target.dispatchEvent(new Event('scroll'))
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

beforeEach(() => {
  loadEarlier = vi.fn(async () => ({ messages: [], earlier: undefined }))
  ;(window as unknown as { mousse: unknown }).mousse = { threads: { loadEarlier, messageImage: vi.fn() } }
  useAppStore.setState({ activeThreadId: 't1', messages: [], earlierByThread: { t1: { before: 'm40', count: 40 } } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('.an-message-list').forEach((element) => element.remove())
})

describe('older messages of a long thread', () => {
  it('shows no bar asking to load them', () => {
    mount()
    expect(host.textContent).not.toMatch(/earlier message/)
    expect(host.querySelector('button')).toBeNull()
  })

  it('load when the reader scrolls up into the top of the transcript, not when scrolling down', async () => {
    mount()
    scrollTo(list, 3000)
    scrollTo(list, 3200)
    expect(loadEarlier).not.toHaveBeenCalled()
    scrollTo(list, 400)
    await settle()
    expect(loadEarlier).toHaveBeenCalledWith('t1', 'm40')
  })

  it('load when the wheel turns up at the very top, where nothing scrolls', async () => {
    mount()
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 0 })
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
    expect(loadEarlier).not.toHaveBeenCalled()
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    await settle()
    expect(loadEarlier).toHaveBeenCalledWith('t1', 'm40')
  })

  it('keep loading while a page leaves the reader at the top, until none are left', async () => {
    loadEarlier
      .mockResolvedValueOnce({ messages: [], earlier: { before: 'm20', count: 20 } })
      .mockResolvedValueOnce({ messages: [], earlier: undefined })
    mount()
    scrollTo(list, 3000)
    scrollTo(list, 0)
    await settle()
    await settle()
    expect(loadEarlier.mock.calls.map((call) => call[1])).toEqual(['m40', 'm20'])
    expect(useAppStore.getState().earlierByThread.t1).toBeUndefined()
  })

  it('stop following once the reader has scrolled back down', async () => {
    let finish: (value: unknown) => void = () => undefined
    loadEarlier.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mount()
    scrollTo(list, 3000)
    scrollTo(list, 0)
    scrollTo(list, 2000)
    await act(async () => finish({ messages: [], earlier: { before: 'm20', count: 20 } }))
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  it('do not load for a transcript outside the pane (a side chat)', async () => {
    mount()
    const side = document.createElement('div')
    side.className = 'an-message-list'
    document.body.appendChild(side)
    Object.defineProperty(side, 'clientHeight', { configurable: true, value: 500 })
    scrollTo(side, 3000)
    scrollTo(side, 0)
    side.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    await settle()
    expect(loadEarlier).not.toHaveBeenCalled()
  })

  it('say why a page failed, load it again only on Retry', async () => {
    loadEarlier.mockRejectedValueOnce(new Error('Studio is offline.'))
    mount()
    scrollTo(list, 3000)
    scrollTo(list, 0)
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Studio is offline.')
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    act(() => retry.click())
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})
