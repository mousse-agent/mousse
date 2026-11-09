// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIND_TYPING_DEBOUNCE_MS, FindInThreadBar } from '../src/renderer/chat/components/agent-elements/find/FindInThreadBar'
import { findBarHost, placeFindBar } from '../src/renderer/chat/components/agent-elements/find/find-bar-host'
import type { FindTurn } from '../src/renderer/chat/components/agent-elements/find/find-index'
import { FindRailButton } from '../src/renderer/chat/components/agent-elements/find/FindRailButton'
import { useThreadFind } from '../src/renderer/chat/components/agent-elements/find/use-thread-find'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** The thread pane as App lays it out: the transcript's pane, then the side card's layer. */
function threadPane(): { transcript: HTMLElement; layer: HTMLElement } {
  const pane = document.createElement('aside')
  pane.className = 'sidebar sidebar-full'
  pane.innerHTML =
    '<div class="keep-mounted-pane"><div class="an-message-list-wrap"><div class="an-message-list"></div></div></div>' +
    '<div class="thread-side-card-layer"><section class="thread-side-card" data-shown="true"></section></div>'
  document.body.append(pane)
  return { transcript: pane.querySelector('.an-message-list')!, layer: pane.querySelector('.thread-side-card-layer')! }
}

function Bar({ onQuery }: { onQuery: (query: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  return createElement(FindInThreadBar, {
    inputRef,
    query,
    onQueryChange: (next: string) => {
      onQuery(next)
      setQuery(next)
    },
    countLabel: '',
    hasMatches: false,
    onNext: () => undefined,
    onPrevious: () => undefined,
    onClose: () => undefined
  })
}

const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Find in thread"]')!
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('find bar placement', () => {
  it('goes into the side card layer of the thread pane, after the card', () => {
    const { transcript, layer } = threadPane()
    expect(findBarHost(transcript)).toBe(layer)
    act(() => root.render(placeFindBar(createElement(Bar, { onQuery: () => undefined }), findBarHost(transcript)) as never))
    expect(layer.lastElementChild?.getAttribute('role')).toBe('search')
    expect(host.querySelector('[role="search"]')).toBeNull()
  })

  it('stays with the transcript where there is no side card', () => {
    const transcript = document.createElement('div')
    document.body.append(transcript)
    expect(findBarHost(transcript)).toBeNull()
    act(() => root.render(placeFindBar(createElement(Bar, { onQuery: () => undefined }), null) as never))
    expect(host.querySelector('[role="search"]')).not.toBeNull()
  })
})

describe('find bar typing', () => {
  it('searches once typing pauses, at once when cleared, and at once on Enter', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    act(() => root.render(createElement(Bar, { onQuery: (query) => sent.push(query) })))
    type('r')
    type('re')
    type('ren')
    expect(sent).toEqual([])
    act(() => void vi.advanceTimersByTime(FIND_TYPING_DEBOUNCE_MS))
    expect(sent).toEqual(['ren'])
    type('rend')
    act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(sent).toEqual(['ren', 'rend'])
    act(() => void vi.advanceTimersByTime(FIND_TYPING_DEBOUNCE_MS))
    expect(sent).toEqual(['ren', 'rend'])
    type('')
    expect(sent).toEqual(['ren', 'rend', ''])
  })
})

const NO_TURNS: FindTurn[] = []

describe('the search button above the prompt rail', () => {
  /** A transcript with a find bar and the rail's search button, wired as MessageList wires them. */
  function Transcript() {
    const containerRef = useRef<HTMLDivElement>(null)
    const rowsRef = useRef<HTMLDivElement>(null)
    const find = useThreadFind({
      enabled: true,
      // Stable, as MessageList memoizes its turns.
      turns: NO_TURNS,
      isStreaming: false,
      containerRef,
      rowsRef,
      virtualization: { beginNavigation: () => ({}), cancelNavigation: () => undefined, scrollToKey: async () => true } as never,
      onNavigate: () => undefined,
      onProgrammaticScroll: () => undefined
    })
    return createElement(
      'div',
      null,
      createElement('textarea', { 'data-testid': 'composer' }),
      createElement('div', { ref: containerRef }, createElement('div', { ref: rowsRef })),
      find.openFind ? createElement(FindRailButton, { onOpen: find.openFind }) : null,
      find.barProps ? createElement(FindInThreadBar, find.barProps) : null
    )
  }

  it('opens find and focuses the field, and Escape gives focus back to what had it', async () => {
    act(() => root.render(createElement(Transcript)))
    const button = document.querySelector<HTMLButtonElement>('button.chat-prompt-find')!
    expect(button.getAttribute('aria-label')).toBe('Find in thread')
    expect(button.title).toMatch(/^Find in thread/)
    const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')!
    composer.focus()
    // A press does not move focus off the composer.
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    act(() => button.click())
    expect(document.querySelector('[role="search"]')).not.toBeNull()
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
    expect(document.activeElement).toBe(input())
    act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="search"]')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })
})

describe('the search button styles', () => {
  const css = readFileSync('src/renderer/styles/prompt-visibility.css', 'utf8')
  /** The declarations of the rule written exactly as `.an-message-list-wrap <selector> {`. */
  const rule = (selector: string) =>
    new RegExp(`\\.an-message-list-wrap ${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''

  it('hangs 2px above the tick column, so the ticks keep their place, and reserves only its own height', () => {
    expect(rule('.chat-prompt-find')).toMatch(/position: absolute;[^]*bottom: calc\(100% \+ 2px\);[^]*height: 18px;/)
    expect(rule('.chat-prompt-column:has(> .chat-prompt-find)')).toMatch(/max-height: calc\(100% - 20px\);/)
    // The larger hit area reaches up and out, not down toward the ticks.
    expect(rule('.chat-prompt-find::before')).toMatch(/inset: -5px -5px 0;/)
  })

  it('is hidden until the pointer is over the rail or the button has keyboard focus', () => {
    expect(rule('.chat-prompt-find')).toMatch(/opacity: 0;/)
    expect(rule('.chat-prompt-find')).toMatch(/opacity calc\(120ms \* var\(--ui-motion-scale, 1\)\)/)
    expect(rule('.chat-prompt-rail:hover .chat-prompt-find')).toMatch(/opacity: 0\.7;/)
    expect(rule('.chat-prompt-rail .chat-prompt-find:focus-visible')).toMatch(/opacity: 1;/)
    // On the button itself it comes up fully: the button's own rule outranks the rail's hover.
    expect(rule('.chat-prompt-rail .chat-prompt-find:hover')).toMatch(/opacity: 1;/)
    expect(css.indexOf('.chat-prompt-rail .chat-prompt-find:hover {')).toBeGreaterThan(css.indexOf('.chat-prompt-rail:hover .chat-prompt-find {'))
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.an-message-list-wrap \.chat-prompt-find \{\s*transition: none;/)
  })

  it('has a background only on hover', () => {
    expect(rule('.chat-prompt-rail .chat-prompt-find:hover')).toMatch(/background: var\(--ui-hover\);/)
    expect(rule('.chat-prompt-find')).toMatch(/background: transparent;/)
  })
})
