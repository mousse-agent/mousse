/**
 * The app's zoom keys (Control or Command with +, - or 0) zoom the window, except while a page the window draws has
 * the keyboard (a browser without a window, taken over): then they reach that view, which zooms its page.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachZoomShortcuts, setPageKeyboard } from '../src/main/zoomShortcuts'

function window(id: number) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let level = 0
  const contents = {
    id,
    on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener) },
    once: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener) },
    getZoomLevel: () => level,
    setZoomLevel: vi.fn((next: number) => { level = next })
  }
  attachZoomShortcuts(contents as unknown as WebContents)
  /** Control and a key, as the window gets it; whether the app took it. */
  const press = (key: string, code: string) => {
    const event = { preventDefault: vi.fn() }
    listeners.get('before-input-event')!(event, { type: 'keyDown', key, code, control: true, meta: false })
    return event.preventDefault.mock.calls.length > 0
  }
  return { contents, press, level: () => level, emit: (name: string, ...args: unknown[]) => listeners.get(name)!(...args) }
}

describe('the zoom keys', () => {
  it('zoom the window, but not while a page it draws has the keyboard', () => {
    const app = window(41)
    expect(app.press('=', 'Equal')).toBe(true)
    expect(app.level()).toBe(0.5)
    setPageKeyboard(41, true)
    expect(app.press('=', 'Equal')).toBe(false)
    expect(app.press('-', 'Minus')).toBe(false)
    expect(app.press('0', 'Digit0')).toBe(false)
    expect(app.level()).toBe(0.5)
    setPageKeyboard(41, false)
    expect(app.press('0', 'Digit0')).toBe(true)
    expect(app.level()).toBe(0)
  })

  it('are the window\'s again once it loads again, whatever it said before', () => {
    const app = window(42)
    setPageKeyboard(42, true)
    app.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(app.press('=', 'Equal')).toBe(true)
  })

  it('stand aside only in the window whose page has the keyboard', () => {
    const one = window(43)
    const other = window(44)
    setPageKeyboard(43, true)
    expect(one.press('=', 'Equal')).toBe(false)
    expect(other.press('=', 'Equal')).toBe(true)
    setPageKeyboard(43, false)
  })
})
