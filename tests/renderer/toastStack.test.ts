// @vitest-environment jsdom
/**
 * The toast stack: newest in front, a thread keeps one toast, the open stack offers Clear all,
 * and a thread toast opens its thread.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const { ToastHost, showToast, dismissToast, dismissToastByKey, MAX_TOASTS, toastAge, useToastObstruction } = await import('../../src/renderer/components/ui/Toast')
const { useRef } = await import('react')
const { threadToastInput } = await import('../../src/renderer/lib/threadToasts')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(ToastHost)))
})

afterEach(() => {
  act(() => dismissToast())
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const toasts = () => [...document.querySelectorAll<HTMLElement>('.ui-toast')]
const messages = () => toasts().map((toast) => toast.querySelector('.ui-toast-message')?.textContent)

describe('the toast stack', () => {
  it('keeps several toasts, newest first, up to its limit', () => {
    act(() => { for (let i = 1; i <= MAX_TOASTS + 2; i++) showToast({ message: `Toast ${i}` }) })
    expect(toasts()).toHaveLength(MAX_TOASTS)
    expect(messages()[0]).toBe(`Toast ${MAX_TOASTS + 2}`)
  })

  it('replaces a toast with the same key, so a thread shows only its latest event', () => {
    act(() => {
      showToast(threadToastInput({ threadId: 't1', kind: 'question', threadName: 'Fix tests', projectName: 'mousse' }, () => {}))
      showToast({ message: 'Archived' })
      showToast(threadToastInput({ threadId: 't1', kind: 'completed', threadName: 'Fix tests', projectName: 'mousse' }, () => {}))
    })
    expect(messages()).toEqual(['Finished · mousse', 'Archived'])
    act(() => dismissToastByKey('thread:t1'))
    expect(messages()).toEqual(['Archived'])
  })

  it('opens into a list on hover with Clear all, which closes every toast', () => {
    act(() => { showToast({ message: 'One' }); showToast({ message: 'Two' }) })
    const section = document.querySelector<HTMLElement>('.ui-toaster')!
    act(() => { section.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body })) })
    expect(section.classList.contains('is-expanded')).toBe(true)
    act(() => { document.querySelector<HTMLButtonElement>('[data-action="clear-all"]')!.click() })
    expect(toasts()).toHaveLength(0)
  })

  it('opens the thread and closes the toast when a thread toast is clicked', () => {
    const open = vi.fn()
    act(() => { showToast(threadToastInput({ threadId: 't2', kind: 'idle', threadName: 'Migrate store' }, open)) })
    act(() => { document.querySelector<HTMLButtonElement>('.ui-toast-open')!.click() })
    expect(open).toHaveBeenCalledWith('t2')
    expect(toasts()).toHaveLength(0)
  })

  it('waits while the window is in the background', () => {
    vi.useFakeTimers()
    act(() => { showToast({ message: 'While away', durationMs: 1_000 }) })
    act(() => { window.dispatchEvent(new Event('blur')) })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(toasts()).toHaveLength(1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toasts()).toHaveLength(0)
  })

  it('says how long ago a toast came', () => {
    expect(toastAge(0, 10_000)).toBe('now')
    expect(toastAge(0, 4 * 60_000)).toBe('4m')
    expect(toastAge(0, 2 * 3_600_000)).toBe('2h')
  })
})

describe('a toast whose text is cut off', () => {
  const LONG = 'Could not change the icon · Method not allowed while the project is on another computer that is offline'
  const card = () => document.querySelector<HTMLElement>('.ui-toast')!
  const text = () => card().querySelector<HTMLElement>('.ui-toast-text')!
  const hover = (over: boolean) => act(() => {
    card().dispatchEvent(new PointerEvent(over ? 'pointerover' : 'pointerout', { bubbles: true, relatedTarget: document.body }))
  })

  beforeEach(() => {
    // jsdom lays nothing out: a long message reads as wider than its line.
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('ui-toast-message') && (this.textContent ?? '').length > 40 ? 500 : 0 }
    })
  })
  afterEach(() => { delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth })

  it('shows its tone as a tint, not a dot, and names an error for screen readers', () => {
    act(() => { showToast({ message: 'Could not pin', tone: 'error' }) })
    expect(card().classList.contains('ui-toast-error')).toBe(true)
    expect(card().querySelector('.ui-toast-dot, .ui-toast-mark')).toBeNull()
    expect(card().getAttribute('role')).toBe('alert')
    expect(card().querySelector('.sr-only')?.textContent).toContain('Error:')
  })

  it('offers no expanding when the text fits', () => {
    act(() => { showToast({ message: 'Archived' }) })
    expect(text().getAttribute('role')).toBeNull()
    expect(text().hasAttribute('aria-expanded')).toBe(false)
  })

  it('opens on click and stays open until clicked again, keeping Retry', () => {
    act(() => { showToast({ message: LONG, tone: 'error', action: { label: 'Retry', run: () => {} } }) })
    expect(text().getAttribute('role')).toBe('button')
    expect(text().getAttribute('aria-expanded')).toBe('false')
    act(() => { text().click() })
    expect(text().getAttribute('aria-expanded')).toBe('true')
    expect(card().classList.contains('is-open')).toBe(true)
    expect(card().querySelector('[data-action="retry"]')).not.toBeNull()
    hover(false)
    expect(text().getAttribute('aria-expanded')).toBe('true')
    act(() => { text().click() })
    expect(text().getAttribute('aria-expanded')).toBe('false')
    expect(card().querySelector('[data-action="copy"]')).toBeNull()
  })

  it('opens from the keyboard with Enter', () => {
    act(() => { showToast({ message: LONG, tone: 'error' }) })
    act(() => { text().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(text().getAttribute('aria-expanded')).toBe('true')
  })

  it('opens on hover and waits while hovered, then closes and runs out when the pointer leaves', () => {
    vi.useFakeTimers()
    act(() => { showToast({ message: LONG, tone: 'error', durationMs: 1_000 }) })
    hover(true)
    expect(text().getAttribute('aria-expanded')).toBe('true')
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(toasts()).toHaveLength(1)
    hover(false)
    expect(text().getAttribute('aria-expanded')).toBe('false')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toasts()).toHaveLength(0)
  })

  it('waits after the pointer leaves when it was clicked open', () => {
    vi.useFakeTimers()
    act(() => { showToast({ message: LONG, tone: 'error', durationMs: 1_000 }) })
    hover(true)
    act(() => { text().click() })
    hover(false)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(toasts()).toHaveLength(1)
  })

  it('copies the full text, then says Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    act(() => { showToast({ message: LONG, tone: 'error' }) })
    act(() => { text().click() })
    const copy = card().querySelector<HTMLButtonElement>('[data-action="copy"]')!
    expect(copy.getAttribute('aria-label')).toBe('Copy error')
    await act(async () => { copy.click() })
    expect(writeText).toHaveBeenCalledWith(LONG)
    expect(card().querySelector('.ui-toast-copied')?.textContent).toBe('Copied')
  })
})

describe('the toast stack above a pane footer', () => {
  // jsdom's window is 1024 × 768; the stack's column is its right 328px, 12px in.
  function Footer({ rect }: { rect: { left: number; right: number; top: number; bottom: number } }) {
    const ref = useRef<HTMLDivElement>(null)
    useToastObstruction(ref)
    return createElement('div', {
      className: 'pane-footer',
      ref: (element: HTMLDivElement | null) => {
        ref.current = element
        if (element) element.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON() {} }) as DOMRect
      }
    })
  }
  let footerRoot: Root
  let footerHost: HTMLDivElement
  beforeEach(() => {
    footerHost = document.createElement('div')
    document.body.appendChild(footerHost)
    footerRoot = createRoot(footerHost)
  })
  afterEach(() => {
    act(() => footerRoot.unmount())
    footerHost.remove()
  })
  const section = () => document.querySelector<HTMLElement>('.ui-toaster')!

  it('sits above a registered footer under it, and goes back down when the footer goes', () => {
    act(() => footerRoot.render(createElement(Footer, { rect: { left: 584, right: 1024, top: 713, bottom: 768 } })))
    act(() => { showToast({ message: 'Reverted', action: { label: 'Undo', run: () => {} } }) })
    // 768 - 713 = 55px of footer, plus an 8px gap.
    expect(section().style.bottom).toBe('63px')
    act(() => footerRoot.render(createElement('div')))
    expect(section().style.bottom).toBe('')
  })

  it('stays where it is for a footer outside its column, such as the composer side', () => {
    act(() => footerRoot.render(createElement(Footer, { rect: { left: 300, right: 600, top: 680, bottom: 768 } })))
    act(() => { showToast({ message: 'Archived' }) })
    expect(section().style.bottom).toBe('')
  })
})

describe('the toast stack after it empties', () => {
  const section = () => document.querySelector<HTMLElement>('.ui-toaster')

  it('a toast that comes after Clear all under the pointer closes by itself and the stack is not open', () => {
    vi.useFakeTimers()
    act(() => { showToast({ message: 'One' }); showToast({ message: 'Two' }) })
    act(() => { section()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body })) })
    act(() => { document.querySelector<HTMLButtonElement>('[data-action="clear-all"]')!.click() })
    // The leaving toasts fade out, then the stack is gone without the pointer ever leaving it.
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(section()).toBeNull()
    act(() => { showToast({ message: 'Later', durationMs: 1_000 }) })
    expect(section()!.classList.contains('is-expanded')).toBe(false)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toasts()).toHaveLength(0)
  })

  it('the same after the last toast was closed from the keyboard', () => {
    vi.useFakeTimers()
    act(() => { showToast({ message: 'One' }) })
    act(() => { document.querySelector<HTMLButtonElement>('.ui-toast button')!.focus() })
    act(() => { dismissToast() })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(section()).toBeNull()
    act(() => { showToast({ message: 'Later', durationMs: 1_000 }) })
    expect(section()!.classList.contains('is-expanded')).toBe(false)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(toasts()).toHaveLength(0)
  })
})
