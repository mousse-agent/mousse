// @vitest-environment jsdom
import { act, createElement, Fragment, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTurnWindow } from '../../src/renderer/chat/components/agent-elements/virtual/use-turn-window'
import { windowRowItems } from '../../src/renderer/chat/components/agent-elements/virtual/turn-window'
import type { FollowMode } from '../../src/renderer/chat/components/agent-elements/virtual/follow-mode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// With reduced motion, global.css gives every element a 0.01 ms transition on `all`. A spacer whose height
// transitioned would still report its old height when the hook reads the layout back in the same frame, and
// the window would move on every commit until React stopped it ("Maximum update depth exceeded").
let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
})

const keys = Array.from({ length: 200 }, (_, index) => `t-${index}`)

function Transcript() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const modeRef = useRef<FollowMode>('free')
  const api = useTurnWindow({ containerRef, rowsRef, keys, estimate: () => 120, enabled: true, modeRef, onProgrammaticScroll: () => {} })
  const items = windowRowItems(keys.length, api.window)
  return createElement('div', { ref: containerRef, className: 'transcript' },
    createElement('div', { ref: rowsRef, className: 'rows' },
      items.map((item) => item.kind === 'row'
        ? createElement('div', { key: keys[item.index], ref: api.rowRef(keys[item.index]!), 'data-turn-key': keys[item.index] }, `Turn ${item.index}`)
        : createElement('div', { key: item.kind, ref: item.kind === 'top-spacer' ? api.topSpacerRef : api.bottomSpacerRef, 'data-spacer': item.kind }))))
}

describe('turn window spacers', () => {
  it('apply their heights at once, so a reduced-motion transition never delays what the window reads back', () => {
    expect(() => act(() => root.render(createElement(Fragment, null, createElement(Transcript))))).not.toThrow()
    const spacers = [...host.querySelectorAll<HTMLElement>('[data-spacer]')]
    expect(spacers.length).toBeGreaterThan(0)
    for (const spacer of spacers) {
      expect(spacer.style.transition).toBe('none')
      expect(spacer.style.height).toMatch(/^\d+(\.\d+)?px$/)
    }
    // A thread of 200 turns opened at the top: the turns below the window are one spacer, not 200 rows.
    const bottom = host.querySelector<HTMLElement>('[data-spacer="bottom-spacer"]')!
    expect(Number.parseFloat(bottom.style.height)).toBeGreaterThan(10_000)
    expect(host.querySelectorAll('[data-turn-key]').length).toBeLessThan(80)
  })
})
