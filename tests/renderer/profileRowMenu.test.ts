// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileRowMenu, type ProfileRowMenuItem } from '../../src/renderer/components/profiles/ProfileRowMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let anchor: HTMLButtonElement

beforeEach(() => {
  host = document.createElement('div')
  anchor = document.createElement('button')
  anchor.setAttribute('aria-label', 'Studio profile actions')
  document.body.append(host, anchor)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  anchor.remove()
})

const items = (select: Record<string, () => void> = {}): ProfileRowMenuItem[] => ['Rename', 'Colour', 'Archive'].map((label) => ({
  id: label.toLowerCase(),
  label,
  icon: null as ReactNode,
  danger: label === 'Archive',
  onSelect: select[label] ?? (() => undefined)
}))

function show(onClose = vi.fn(), select: Record<string, () => void> = {}) {
  act(() => root.render(createElement(ProfileRowMenu, { anchor, label: 'Studio profile actions', items: items(select), onClose })))
  return onClose
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
const rows = () => [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const focusedLabel = () => document.activeElement?.textContent
const press = (key: string, target: Element = document.activeElement!) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

describe('ProfileRowMenu', () => {
  it('is a labelled menu beside the kebab with the first action focused', () => {
    show()
    expect(menu().getAttribute('aria-label')).toBe('Studio profile actions')
    expect(rows().map((row) => row.textContent)).toEqual(['Rename', 'Colour', 'Archive'])
    expect(menu().parentElement).toBe(document.body)
    expect(focusedLabel()).toBe('Rename')
  })

  it('moves with Arrow keys, wraps at both ends, and jumps with Home and End', () => {
    show()
    const walk = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'End', 'Home', 'ArrowUp'].map((key) => { press(key); return focusedLabel() })
    expect(walk).toEqual(['Colour', 'Archive', 'Rename', 'Archive', 'Rename', 'Archive'])
    expect(press('ArrowDown').defaultPrevented).toBe(true)
  })

  it('closes on Escape, returns focus to the kebab and keeps the key from the popover behind it', () => {
    const onClose = show()
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    const event = press('Escape')
    window.removeEventListener('keydown', behind)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(anchor)
    expect(event.defaultPrevented).toBe(true)
    expect(behind).not.toHaveBeenCalled()
  })

  it('closes on Left Arrow and Tab, also returning focus to the kebab', () => {
    for (const key of ['ArrowLeft', 'Tab']) {
      const onClose = show()
      rows()[1]!.focus()
      press(key)
      expect(onClose, key).toHaveBeenCalledTimes(1)
      expect(document.activeElement, key).toBe(anchor)
    }
  })

  it('runs the chosen action when a row is clicked', () => {
    const rename = vi.fn()
    show(vi.fn(), { Rename: rename })
    act(() => rows()[0]!.click())
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('marks Archive as the destructive row', () => {
    show()
    expect(rows().map((row) => row.classList.contains('profile-menu-row-danger'))).toEqual([false, false, true])
  })

  it('closes on a press outside, but not inside the menu or on its kebab', () => {
    const onClose = show()
    const outside = document.createElement('div')
    document.body.append(outside)
    const down = (target: Element) => act(() => { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    down(rows()[0]!)
    down(anchor)
    expect(onClose).not.toHaveBeenCalled()
    down(outside)
    expect(onClose).toHaveBeenCalledTimes(1)
    outside.remove()
  })
})
