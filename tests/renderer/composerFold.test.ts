// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_FOLD_DISTANCE,
  nextComposerCompact
} from '../../src/renderer/chat/components/agent-elements/virtual/follow-mode'
import { COMPOSER_FOLD_MOTION_MS, useComposerFold } from '../../src/renderer/chat/components/agent-elements/composer-fold'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('nextComposerCompact', () => {
  it('unfolds whenever the list follows the end', () => {
    expect(nextComposerCompact(true, { mode: 'following-end', distanceFromEnd: 5000 })).toBe(false)
    expect(nextComposerCompact(false, { mode: 'following-end', distanceFromEnd: 0 })).toBe(false)
  })

  it('folds once the reader is past the fold distance', () => {
    expect(nextComposerCompact(false, { mode: 'free', distanceFromEnd: COMPOSER_FOLD_DISTANCE + 1 })).toBe(true)
  })

  it('keeps its state near the end, so a first wheel tick does not fold it', () => {
    // Scrolling up one tick leaves the end: free, but only a few px away.
    expect(nextComposerCompact(false, { mode: 'free', distanceFromEnd: 12 })).toBe(false)
    expect(nextComposerCompact(false, { mode: 'free', distanceFromEnd: COMPOSER_FOLD_DISTANCE })).toBe(false)
    // Coming back down, it stays folded until the list follows the end again.
    expect(nextComposerCompact(true, { mode: 'free', distanceFromEnd: 90 })).toBe(true)
  })

  it('folds far enough out that giving back the composer height cannot unfold it', () => {
    // The fold returns ~30px of padding; the follow threshold is 80px.
    expect(COMPOSER_FOLD_DISTANCE - 30).toBeGreaterThan(80)
  })
})

let root: Root
let host: HTMLElement
let reduced = false
let api: ReturnType<typeof useComposerFold>

function Probe() {
  api = useComposerFold()
  return createElement('div', {
    'data-testid': 'shell',
    'data-composer-compact': api.compact || undefined,
    'data-composer-motion': api.motion || undefined
  })
}

const shell = () => host.querySelector('[data-testid="shell"]')!

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reduced,
    media: query,
    addEventListener() {},
    removeEventListener() {}
  })) as unknown as typeof window.matchMedia
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useComposerFold', () => {
  it('starts unfolded and still', () => {
    expect(shell().hasAttribute('data-composer-compact')).toBe(false)
    expect(shell().hasAttribute('data-composer-motion')).toBe(false)
  })

  it('marks a fold change for animation, in the same render, then clears the mark', () => {
    act(() => api.onCompactChange(true))
    expect(shell().hasAttribute('data-composer-compact')).toBe(true)
    expect(shell().hasAttribute('data-composer-motion')).toBe(true)
    act(() => { vi.advanceTimersByTime(COMPOSER_FOLD_MOTION_MS) })
    expect(shell().hasAttribute('data-composer-compact')).toBe(true)
    expect(shell().hasAttribute('data-composer-motion')).toBe(false)

    act(() => api.onCompactChange(false))
    expect(shell().hasAttribute('data-composer-compact')).toBe(false)
    expect(shell().hasAttribute('data-composer-motion')).toBe(true)
  })

  it('restarts the mark when the state flips again mid-animation', () => {
    act(() => api.onCompactChange(true))
    act(() => { vi.advanceTimersByTime(COMPOSER_FOLD_MOTION_MS - 60) })
    act(() => api.onCompactChange(false))
    act(() => { vi.advanceTimersByTime(100) })
    expect(shell().hasAttribute('data-composer-motion')).toBe(true)
    act(() => { vi.advanceTimersByTime(COMPOSER_FOLD_MOTION_MS) })
    expect(shell().hasAttribute('data-composer-motion')).toBe(false)
  })

  it('ignores a report that does not change the state', () => {
    act(() => api.onCompactChange(false))
    expect(shell().hasAttribute('data-composer-motion')).toBe(false)
  })

  it('switches at once with reduced motion', () => {
    reduced = true
    act(() => api.onCompactChange(true))
    expect(shell().hasAttribute('data-composer-compact')).toBe(true)
    expect(shell().hasAttribute('data-composer-motion')).toBe(false)
  })
})

describe('composer fold styles', () => {
  let style: HTMLStyleElement
  let chat: HTMLElement

  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = readFileSync(join(__dirname, '../../src/renderer/styles/compact-composer.css'), 'utf8')
    document.head.append(style)
    chat = document.createElement('div')
    chat.className = 'mousse-chat-shell'
    chat.innerHTML = '<div class="chat-input-area"><div class="composer"><div class="composer-input-wrap"><textarea class="composer-input" placeholder="Ask"></textarea></div></div></div>'
    document.body.append(chat)
  })

  afterEach(() => {
    style.remove()
    chat.remove()
  })

  const input = () => chat.querySelector<HTMLTextAreaElement>('.composer-input')!

  it('hides the input scrollbar while the height animates', () => {
    chat.setAttribute('data-composer-motion', 'true')
    expect(getComputedStyle(input()).overflowY).toBe('hidden')
  })

  it('leaves the expanded input scrollable when nothing animates', () => {
    expect(getComputedStyle(input()).overflowY).not.toBe('hidden')
  })
})
