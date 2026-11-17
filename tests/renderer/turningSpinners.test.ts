// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Loader2 } from '../../src/renderer/lib/icons'
import { IconSpinner } from '../../src/renderer/chat/components/agent-elements/icons'
import { ProgressRing } from '../../src/renderer/components/downloads/DownloadsIndicator'
import { DelayedLoader } from '../../src/renderer/components/ui/DelayedLoader'
import { setAnimationSpeed } from '../../src/renderer/lib/motion'

// Every spinner turns through Turning (lib/turning.tsx): a Web Animation on a <span> around the still svg, which
// Chromium runs on the compositor. jsdom has no Web Animations, so element.animate is recorded here; that it really
// runs on the compositor is checked in a trace of the app, not here.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Started = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }
let started: Started[] = []
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  started = []
  ;(HTMLElement.prototype as { animate?: unknown }).animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const record: Started = { element: this, keyframes, options, cancelled: false }
    started.push(record)
    return { cancel: () => { record.cancelled = true } }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (HTMLElement.prototype as { animate?: unknown }).animate
  setAnimationSpeed('normal')
})

const show = (element: ReactElement) => act(() => root.render(element))
const running = () => started.filter((record) => !record.cancelled)
const turn = (record: Started) => ({
  tag: record.element.tagName.toLowerCase(),
  holdsSvg: record.element.firstElementChild?.tagName.toLowerCase() === 'svg',
  from: record.keyframes[0]?.transform,
  to: record.keyframes[1]?.transform,
  ms: record.options.duration,
  iterations: record.options.iterations,
})

// Each spinner class with its speed on master, and whether it keeps turning with motion off (master exempted
// .icon-spin and .spin on purpose: they show pending work).
const SPINNERS: Array<[className: string, ms: number, keepsTurningWithMotionOff: boolean]> = [
  ['icon-spin', 1000, true],
  ['spin', 800, true],
  ['animate-spin', 1000, false],
  ['chat-spin', 1000, false],
  ['inbox-spin', 1100, false],
  ['pr-panel-spin', 1000, false],
  ['side-card-action-spin', 900, false],
  ['side-card-git-next-spin', 900, false],
  ['read-aloud-spin', 900, false],
  ['composer-transcribing-spin', 900, false],
]

describe('spinners', () => {
  it.each(SPINNERS)('%s turns a span around the still svg, once every %ims, smoothly and forever', (className, ms) => {
    show(createElement(Loader2, { size: 14, className: `extra ${className}` }))
    expect(running().map(turn)).toEqual([{ tag: 'span', holdsSvg: true, from: 'rotate(0deg)', to: 'rotate(360deg)', ms, iterations: Infinity }])
    // The span takes the classes that place the icon; the svg keeps none of them.
    expect(host.querySelector('span.turning')!.classList.contains('extra')).toBe(true)
    expect(host.querySelector('svg')!.getAttribute('class')).toBe('mousse-icon')
  })

  it.each(SPINNERS)('%s with motion off: still unless it shows pending work', (className, _ms, keeps) => {
    setAnimationSpeed('off')
    show(createElement(Loader2, { className }))
    expect(running().length).toBe(keeps ? 1 : 0)
  })

  it('stops or starts when the speed changes while it shows, and stops when it goes', () => {
    show(createElement(Loader2, { className: 'chat-spin' }))
    expect(running()).toHaveLength(1)
    act(() => setAnimationSpeed('off'))
    expect(running()).toHaveLength(0)
    act(() => setAnimationSpeed('normal'))
    expect(running()).toHaveLength(1)
    show(createElement('p'))
    expect(running()).toHaveLength(0)
  })

  it('leaves a still icon alone', () => {
    show(createElement(Loader2, { className: 'extra' }))
    expect(started).toEqual([])
    expect(host.innerHTML).toMatch(/^<svg[^>]*class="mousse-icon extra"/)
  })

  it('keeps its speed at every Animation speed but Off, as the CSS spinners did', () => {
    show(createElement(Loader2, { className: 'inbox-spin' }))
    act(() => setAnimationSpeed('slow'))
    expect(running().map((record) => record.options.duration)).toEqual([1100])
  })

  it('turns the downloads ring from its 12 o\'clock start while the size is unknown', () => {
    show(createElement(ProgressRing, {}))
    expect(running().map(turn)).toEqual([{ tag: 'span', holdsSvg: true, from: 'rotate(-90deg)', to: 'rotate(270deg)', ms: 1000, iterations: Infinity }])
    show(createElement(ProgressRing, { percent: 40 }))
    expect(running()).toHaveLength(0)
  })

  it('turns the tool rows\' spinner and the page loader\'s ring', () => {
    show(createElement(IconSpinner, { className: 'w-4 h-4 animate-spin shrink-0' }))
    expect(running().map(turn)).toMatchObject([{ tag: 'span', holdsSvg: true, ms: 1000 }])
    vi.useFakeTimers()
    try {
      show(createElement(DelayedLoader, { label: 'Loading', delayMs: 0 }))
      expect(running().map((record) => [record.element.className, record.options.duration])).toEqual([['turning ui-loader-ring icon-spin', 1000]])
    } finally {
      vi.useRealTimers()
    }
  })
})
