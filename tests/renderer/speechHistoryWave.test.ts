// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_MS, STILL_SAMPLE_MS, SpeechHistoryWave } from '../../src/renderer/speech/SpeechHistoryWave'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
let clock = 0
let voice = 0
const levels = () => [voice * 0.4, voice, voice * 0.6, 0]

beforeEach(() => {
  frames = new Map()
  clock = 1000
  voice = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  host = document.createElement('div')
  root = createRoot(host)
  act(() => root.render(createElement(SpeechHistoryWave, { levels })))
})

afterEach(() => {
  act(() => root.unmount())
  setAnimationSpeed('normal')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Moves the clock on by `ms` and runs the frame waiting then. */
function frameAfter(ms: number): void {
  clock += ms
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((frame) => frame(clock))
}

const heights = () => [...host.querySelectorAll<HTMLElement>('.speech-history-bar')].map((bar) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1]))
const strip = () => host.querySelector<HTMLElement>('.speech-history-strip')!

describe('the recording wave', () => {
  it('puts the newest sound on the right and moves it left one bar per sample', () => {
    voice = 1
    frameAfter(SAMPLE_MS)
    const loud = heights()
    expect(loud.at(-1)).toBe(1)
    expect(loud.at(-2)).toBeLessThan(0.2)

    voice = 0
    frameAfter(SAMPLE_MS)
    frameAfter(SAMPLE_MS)
    const later = heights()
    expect(later.at(-3)).toBe(1)
    expect(later.at(-1)).toBeLessThan(0.2)
    // Between samples the strip slides, so the scroll is smooth rather than a jump per sample.
    frameAfter(SAMPLE_MS / 2)
    expect(strip().style.transform).toMatch(/translateX\(2\.50px\)/)
  })

  it('with motion off it never scrolls: the bars stay in one shape and follow the voice', () => {
    act(() => setAnimationSpeed('off'))
    voice = 1
    frameAfter(STILL_SAMPLE_MS)
    const loud = heights()
    expect(Math.max(...loud)).toBeGreaterThan(0.8)
    voice = 0
    frameAfter(STILL_SAMPLE_MS)
    expect(new Set(heights())).toEqual(new Set([0.12]))
    expect(strip().style.transform).toBe('')
    // Between samples nothing changes.
    voice = 1
    frameAfter(STILL_SAMPLE_MS / 2)
    expect(new Set(heights())).toEqual(new Set([0.12]))
  })
})
