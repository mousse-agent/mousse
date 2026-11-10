// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmbientGlow } from '../../src/renderer/components/AmbientGlow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom replaces URL, so paths are resolved from this file's folder.
const source = (path: string) => readFileSync(resolve(__dirname, '../../src/renderer', path), 'utf8').replace(/\r\n/g, '\n')
const read = (name: string) => source(`styles/${name}`)
const glowCss = read('ambient-glow.css')
const logoCss = read('empty-logo.css')
const glassesCss = read('incognito.css')

/** The text from `start` to the brace that closes the block opened after it. */
function block(css: string, start: string): string {
  const at = css.indexOf(start)
  expect(at, start).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let index = open; index < css.length; index++) {
    if (css[index] === '{') depth++
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index)
  }
  throw new Error(`unclosed block: ${start}`)
}

/** The property names set by every keyframe of `@keyframes name`. */
function keyframeProperties(css: string, name: string): string[] {
  const frames = block(css, `@keyframes ${name} {`)
  const declarations = [...frames.matchAll(/\{([^{}]*)\}/g)].flatMap((frame) => frame[1]!.split(';'))
  // A linear(...) easing holds commas and percents but no colon after its own name, so the first colon is the property's.
  return [...new Set(declarations.map((declaration) => declaration.split(':')[0]!.trim()).filter(Boolean))]
}

describe('the ambient glow while the window is not focused', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function mount(focused: boolean) {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
    const chat = document.body.appendChild(document.createElement('div'))
    chat.className = 'chat chat--empty'
    root = createRoot(chat)
    act(() => root!.render(createElement(AmbientGlow)))
    const set = (next: boolean) => act(() => {
      focus.mockReturnValue(next)
      window.dispatchEvent(new Event(next ? 'focus' : 'blur'))
    })
    return { chat, set }
  }

  it('draws two wave layers in a box that is hidden from assistive technology', () => {
    const { chat } = mount(true)
    expect(chat.querySelectorAll('.ambient-glow[aria-hidden="true"] > .ambient-glow-wave')).toHaveLength(2)
    expect(chat.hasAttribute('data-ambient-rest')).toBe(false)
  })

  it('rests on blur and moves again on focus', () => {
    const { chat, set } = mount(true)
    set(false)
    expect(chat.hasAttribute('data-ambient-rest')).toBe(true)
    set(true)
    expect(chat.hasAttribute('data-ambient-rest')).toBe(false)
  })

  it('starts at rest in a window that is already unfocused, and clears the mark when the glow goes', () => {
    const { chat } = mount(false)
    expect(chat.hasAttribute('data-ambient-rest')).toBe(true)
    act(() => root!.unmount())
    root = undefined
    expect(chat.hasAttribute('data-ambient-rest')).toBe(false)
  })

  it('holds the waves, the rim and the swirl while resting', () => {
    const rest = glowCss.slice(glowCss.indexOf('.app .chat--empty[data-ambient-rest] .ambient-glow-wave'))
    const selectors = rest.slice(0, rest.indexOf('{'))
    expect(selectors).toContain('.chat--empty[data-ambient-rest] .chat-input-area .composer::before')
    expect(selectors).toContain('.chat--empty[data-ambient-rest] .chat-input-area .composer::after')
    expect(block(rest, '.app .chat--empty[data-ambient-rest] .ambient-glow-wave')).toContain('animation-play-state: paused')
    expect(block(logoCss, '.chat--empty[data-ambient-rest] .empty-logo-swirl {')).toContain('animation-play-state: paused')
  })
})

