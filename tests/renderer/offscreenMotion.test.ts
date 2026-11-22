// @vitest-environment jsdom
/**
 * A running turn's looping indicators hold still while no one can see them: each is marked `data-offscreen` (which a
 * stylesheet pauses) while it is scrolled out of view or the window is hidden, and unmarked when it can be seen again.
 * The element stays mounted and in place. A spinner's Web Animation is paused and played the same way.
 *
 * jsdom has no layout or animation: an IntersectionObserver stub reports what is in view, and the paused motion itself
 * is checked by hand in the app (a trace with the live row scrolled away and with the window hidden).
 */
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { IconSpinner } from '../../src/renderer/chat/components/agent-elements/icons'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import { offscreenWatchForTests } from '../../src/renderer/lib/offscreenMotion'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Stands in for the browser's observers (the message list keeps its own too): the test says what is in view. */
class FakeIntersectionObserver {
  static made: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()
  disconnected = false
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.made.push(this)
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); this.disconnected = true }
  takeRecords() { return [] }
}

let root: Root
let host: HTMLElement
let visibility: DocumentVisibilityState = 'visible'
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver
const realIntersectionObserver = globalThis.IntersectionObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
  FakeIntersectionObserver.made = []
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setReplyPacing(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  globalThis.IntersectionObserver = realIntersectionObserver
  delete (document as { visibilityState?: unknown }).visibilityState
  delete (HTMLElement.prototype as { animate?: unknown }).animate
  setReplyPacing(true)
  useAppStore.setState({ shimmerAnimations: true })
})

const createdAt = '2026-11-18T10:00:00.000Z'
const ask = (): UIMessage => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Why do the cache keys miss?' }], createdAt } as unknown as UIMessage)
const reply = (id: string, ...parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts, createdAt } as unknown as UIMessage)
const thought = (state: 'input-available' | 'output-available', text: string) =>
  ({ type: 'tool-Thinking', toolCallId: `th-${text.length}`, state, input: { thought: text } })
const bash = (id: string, command: string) => ({ type: 'tool-Bash', toolCallId: id, state: 'input-available', input: { command } })

function render(messages: UIMessage[], progress: TurnProgressState) {
  act(() => root.render(createElement(TurnProgressContext.Provider, { value: progress }, createElement(MessageList, { messages, status: 'streaming' }))))
}

/** The live observer watching `element`, if any. */
const watcherOf = (element: Element) => FakeIntersectionObserver.made.find((o) => !o.disconnected && o.targets.has(element))
/** The browser reports `elements` scrolled into or out of view. */
function inView(elements: Element[], intersecting: boolean) {
  const io = watcherOf(elements[0]!)!
  act(() => io.callback(elements.map((target) => ({ target, isIntersecting: intersecting }) as IntersectionObserverEntry), io as unknown as IntersectionObserver))
}
function windowShown(shown: boolean) {
  visibility = shown ? 'visible' : 'hidden'
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const paused = (element: Element) => element.hasAttribute('data-offscreen')

/** Each looping indicator of a running turn, where it shows. */
const INDICATORS: Array<[string, UIMessage[], TurnProgressState, string]> = [
  ['the thinking icon while the turn thinks', [ask(), reply('a1', thought('input-available', 'Reading the key builder'))], { phase: 'thinking' }, '[data-turn-live] svg.thinking-icon.is-thinking'],
  ["a running call's icon on the live row", [ask(), reply('a1', bash('b1', 'npm test'))], { phase: 'tool_running' }, '[data-turn-live] .an-tool-icon[data-state="running"]'],
  ["the live row's dots during a retry", [ask()], { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } }, '[data-turn-live] .turn-progress-dots'],
]

