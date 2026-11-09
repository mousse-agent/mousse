// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotLookPicker, shuffleLook } from '../../src/renderer/components/bots/face/BotLookPicker'
import { resetSharedFaceRenderer } from '../../src/renderer/components/bots/face/faceRenderer'
import { BOT_ACCESSORIES, BOT_COLOURS, BOT_EYES, BOT_KINDS, type BotLook } from '../../src/shared/bots/personal/look'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  // No WebGL in jsdom: every face is the still fallback.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetSharedFaceRenderer()
  vi.restoreAllMocks()
})

function renderPicker(look: BotLook, existingLooks?: BotLook[]) {
  const onChange = vi.fn()
  act(() => root.render(createElement(BotLookPicker, { look, onChange, existingLooks })))
  return onChange
}

/** The picker's groups: colours, accessories, characters and eyes. */
const groups = () => ['colours', 'accessories', 'kinds', 'eyes'].map((name) => host.querySelector(`.bot-look-picker__${name}[role="radiogroup"]`))
const radios = (group: Element) => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const checked = (group: Element) => radios(group).find((radio) => radio.getAttribute('aria-checked') === 'true')

describe('BotLookPicker', () => {
  it('shows a large preview, 8 colours and 12 accessories, each on the mouse', () => {
    renderPicker({ colour: 'teal', accessory: 'headphones' })
    const preview = host.querySelector('.bot-look-picker__preview .bot-face')!
    expect(preview.getAttribute('data-view')).toBe('full')
    expect(preview.getAttribute('width')).toBe('112')
    expect(preview.getAttribute('aria-label')).toBe('Teal mouse with headphones')
    const [colours, accessories] = groups()
    expect(radios(colours!).map((radio) => radio.dataset.value)).toEqual([...BOT_COLOURS])
    expect(radios(accessories!).map((radio) => radio.dataset.value)).toEqual([...BOT_ACCESSORIES])
    for (const radio of radios(accessories!)) {
      const face = radio.querySelector('.bot-face')!
      expect(face.getAttribute('data-colour')).toBe('teal')
      expect(face.getAttribute('data-accessory')).toBe(radio.dataset.value)
      expect(face.getAttribute('data-view')).toBe('head')
    }
    expect(radios(accessories!)[9]!.querySelector('span')?.textContent).toBe('Scarf')
    expect(checked(colours!)?.getAttribute('aria-label')).toBe('Teal')
    expect(checked(accessories!)?.getAttribute('aria-label')).toBe('Headphones')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Shuffle')).toBe(true)
  })

  it('picks a colour or an accessory and keeps the other', () => {
    const onChange = renderPicker({ colour: 'teal', accessory: 'headphones' })
    const [colours, accessories] = groups()
    act(() => radios(colours!).find((radio) => radio.dataset.value === 'purple')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'purple', accessory: 'headphones' })
    act(() => radios(accessories!).find((radio) => radio.dataset.value === 'chef_hat')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'teal', accessory: 'chef_hat' })
  })

  it('shows unknown stored values as the default', () => {
    const onChange = renderPicker({ colour: 'mauve', accessory: 'monocle' })
    const [colours, accessories] = groups()
    expect(checked(colours!)?.dataset.value).toBe('coral')
    expect(checked(accessories!)?.dataset.value).toBe('none')
    expect(host.querySelector('.bot-look-picker__preview .bot-face')?.getAttribute('aria-label')).toBe('Coral mouse')
    act(() => radios(colours!).find((radio) => radio.dataset.value === 'blue')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'blue', accessory: 'none' })
  })

  it('moves the pick with the arrow keys, one tab stop per group', () => {
    const onChange = renderPicker({ colour: 'coral', accessory: 'none' })
    const [colours] = groups()
    expect(radios(colours!).filter((radio) => radio.tabIndex === 0)).toHaveLength(1)
    act(() => colours!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'pink', accessory: 'none' })
    act(() => colours!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'orange', accessory: 'none' })
  })

  it('shuffles to a different look that the other bots do not wear', () => {
    const current = { colour: 'coral', accessory: 'none' }
    const existing = BOT_COLOURS.flatMap((colour) => BOT_ACCESSORIES.map((accessory) => ({ colour, accessory })))
      .filter((look) => !(look.colour === 'green' && look.accessory === 'crown'))
    const onChange = renderPicker(current, existing)
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Shuffle')!.click())
    expect(onChange).toHaveBeenCalledWith({ colour: 'green', accessory: 'crown' })
  })

  it('picks a character and eye shape, each shown on the look, and keeps the rest', () => {
    const onChange = renderPicker({ colour: 'purple', accessory: 'glasses' })
    const [, , kinds, eyes] = groups()
    expect(radios(kinds!).map((radio) => radio.dataset.value)).toEqual([...BOT_KINDS])
    expect(radios(eyes!).map((radio) => radio.dataset.value)).toEqual([...BOT_EYES])
    expect(checked(kinds!)?.getAttribute('aria-label')).toBe('Mouse')
    expect(checked(eyes!)?.getAttribute('aria-label')).toBe('Pill eyes')
    for (const radio of radios(kinds!)) {
      const face = radio.querySelector('.bot-face')!
      expect(face.getAttribute('data-kind')).toBe(radio.dataset.value)
      expect(face.getAttribute('data-accessory')).toBe('glasses')
    }
    act(() => radios(kinds!).find((radio) => radio.dataset.value === 'mousse')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'purple', accessory: 'glasses', kind: 'mousse' })
    act(() => radios(eyes!).find((radio) => radio.dataset.value === 'star')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'purple', accessory: 'glasses', eyes: 'star' })
  })

  it('names a Mousse with its eyes and accessory, and draws the default pieces without stored fields', () => {
    const onChange = renderPicker({ colour: 'pink', accessory: 'crown', kind: 'mousse', eyes: 'heart' })
    const [colours, , kinds, eyes] = groups()
    expect(host.querySelector('.bot-look-picker__preview .bot-face')?.getAttribute('aria-label')).toBe('Pink Mousse with heart eyes and crown')
    expect(checked(kinds!)?.dataset.value).toBe('mousse')
    expect(checked(eyes!)?.dataset.value).toBe('heart')
    act(() => radios(colours!).find((radio) => radio.dataset.value === 'blue')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'blue', accessory: 'crown', kind: 'mousse', eyes: 'heart' })
    act(() => radios(kinds!).find((radio) => radio.dataset.value === 'mouse')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ colour: 'pink', accessory: 'crown', eyes: 'heart' })
  })
})

describe('shuffleLook', () => {
  it('never returns the current look', () => {
    for (const r of [0, 0.25, 0.5, 0.999]) expect(shuffleLook({ colour: 'coral', accessory: 'none' }, [], () => r)).not.toEqual({ colour: 'coral', accessory: 'none' })
  })

  it('keeps the character and eyes', () => {
    const picked = shuffleLook({ colour: 'coral', accessory: 'none', kind: 'mousse', eyes: 'heart' }, [], () => 0.5)
    expect(picked.kind).toBe('mousse')
    expect(picked.eyes).toBe('heart')
  })

  it('falls back to any other look when all are worn', () => {
    const all = BOT_COLOURS.flatMap((colour) => BOT_ACCESSORIES.map((accessory) => ({ colour, accessory })))
    const picked = shuffleLook({ colour: 'blue', accessory: 'cap' }, all, () => 0.5)
    expect(picked).not.toEqual({ colour: 'blue', accessory: 'cap' })
    expect(BOT_COLOURS).toContain(picked.colour)
  })
})
