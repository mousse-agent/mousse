// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../../src/renderer/components/CommandPalette'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom replaces URL, so paths are resolved from this file's folder.
const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/thread-search.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors!.trim() === selector)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found[2]!
}

/** The property names set by every keyframe of `@keyframes name`. */
function keyframeProperties(name: string): string[] {
  const at = css.indexOf(`@keyframes ${name} {`)
  expect(at, name).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n}', at)
  const declarations = [...css.slice(at, end).matchAll(/\{([^{}]*)\}/g)].flatMap((frame) => frame[1]!.split(';'))
  return [...new Set(declarations.map((declaration) => declaration.split(':')[0]!.trim()).filter(Boolean))]
}

describe('closing the search palette', () => {
  let root: Root | undefined
  let host: HTMLElement

  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    act(() => root!.render(createElement(CommandPalette)))
    act(() => useAppStore.getState().setPaletteOpen(true, 'messages'))
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    act(() => useAppStore.getState().setPaletteOpen(false))
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  const overlay = () => host.querySelector('.thread-search-overlay')
  // React listens for the vendor-prefixed name when the DOM it finds has no unprefixed animation styles, as in jsdom.
  const animationEnd = (target: Element, animationName: string) =>
    act(() => {
      for (const type of ['animationend', 'webkitAnimationEnd']) {
        target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { animationName }))
      }
    })

  it('keeps the same dialog through the fade and unmounts it when the overlay fade ends', () => {
    const dialog = host.querySelector('.thread-search-dialog')
    act(() => useAppStore.getState().setPaletteOpen(false))
    expect(overlay()?.classList.contains('is-closing')).toBe(true)
    // The fade does not mount a new dialog or list in its place.
    expect(host.querySelector('.thread-search-dialog')).toBe(dialog)
    // Search threads stays Search threads while it fades: no switch to the command list, which grew the dialog mid-fade.
    expect(dialog?.getAttribute('aria-label')).toBe('Search threads')
    expect(useAppStore.getState().paletteMode).toBe('messages')

    // The dialog's own scale ends first or at the same time; only the overlay's fade unmounts it.
    animationEnd(dialog!, 'thread-search-out')
    expect(overlay()).not.toBeNull()
    animationEnd(overlay()!, 'thread-search-dim-out')
    expect(overlay()).toBeNull()
  })

  describe('with motion off', () => {
    afterEach(() => {
      setAnimationSpeed('normal')
      vi.unstubAllGlobals()
    })

    // No fade runs, so nothing waits for its end or for the fallback timer.
    const closesAtOnce = () => {
      vi.useFakeTimers()
      act(() => useAppStore.getState().setPaletteOpen(false))
      expect(overlay()).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    }

    it('closes at once with Animation speed Off', () => {
      setAnimationSpeed('off')
      closesAtOnce()
    })

    it('closes at once when the OS reduces motion', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener: () => {} }))
      closesAtOnce()
    })
  })

  it('still unmounts when the fade never reports its end, as in a hidden window', () => {
    vi.useFakeTimers()
    act(() => useAppStore.getState().setPaletteOpen(false))
    act(() => void vi.advanceTimersByTime(119))
    expect(overlay()).not.toBeNull()
    act(() => void vi.advanceTimersByTime(400))
    expect(overlay()).toBeNull()
  })
})

describe('the close animation', () => {
  it('fades only the overlay, without its blur, and moves the dialog by transform only', () => {
    const closing = rule('.thread-search-overlay.is-closing')
    // A blurred full-window layer under a changing opacity is drawn again on every frame.
    expect(closing).toMatch(/(^|[^-])backdrop-filter:\s*none/)
    expect(closing).toMatch(/-webkit-backdrop-filter:\s*none/)
    expect(closing).toMatch(/animation:\s*thread-search-dim-out\b/)
    expect(rule('.thread-search-overlay.is-closing .thread-search-dialog')).toMatch(/animation:\s*thread-search-out\b/)
    expect(keyframeProperties('thread-search-dim-out')).toEqual(['opacity'])
    // One fade: the dialog fades with the overlay, so its own keyframes only scale it.
    expect(keyframeProperties('thread-search-out')).toEqual(['transform'])
  })

  it('eases out, so the fade does not hold until its last frames', () => {
    for (const selector of ['.thread-search-overlay.is-closing', '.thread-search-overlay.is-closing .thread-search-dialog']) {
      const animation = /animation:\s*([^;]*);/.exec(rule(selector))![1]!
      expect(animation).not.toMatch(/ease-in\b/)
      expect(animation).toMatch(/cubic-bezier\(0\.5, 1, 0\.89, 1\)/)
    }
  })
})