describe('the idle start page costs no layout or paint', () => {
  it.each([
    [glowCss, 'ambient-glow-a'],
    [glowCss, 'ambient-glow-b'],
    [glowCss, 'ambient-glow-rim-a'],
    [glowCss, 'ambient-glow-rim-b'],
    [logoCss, 'empty-logo-wobble']
  ] as const)('%#: %s animates only transform and opacity', (css, name) => {
    const properties = keyframeProperties(css, name).filter((property) => property !== 'animation-timing-function')
    expect(properties.length).toBeGreaterThan(0)
    for (const property of properties) expect(['transform', 'opacity']).toContain(property)
  })

  it('never animates the box that is anchored to the composer', () => {
    // An anchored box is styled during layout: an animation on it lays out the chat on every frame.
    const box = block(glowCss, '.app .chat--empty .ambient-glow {')
    expect(box).toContain('position-anchor: --ambient-glow-composer')
    expect(box).not.toMatch(/animation|transition|will-change/)
    const wave = block(glowCss, '.app .chat--empty .ambient-glow-wave {')
    expect(wave).not.toMatch(/anchor/)
    expect(wave).toContain('will-change: transform, opacity')
    expect(glowCss).not.toMatch(/\.chat--empty::(before|after)/)
  })

  it('uses bitmap masks, with no SVG filter to run again', () => {
    expect(glowCss).not.toMatch(/data:image\/svg|feTurbulence|feDisplacementMap/)
    expect(glowCss).toContain('url("../assets/ambient-glow-a.png")')
    expect(glowCss).toContain('url("../assets/ambient-glow-b.png")')
  })

  it('moves in steps: no loop eases on every screen refresh', () => {
    const loops = [
      block(glowCss, '.app .chat--empty .ambient-glow-wave {'),
      block(glowCss, '.app .chat--empty .chat-input-area .composer::before,\n.app .chat--empty .chat-input-area .composer::after {'),
      block(logoCss, '.empty-logo[data-drawn] .empty-logo-swirl {'),
      block(logoCss, '.empty-logo-liquid[data-filled] .empty-logo-wave {'),
      block(glassesCss, '.incognito-glasses[data-on] .incognito-glasses-shine {')
    ].map((rule) => /animation: ([^;]*infinite);/.exec(rule)?.[1])
    for (const loop of loops) {
      expect(loop).toBeTruthy()
      expect(loop).toMatch(/var\(--ambient-glow-ease\)|var\(--empty-logo-wobble-ease\)|steps\(\d+\)/)
      // Outside the stepped curves' names, no smooth easing is left.
      expect(loop!.replace(/var\([^)]*\)/g, '')).not.toMatch(/ease|cubic-bezier|linear/)
    }
    // Each stepped curve is plateaus only: every stop names a value and the two ends of its step.
    for (const [css, name] of [[glowCss, '--ambient-glow-ease'], [logoCss, '--empty-logo-wobble-ease']] as const) {
      const stops = new RegExp(`${name}: linear\\(([^)]*)\\)`).exec(css)![1]!.split(', ')
      expect(stops.length).toBeGreaterThanOrEqual(24)
      for (const stop of stops) expect(stop).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/)
    }
  })

  it('keeps the logo swirl outside the SVG, so its sway moves a layer', () => {
    const logo = source('components/EmptyThreadLogo.tsx')
    expect(logo).toContain('<div className="empty-logo-swirl">')
    expect(logo).not.toContain('<g className="empty-logo-swirl">')
  })
})

describe('reduced motion and Animation speed Off', () => {
  it('stops the glow and the rim', () => {
    const reduced = block(glowCss, '@media (prefers-reduced-motion: reduce) {')
    for (const selector of ['.app .chat--empty .ambient-glow-wave', '.composer::before', '.composer::after']) expect(reduced).toContain(selector)
    expect(reduced).toContain('animation: none')
    // Off scales the loop to 0s, which leaves each layer at its resting style.
    expect(block(glowCss, '.app .chat--empty {')).toContain('--ambient-glow-loop: calc(18s * var(--ui-motion-scale, 1))')
  })

  it('stops the swirl, the liquid and the tilt', () => {
    const reduced = block(logoCss, '@media (prefers-reduced-motion: reduce) {')
    for (const selector of ['.empty-logo-art *', '.empty-logo-swirl', '.empty-logo-tilt']) expect(reduced).toContain(selector)
    expect(reduced).toContain('animation: none !important')
    expect(reduced).toContain('transform: none')
    const off = logoCss.slice(logoCss.indexOf("[data-motion='off'] .empty-logo-art *"))
    expect(off.slice(0, off.indexOf('{'))).toContain("[data-motion='off'] .empty-logo-swirl")
  })

  it('stops the glint on the sunglasses', () => {
    expect(block(glassesCss, '@media (prefers-reduced-motion: reduce) {')).toMatch(/\.incognito-glasses-shine \{\s*animation: none/)
  })
})
