// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'
import { PANEL_MOTION_MS, usePanelClosing } from '../../src/renderer/lib/panelPresence'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let seen: boolean[]

function Probe({ open }: { open: boolean }) {
  seen.push(usePanelClosing(open))
  return null
}

const render = (open: boolean) => act(() => root.render(createElement(Probe, { open })))

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root.unmount())
  setAnimationSpeed('normal')
  vi.useRealTimers()
})

describe('usePanelClosing', () => {
  it('holds the panel from the render that closes it until its motion ends', () => {
    render(true)
    render(false)
    expect(seen.at(-1)).toBe(true)
    act(() => vi.advanceTimersByTime(PANEL_MOTION_MS - 1))
    expect(seen.at(-1)).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(seen.at(-1)).toBe(false)
  })

  it('lets go at once when the panel opens again mid-motion', () => {
    render(true)
    render(false)
    render(true)
    expect(seen.at(-1)).toBe(false)
  })

  it('never holds it with motion off', () => {
    setAnimationSpeed('off')
    render(true)
    render(false)
    expect(seen.every((closing) => !closing)).toBe(true)
  })
})
