// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCENT_COLORS,
  FROSTED_COMPOSER_RANGES,
  THEME_OPTIONS,
  clampFrostedComposer,
  getDefaultSettings,
  normalizeAppearance
} from '../../src/shared/settings'
import { applyFrostedComposer, createFrostedComposerSaver } from '../../src/renderer/lib/frostedComposer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const root = () => document.documentElement
const VARS = ['--frosted-composer-alpha', '--frosted-composer-blur', '--frosted-composer-saturate']

afterEach(() => {
  root().removeAttribute('data-frosted-composer')
  for (const name of VARS) root().style.removeProperty(name)
})

describe('frosted composer setting', () => {
  it('is off by default at 60% opacity, 16px blur and 1.12 color boost', () => {
    expect(getDefaultSettings().appearance).toMatchObject({
      frostedComposer: false,
      frostedComposerOpacity: 60,
      frostedComposerBlur: 16,
      frostedComposerSaturation: 1.12
    })
  })

  it('reads settings saved before it existed as the defaults', () => {
    const legacy = { theme: 'dark', accentColor: '#3b82f6', acrylic: false, acrylicIntensity: 50 } as const
    expect(normalizeAppearance(legacy)).toMatchObject({
      frostedComposer: false,
      frostedComposerOpacity: 60,
      frostedComposerBlur: 16,
      frostedComposerSaturation: 1.12
    })
  })

  it('keeps saved values and clamps, steps or replaces bad ones', () => {
    expect(normalizeAppearance({
      frostedComposer: true,
      frostedComposerOpacity: 80,
      frostedComposerBlur: 24,
      frostedComposerSaturation: 1.3
    })).toMatchObject({ frostedComposer: true, frostedComposerOpacity: 80, frostedComposerBlur: 24, frostedComposerSaturation: 1.3 })
    expect(normalizeAppearance({ frostedComposer: 'yes' as never }).frostedComposer).toBe(false)

    expect(clampFrostedComposer('frostedComposerOpacity', 5)).toBe(FROSTED_COMPOSER_RANGES.frostedComposerOpacity.min)
    expect(clampFrostedComposer('frostedComposerOpacity', 300)).toBe(FROSTED_COMPOSER_RANGES.frostedComposerOpacity.max)
    expect(clampFrostedComposer('frostedComposerOpacity', 61.6)).toBe(62)
    expect(clampFrostedComposer('frostedComposerBlur', -4)).toBe(0)
    expect(clampFrostedComposer('frostedComposerBlur', '12')).toBe(12)
    expect(clampFrostedComposer('frostedComposerBlur', '')).toBe(16)
    expect(clampFrostedComposer('frostedComposerBlur', null)).toBe(16)
    expect(clampFrostedComposer('frostedComposerSaturation', 1.131)).toBe(1.14)
    expect(clampFrostedComposer('frostedComposerSaturation', 0.5)).toBe(1)
    expect(clampFrostedComposer('frostedComposerSaturation', 9)).toBe(1.6)
    expect(clampFrostedComposer('frostedComposerSaturation', Number.NaN)).toBe(1.12)
  })
})

describe('applyFrostedComposer', () => {
  it('sets the attribute and the vars when on', () => {
    applyFrostedComposer({ frostedComposer: true, frostedComposerOpacity: 45, frostedComposerBlur: 20, frostedComposerSaturation: 1.4 })
    expect(root().getAttribute('data-frosted-composer')).toBe('true')
    expect(root().style.getPropertyValue('--frosted-composer-alpha')).toBe('0.45')
    expect(root().style.getPropertyValue('--frosted-composer-blur')).toBe('20px')
    expect(root().style.getPropertyValue('--frosted-composer-saturate')).toBe('1.4')
  })

  it('clamps out-of-range values', () => {
    applyFrostedComposer({ frostedComposer: true, frostedComposerOpacity: 500, frostedComposerBlur: 999, frostedComposerSaturation: 0 })
    expect(root().style.getPropertyValue('--frosted-composer-alpha')).toBe('0.95')
    expect(root().style.getPropertyValue('--frosted-composer-blur')).toBe('40px')
    expect(root().style.getPropertyValue('--frosted-composer-saturate')).toBe('1')
  })

  it('removes the attribute and every var when off', () => {
    applyFrostedComposer({ frostedComposer: true, frostedComposerOpacity: 60, frostedComposerBlur: 16, frostedComposerSaturation: 1.12 })
    applyFrostedComposer({ frostedComposer: false, frostedComposerOpacity: 60, frostedComposerBlur: 16, frostedComposerSaturation: 1.12 })
    expect(root().hasAttribute('data-frosted-composer')).toBe(false)
    for (const name of VARS) expect(root().style.getPropertyValue(name)).toBe('')
  })
})

