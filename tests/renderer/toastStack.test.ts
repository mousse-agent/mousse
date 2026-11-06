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

const { ToastHost, showToast, dismissToast, dismissToastByKey, MAX_TOASTS, toastAge } = await import('../../src/renderer/components/ui/Toast')
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
