// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENT_COLORS, getDefaultSettings, normalizeAppearance, THEME_OPTIONS, type AnimationSpeed } from '../../src/shared/settings'

// A native <select> stands in for ui/Select so the test can pick an option.
vi.mock('../../src/renderer/components/ui/Select', () => ({
  Select: ({ value, options, ariaLabel, onChange }: {
    value: string
    options: { value: string; label: unknown }[]
    ariaLabel?: string
    onChange: (value: string) => void
  }) => createElement('select', {
    'aria-label': ariaLabel,
    value,
    onChange: (event: { currentTarget: HTMLSelectElement }) => onChange(event.currentTarget.value)
  }, options.map((option) => createElement('option', { key: option.value, value: option.value }, option.label as string)))
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** Installs a controllable prefers-reduced-motion query and loads a fresh motion module. */
async function loadMotion(reduced = false) {
  let matches = reduced
  const listeners = new Set<() => void>()
  window.matchMedia = vi.fn((query: string) => ({
    get matches() { return query === '(prefers-reduced-motion: reduce)' ? matches : false },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
  })) as unknown as typeof window.matchMedia
  vi.resetModules()
  const motion = await import('../../src/renderer/lib/motion')
  const setReduced = (next: boolean) => {
    matches = next
    for (const listener of listeners) listener()
  }
  return { ...motion, setReduced }
}

const root = () => document.documentElement

afterEach(() => {
  root().removeAttribute('data-motion')
  root().style.removeProperty('--ui-motion-scale')
})

describe('animation speed setting', () => {
  it('defaults to Normal and keeps only a known speed', () => {
    expect(getDefaultSettings().appearance.animationSpeed).toBe('normal')
    expect(normalizeAppearance({}).animationSpeed).toBe('normal')
    expect(normalizeAppearance({ animationSpeed: 'off' }).animationSpeed).toBe('off')
    expect(normalizeAppearance({ animationSpeed: 'slow' }).animationSpeed).toBe('slow')
    expect(normalizeAppearance({ animationSpeed: 'warp' as AnimationSpeed }).animationSpeed).toBe('normal')
  })
})

describe('motion helper', () => {
  it('returns 0 / 0.6 / 1 / 1.6 and sets the variable and attribute on <html>', async () => {
    const motion = await loadMotion()
    const cases: [AnimationSpeed, number][] = [['off', 0], ['fast', 0.6], ['normal', 1], ['slow', 1.6]]
    for (const [speed, scale] of cases) {
      motion.setAnimationSpeed(speed)
      expect(motion.motionScale()).toBe(scale)
      expect(motion.motionOff()).toBe(scale === 0)
      expect(root().style.getPropertyValue('--ui-motion-scale')).toBe(String(scale))
      expect(root().getAttribute('data-motion')).toBe(scale === 0 ? 'off' : null)
    }
    motion.setAnimationSpeed('slow')
    expect(motion.scaleMotionMs(250)).toBe(400)
    motion.setAnimationSpeed('fast')
    expect(motion.scaleMotionMs(250)).toBe(150)
  })

  it('treats an unknown speed as Normal', async () => {
    const motion = await loadMotion()
    motion.setAnimationSpeed('warp' as AnimationSpeed)
    expect(motion.motionScale()).toBe(1)
  })

  it('turns motion off while the OS reduces motion, whatever the speed', async () => {
    const motion = await loadMotion(true)
    expect(motion.motionScale()).toBe(0)
    motion.setAnimationSpeed('slow')
    expect(motion.motionScale()).toBe(0)
    expect(root().getAttribute('data-motion')).toBe('off')
    expect(root().style.getPropertyValue('--ui-motion-scale')).toBe('0')

    motion.setReduced(false)
    expect(motion.motionScale()).toBe(1.6)
    expect(root().getAttribute('data-motion')).toBeNull()
    expect(root().style.getPropertyValue('--ui-motion-scale')).toBe('1.6')

    motion.setReduced(true)
    expect(root().getAttribute('data-motion')).toBe('off')
  })

  it('stretches the side card exit wait when slow and never shortens it', async () => {
    const motion = await loadMotion()
    const { sideCardFadeMs } = await import('../../src/renderer/components/sideCard/sideCardPresence')
    motion.setAnimationSpeed('slow')
    expect(sideCardFadeMs()).toBe(288)
    motion.setAnimationSpeed('fast')
    expect(sideCardFadeMs()).toBe(180)
    motion.setAnimationSpeed('off')
    expect(sideCardFadeMs()).toBe(180)
  })
})

describe('Settings › General › Advanced', () => {
  let view: Root
  let host: HTMLElement
  let home: string

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    view = createRoot(host)
    home = mkdtempSync(join(tmpdir(), 'mousse-animation-speed-'))
    // applyAppearance reads the platform for the window material.
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin' }
  })

  afterEach(() => {
    act(() => view.unmount())
    host.remove()
    rmSync(home, { recursive: true, force: true })
  })

  it('saves the picked speed, which survives a reload and drives <html>', async () => {
    await loadMotion()
    const { AppearanceSettings } = await import('../../src/renderer/components/settings/AppearanceSettings')
    const { applyAppearance } = await import('../../src/renderer/hooks/useTheme')
    const { MousseConfigStore } = await import('../../src/mms/config/MousseConfigStore')
    const { SettingsStore } = await import('../../src/mms/settings/SettingsStore')
    const store = new SettingsStore(MousseConfigStore.load(home))
    const draw = () => act(() => view.render(createElement(AppearanceSettings, {
      settings: store.get(),
      options: { themes: THEME_OPTIONS, accentColors: ACCENT_COLORS, llmProviders: [], agentTypes: [] },
      onUpdate: async (partial) => { store.set(partial); applyAppearance(store.get().appearance); draw() },
      restartRequired: false,
      onRestart: () => undefined,
      onPreviewAcrylicIntensity: () => undefined,
      onCommitAcrylicIntensity: () => undefined
    })))
    draw()

    const advanced = host.querySelector('details.settings-advanced')
    expect(advanced?.textContent).toContain('Animation speed')
    expect(host.querySelectorAll('details.settings-advanced')).toHaveLength(1)
    const select = advanced!.querySelector<HTMLSelectElement>('select[aria-label="Animation speed"]')!
    expect([...select.options].map((option) => option.textContent)).toEqual(['Off', 'Fast', 'Normal', 'Slow'])
    expect(select.value).toBe('normal')
    expect(advanced!.querySelector('[title]')?.getAttribute('title')).toMatch(/reduce motion/)

    await act(async () => {
      select.value = 'off'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(store.get().appearance.animationSpeed).toBe('off')
    expect(root().getAttribute('data-motion')).toBe('off')
    expect(root().style.getPropertyValue('--ui-motion-scale')).toBe('0')

    await act(async () => {
      select.value = 'slow'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(root().getAttribute('data-motion')).toBeNull()
    expect(root().style.getPropertyValue('--ui-motion-scale')).toBe('1.6')

    const reloaded = new SettingsStore(MousseConfigStore.load(home))
    expect(reloaded.get().appearance.animationSpeed).toBe('slow')
  })
})

describe('motion styles', () => {
  const global = read('../../src/renderer/styles/global.css')
  const polish = read('../../src/renderer/styles/polish.css')

  it('defines the scaled duration tokens on :root', () => {
    expect(polish).toMatch(/--ui-motion-scale:\s*1;/)
    expect(polish).toMatch(/--ui-dur-fast:\s*calc\(120ms \* var\(--ui-motion-scale\)\)/)
    expect(polish).toMatch(/--ui-dur:\s*calc\(160ms \* var\(--ui-motion-scale\)\)/)
    expect(polish).toMatch(/--ui-dur-slow:\s*calc\(200ms \* var\(--ui-motion-scale\)\)/)
  })

  it('has an Off rule that stops transitions and animations but keeps spinners', () => {
    const rule = /(\[data-motion='off'\] \*[^{]*)\{([^}]*)\}/.exec(global)
    expect(rule).not.toBeNull()
    const [, selector, body] = rule!
    expect(selector).toContain('::before')
    expect(selector).toContain('::after')
    expect(selector).toContain(':not(.spin)')
    expect(selector).toContain(':not(.icon-spin)')
    expect(body).toMatch(/transition-duration:\s*0\.01ms !important/)
    expect(body).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(body).toMatch(/animation-iteration-count:\s*1 !important/)
  })

  it('keeps the Off rule at the reduced-motion rule\'s specificity so the side card still beats it', () => {
    const count = (selector: string) => (selector.match(/:not\(/g) ?? []).length + (selector.match(/\[data-motion/g) ?? []).length
    const off = /(\[data-motion='off'\] \*[^,{]+)/.exec(global)![1]
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*(\*:not[^,{]+)/.exec(global)![1]
    expect(count(off)).toBe(count(reduced))
  })

  it('scales the converted motion', () => {
    expect(read('../../src/renderer/styles/sliding-threads-pane.css')).toContain('transition: width var(--ui-dur-slow)')
    expect(read('../../src/renderer/styles/select.css')).toContain('animation: ui-select-in var(--ui-dur-fast)')
    expect(read('../../src/renderer/components/sideCard/sideCard.css')).toContain('opacity calc(180ms * var(--ui-motion-scale))')
    expect(read('../../src/renderer/styles/threads-sidebar.css')).toContain('threads-sidebar-slide-out var(--ui-dur-slow)')
  })
})