describe('frosted composer saving', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('saves two sliders moved within the delay together', async () => {
    const save = vi.fn(async (patch: object) => patch)
    const saved = vi.fn()
    const saver = createFrostedComposerSaver(save, saved)
    saver.queue('frostedComposerOpacity', 40)
    await vi.advanceTimersByTimeAsync(60)
    saver.queue('frostedComposerBlur', 30)
    await vi.advanceTimersByTimeAsync(120)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ frostedComposerOpacity: 40, frostedComposerBlur: 30 })
    expect(saved).toHaveBeenCalledWith({ frostedComposerOpacity: 40, frostedComposerBlur: 30 })
  })

  it('saves the pending value when Settings closes before the delay', async () => {
    const save = vi.fn(async (patch: object) => patch)
    const saved = vi.fn()
    const saver = createFrostedComposerSaver(save, saved)
    saver.queue('frostedComposerSaturation', 1.3)
    saver.dispose()
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ frostedComposerSaturation: 1.3 })
    expect(saved).not.toHaveBeenCalled()
  })

  it('ignores a reply that would undo a newer value', async () => {
    let finish: (value: object) => void = () => undefined
    const save = vi.fn((patch: object) => new Promise<object>((done) => { finish = () => done(patch) }))
    const saved = vi.fn()
    const saver = createFrostedComposerSaver(save, saved)
    saver.queue('frostedComposerBlur', 10)
    await vi.advanceTimersByTimeAsync(120)
    saver.queue('frostedComposerBlur', 20)
    finish({})
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120)
    expect(save).toHaveBeenLastCalledWith({ frostedComposerBlur: 20 })
  })
})

describe('frosted composer styles', () => {
  const polish = readFileSync(join(process.cwd(), 'src/renderer/styles/polish.css'), 'utf8').replace(/\r\n/g, '\n')
  const app = readFileSync(join(process.cwd(), 'src/renderer/styles/app.css'), 'utf8').replace(/\r\n/g, '\n')

  it('blurs the composer only under the attribute', () => {
    const rules = [...(polish + app).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    const blurring = rules.filter(([, selector, body]) => selector.includes('composer') && /backdrop-filter:\s*blur\(/.test(body))
    expect(blurring.length).toBeGreaterThan(0)
    for (const [, selector] of blurring) {
      for (const part of selector.split(',')) expect(part.trim()).toMatch(/^html\[data-frosted-composer='true'\]/)
    }
    expect(polish).toMatch(/rgba\(var\(--surface-soft-rgb\), var\(--frosted-composer-alpha/)
  })

  it('keeps the transcript fade when off and ends the transcript at the composer when on', () => {
    expect(polish).toMatch(/\n\.chat:not\(\.chat--empty\) \.an-message-list \{\n  --transcript-mask:/)
    expect(polish).toMatch(/html\[data-frosted-composer='true'\] \.chat:not\(\.chat--empty\) \.an-message-list \{\n  --transcript-mask:[^}]*calc\(100% - var\(--chat-composer-gap\)\)/)
    expect(polish).toMatch(/padding-bottom: var\(--chat-composer-gap\)/)
  })
})

describe('Settings › Appearance › Frosted composer', () => {
  let view: Root
  let host: HTMLElement
  let home: string

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    view = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-frosted-composer-'))
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin' }
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    act(() => view.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  it('shows the sliders only when on, previews and saves them, and survives a reload', async () => {
    const { AppearanceSettings } = await import('../../src/renderer/components/settings/AppearanceSettings')
    const { applyAppearance } = await import('../../src/renderer/hooks/useTheme')
    const { MousseConfigStore } = await import('../../src/mms/config/MousseConfigStore')
    const { SettingsStore } = await import('../../src/mms/settings/SettingsStore')
    const store = new SettingsStore(MousseConfigStore.load(home))
    const preview = vi.fn()
    const commit = vi.fn((key: string, value: number) => { store.set({ appearance: { [key]: value } } as never) })
    const draw = () => act(() => view.render(createElement(AppearanceSettings, {
      settings: store.get(),
      options: { themes: THEME_OPTIONS, accentColors: ACCENT_COLORS, llmProviders: [], agentTypes: [] },
      onUpdate: async (partial) => { store.set(partial); applyAppearance(store.get().appearance); draw() },
      restartRequired: false,
      onRestart: () => undefined,
      onPreviewAcrylicIntensity: () => undefined,
      onCommitAcrylicIntensity: () => undefined,
      onPreviewFrostedComposer: preview,
      onCommitFrostedComposer: commit
    })))
    draw()
    applyAppearance(store.get().appearance)

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Frosted composer"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.closest('.settings-item')?.querySelector('[title]')?.getAttribute('title')).toMatch(/graphics memory/)
    expect(host.querySelector('#frosted-composer-opacity')).toBeNull()
    expect(root().hasAttribute('data-frosted-composer')).toBe(false)

    await act(async () => { toggle.click() })
    expect(store.get().appearance.frostedComposer).toBe(true)
    expect(root().getAttribute('data-frosted-composer')).toBe('true')

    const sliders = [...host.querySelectorAll<HTMLInputElement>('input[type="range"][id^="frosted-composer-"]')]
    expect(sliders.map((slider) => slider.closest('.settings-item')?.querySelector('.settings-item-title')?.textContent))
      .toEqual(['Opacity', 'Blur', 'Color boost'])
    expect(sliders.map((slider) => [slider.min, slider.max, slider.value])).toEqual([
      ['20', '95', '60'],
      ['0', '40', '16'],
      ['1', '1.6', '1.12']
    ])
    expect(sliders.map((slider) => slider.nextElementSibling?.textContent)).toEqual(['60%', '16px', '12%'])

    const blur = sliders[1]
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(blur, '28')
      blur.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(preview).toHaveBeenLastCalledWith('frostedComposerBlur', 28)
    expect(commit).toHaveBeenLastCalledWith('frostedComposerBlur', 28)

    const reloaded = new SettingsStore(MousseConfigStore.load(home))
    expect(reloaded.get().appearance).toMatchObject({ frostedComposer: true, frostedComposerBlur: 28, frostedComposerOpacity: 60 })
  })
})