describe('a looping indicator pauses while no one can see it', () => {
  it.each(INDICATORS)('%s: out of view and in a hidden window it is marked paused, and in view again it is not', (_name, messages, progress, selector) => {
    render(messages, progress)
    const indicator = host.querySelector(selector)!
    expect(indicator).not.toBeNull()
    expect(watcherOf(indicator)).toBeDefined()
    expect(paused(indicator)).toBe(false)

    inView([indicator], false)
    expect(paused(indicator)).toBe(true)
    inView([indicator], true)
    expect(paused(indicator)).toBe(false)

    windowShown(false)
    expect(paused(indicator)).toBe(true)
    // Still hidden: scrolling it into view does not start it.
    inView([indicator], true)
    expect(paused(indicator)).toBe(true)
    windowShown(true)
    expect(paused(indicator)).toBe(false)

    // Nothing was unmounted or moved: the same element, in the same place.
    expect(host.querySelector(selector)).toBe(indicator)
  })

  it("a running call's row in the opened live row pauses its icon and its label's sweep", () => {
    render([ask(), reply('a1', thought('output-available', 'Running the tests first.'), bash('b1', 'npm test'))], { phase: 'tool_running' })
    act(() => host.querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    const rows = host.querySelector('[data-turn-live] .an-tool-group-rows')!
    const moving = [...rows.querySelectorAll('.an-tool-icon[data-state="running"], .an-text-shimmer--active')]
    expect(moving.length).toBeGreaterThanOrEqual(2)
    inView(moving, false)
    expect(moving.every(paused)).toBe(true)
    inView(moving, true)
    expect(moving.some(paused)).toBe(false)
  })

  it('leaves a readable running label and keeps the status icon when shimmer is off', () => {
    render([ask(), reply('a1', thought('output-available', 'Running the tests first.'), bash('b1', 'npm test'))], { phase: 'tool_running' })
    act(() => host.querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    const rows = host.querySelector('[data-turn-live] .an-tool-group-rows')!
    const label = rows.querySelector('.an-text-shimmer--active')!
    const text = label.textContent

    act(() => useAppStore.setState({ shimmerAnimations: false }))
    expect(rows.textContent).toContain(text!)
    expect(rows.querySelector('.an-text-shimmer--active')).toBeNull()
    expect(watcherOf(label)).toBeUndefined()
    expect(rows.querySelector('.an-tool-icon[data-state="running"]')).not.toBeNull()

    act(() => useAppStore.setState({ shimmerAnimations: true }))
    expect(rows.querySelector('.an-text-shimmer--active')?.textContent).toBe(text)
  })

  it('a still indicator is not watched: a finished call and a done thought take no observer', () => {
    const done = { type: 'tool-Bash', toolCallId: 'b1', state: 'output-available', input: { command: 'npm test' }, output: 'ok' }
    render([ask(), reply('a1', thought('output-available', 'Done reading.'), done)], { phase: 'thinking' })
    const still = [...host.querySelectorAll('.an-tool-icon[data-state="done"], svg.thinking-icon:not(.is-thinking)')]
    expect(still.length).toBeGreaterThan(0)
    for (const element of still) expect(watcherOf(element)).toBeUndefined()
  })

  it('when the turn ends and nothing loops, the observer and the visibility listener go', () => {
    render([ask(), reply('a1', bash('b1', 'npm test'))], { phase: 'tool_running' })
    const io = watcherOf(host.querySelector('.an-tool-icon[data-state="running"]')!)!
    expect(io).toBeDefined()
    act(() => root.render(createElement('div')))
    expect(io.disconnected).toBe(true)
    // A visibility change now marks nothing (no listener is left behind).
    windowShown(false)
    expect(document.querySelectorAll('[data-offscreen]')).toHaveLength(0)
  })
})

describe('a spinner pauses its turn while no one can see it', () => {
  it('pauses the Web Animation out of view or in a hidden window, and plays it again when seen', () => {
    const calls: string[] = []
    ;(HTMLElement.prototype as { animate?: unknown }).animate = function () {
      return { cancel: () => calls.push('cancel'), pause: () => calls.push('pause'), play: () => calls.push('play') }
    }
    act(() => root.render(createElement(IconSpinner, { className: 'w-4 h-4 animate-spin shrink-0' })))
    const span = host.querySelector('span.turning')!
    expect(calls).toEqual([])
    inView([span], false)
    expect(calls).toEqual(['pause'])
    inView([span], true)
    expect(calls).toEqual(['pause', 'play'])
    windowShown(false)
    windowShown(true)
    expect(calls).toEqual(['pause', 'play', 'pause', 'play'])
    act(() => root.render(createElement('div')))
    expect(calls.at(-1)).toBe('cancel')
  })

  it('first shown in a hidden window, it starts paused and plays once the window shows', () => {
    const calls: string[] = []
    ;(HTMLElement.prototype as { animate?: unknown }).animate = function () {
      return { cancel: () => calls.push('cancel'), pause: () => calls.push('pause'), play: () => calls.push('play') }
    }
    visibility = 'hidden'
    act(() => root.render(createElement(IconSpinner, { className: 'w-4 h-4 animate-spin shrink-0' })))
    expect(calls).toEqual(['pause'])
    expect(paused(host.querySelector('span.turning')!)).toBe(true)
    windowShown(true)
    expect(calls).toEqual(['pause', 'play'])
  })
})

describe('watching survives StrictMode', () => {
  it("each indicator is watched once through StrictMode's detach and re-attach, and nothing is left after unmount", () => {
    ;(HTMLElement.prototype as { animate?: unknown }).animate = function () {
      return { cancel() {}, pause() {}, play() {} }
    }
    const turn = createElement(TurnProgressContext.Provider, { value: { phase: 'tool_running' } satisfies TurnProgressState },
      createElement(MessageList, { messages: [ask(), reply('a1', thought('output-available', 'Running the tests first.'), bash('b1', 'npm test'))], status: 'streaming' }))
    act(() => root.render(createElement(StrictMode, null, turn, createElement(IconSpinner, { className: 'w-4 h-4 animate-spin shrink-0' }))))
    act(() => host.querySelector<HTMLButtonElement>('button.turn-live-toggle')!.click())
    const looping = [...host.querySelectorAll('.an-tool-icon[data-state="running"], svg.thinking-icon.is-thinking, .turn-progress-dots, .an-text-shimmer--active, span.turning')]
    expect(looping.length).toBeGreaterThanOrEqual(3)
    expect(offscreenWatchForTests()).toEqual({ elements: looping.length, observing: true })
    const io = watcherOf(looping[0]!)!
    for (const element of looping) expect(watcherOf(element)).toBe(io)
    expect(io.targets.size).toBe(looping.length)
    // Each still pauses and resumes.
    inView(looping, false)
    expect(looping.every(paused)).toBe(true)
    inView(looping, true)
    expect(looping.some(paused)).toBe(false)

    act(() => root.unmount())
    expect(offscreenWatchForTests()).toEqual({ elements: 0, observing: false })
    expect(io.disconnected).toBe(true)
    root = createRoot(host)
  })
})
