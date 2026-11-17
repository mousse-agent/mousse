// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTurnWindow } from '../../src/renderer/chat/components/agent-elements/virtual/use-turn-window'
import { windowRowItems } from '../../src/renderer/chat/components/agent-elements/virtual/turn-window'
import type { FollowMode } from '../../src/renderer/chat/components/agent-elements/virtual/follow-mode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Reading the rows wrapper's computed gap forces a style pass over the whole transcript. The layout is
// rebuilt on every commit and every row resize, so a scroll back through a long thread read it hundreds
// of times. It is read once and again only after something that can change it.
let root: Root
let host: HTMLElement
let resize: ((entries: ResizeObserverEntry[]) => void) | null = null
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: (entries: ResizeObserverEntry[]) => void) { resize = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.ResizeObserver = realResizeObserver
  resize = null
  vi.restoreAllMocks()
})

let rowsEl: HTMLDivElement | null = null
let containerEl: HTMLDivElement | null = null

function Transcript({ keys }: { keys: readonly string[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const modeRef = useRef<FollowMode>('free')
  const api = useTurnWindow({ containerRef, rowsRef, keys, estimate: () => 120, enabled: true, modeRef, onProgrammaticScroll: () => {} })
  const items = windowRowItems(keys.length, api.window)
  return createElement('div', { ref: (el: HTMLDivElement | null) => { containerRef.current = el; containerEl = el } },
    createElement('div', { ref: (el: HTMLDivElement | null) => { rowsRef.current = el; rowsEl = el }, style: { rowGap: '21px' } },
      items.map((item) => item.kind === 'row'
        ? createElement('div', { key: keys[item.index], ref: api.rowRef(keys[item.index]!), 'data-turn-key': keys[item.index] }, `Turn ${item.index}`)
        : createElement('div', { key: item.kind, ref: item.kind === 'top-spacer' ? api.topSpacerRef : api.bottomSpacerRef, 'data-spacer': item.kind }))))
}

const keysOf = (n: number) => Array.from({ length: n }, (_, index) => `t-${index}`)

function rowsGapReads(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([el]) => el === rowsEl).length
}

function rowEntry(key: string): ResizeObserverEntry {
  const target = host.querySelector(`[data-turn-key="${key}"]`)!
  return { target, contentRect: { height: 140 }, borderBoxSize: [{ blockSize: 140, inlineSize: 600 }] } as unknown as ResizeObserverEntry
}

describe('turn window row gap', () => {
  it('is read from the computed style a bounded number of times across many layout rebuilds', () => {
    const spy = vi.spyOn(window, 'getComputedStyle')
    act(() => root.render(createElement(Transcript, { keys: keysOf(100) })))
    // Fifty commits with new turns, each rebuilding the layout twice, then fifty row resizes.
    for (let n = 101; n <= 150; n += 1) act(() => root.render(createElement(Transcript, { keys: keysOf(n) })))
    for (let i = 0; i < 50; i += 1) act(() => resize!([rowEntry(`t-${(i % 2) === 0 ? 0 : 149}`)]))
    expect(rowsGapReads(spy)).toBeGreaterThan(0)
    expect(rowsGapReads(spy)).toBeLessThanOrEqual(2)
  })

  it('reads the gap again after the root element changes or the container resizes', async () => {
    const spy = vi.spyOn(window, 'getComputedStyle')
    act(() => root.render(createElement(Transcript, { keys: keysOf(100) })))
    const first = rowsGapReads(spy)

    // A theme or density change on the root element: the next rebuild reads the gap once more.
    document.documentElement.setAttribute('data-theme', 'another-theme')
    await Promise.resolve()
    act(() => resize!([rowEntry('t-0')]))
    act(() => resize!([rowEntry('t-99')]))
    expect(rowsGapReads(spy)).toBe(first + 1)

    // A resized container (with a row resize in the same batch) reads it once more too.
    act(() => resize!([{ target: containerEl!, contentRect: { height: 500 } } as unknown as ResizeObserverEntry, rowEntry('t-0')]))
    act(() => resize!([rowEntry('t-99')]))
    expect(rowsGapReads(spy)).toBe(first + 2)
    document.documentElement.removeAttribute('data-theme')
  })
})
