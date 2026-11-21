// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EarlierMessagesBar } from '../../src/renderer/components/EarlierMessagesBar'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * A long thread's older messages load as the reader scrolls up near the top of the center pane's transcript, with no
 * bar asking for them, one page per move of the reader. Inputs: a scroll up near the top after the reader moved, a
 * scroll down, a scroll up nobody made (the view moving by itself when a page comes in), a wheel turned up at the very
 * top (where nothing scrolls, so no scroll event comes), one wheel turn that a page answers, messages that do not fill
 * the view, a side chat's transcript outside the pane, and a page that fails.
 */

let root: Root
let host: HTMLDivElement
let list: HTMLDivElement
let loadEarlier: ReturnType<typeof vi.fn>

/** The pane as the chat lays it out: the loader beside the transcript, whose scroll position the test sets. */
function mount(rows = false, scrollHeight = 20000): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const transcript = createElement('div', { className: 'an-message-list', id: 'list' }, rows ? createElement('div', { 'data-turn-key': 'u-1' }) : null)
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.id === 'list' ? 500 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.id === 'list' ? scrollHeight : 0 } })
  act(() => root.render(createElement('div', { 'data-mousse': 'chat' }, createElement(EarlierMessagesBar), transcript)))
  list = host.querySelector<HTMLDivElement>('#list')!
}

function scrollTo(target: HTMLElement, top: number): void {
  Object.defineProperty(target, 'scrollTop', { configurable: true, value: top })
  target.dispatchEvent(new Event('scroll'))
}

function wheelUp(target: HTMLElement): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
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
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
})

describe('older messages of a long thread', () => {
  it('shows no bar asking to load them', () => {
    mount()
    expect(host.textContent).not.toMatch(/earlier message/)
    expect(host.querySelector('button')).toBeNull()
  })

  it('load when the reader scrolls up near the top of the transcript, not when scrolling down', async () => {
    mount()
    scrollTo(list, 3000)
    wheelUp(list)
    scrollTo(list, 3200)
    expect(loadEarlier).not.toHaveBeenCalled()
    scrollTo(list, 400)
    await settle()
    expect(loadEarlier).toHaveBeenCalledWith('t1', 'm40')
  })

  it('do not load for a move up nobody made', async () => {
    mount()
    scrollTo(list, 3000)
    scrollTo(list, 0)
    await settle()
    expect(loadEarlier).not.toHaveBeenCalled()
  })

  it('load when the wheel turns up at the very top, where nothing scrolls', async () => {
    mount()
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 0 })
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }))
    expect(loadEarlier).not.toHaveBeenCalled()
    wheelUp(list)
    await settle()
    expect(loadEarlier).toHaveBeenCalledWith('t1', 'm40')
  })

  it('load one page for one turn of the wheel, the next only when the reader moves up again', async () => {
    loadEarlier
      .mockResolvedValueOnce({ messages: [], earlier: { before: 'm20', count: 20 } })
      .mockResolvedValueOnce({ messages: [], earlier: undefined })
    mount()
    scrollTo(list, 0)
    wheelUp(list)
    await settle()
    expect(loadEarlier.mock.calls.map((call) => call[1])).toEqual(['m40'])
    // The page came in above: the transcript keeps the message being read in place, which moves the view down, and any
    // correction after it moves it a little up again. Neither is the reader.
    scrollTo(list, 900)
    scrollTo(list, 850)
    await settle()
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    wheelUp(list)
    await settle()
    expect(loadEarlier.mock.calls.map((call) => call[1])).toEqual(['m40', 'm20'])
    expect(useAppStore.getState().earlierByThread.t1).toBeUndefined()
  })

  it('keep loading by themselves while the messages do not fill the view, until none are left', async () => {
    loadEarlier
      .mockResolvedValueOnce({ messages: [], earlier: { before: 'm20', count: 20 } })
      .mockResolvedValueOnce({ messages: [], earlier: undefined })
    mount(true, 500)
    await settle()
    await settle()
    expect(loadEarlier.mock.calls.map((call) => call[1])).toEqual(['m40', 'm20'])
  })

  it('do not load for a transcript outside the pane (a side chat)', async () => {
    mount()
    const side = document.createElement('div')
    side.className = 'an-message-list'
    document.body.appendChild(side)
    scrollTo(side, 3000)
    wheelUp(side)
    scrollTo(side, 0)
    await settle()
    expect(loadEarlier).not.toHaveBeenCalled()
  })

  it('say why a page failed, load it again only on Retry', async () => {
    loadEarlier.mockRejectedValueOnce(new Error('Studio is offline.'))
    mount()
    scrollTo(list, 0)
    wheelUp(list)
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Studio is offline.')
    wheelUp(list)
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    act(() => retry.click())
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})
