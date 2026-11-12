// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENT_COLORS, THEME_OPTIONS, getDefaultSettings, normalizeAppearance } from '../../src/shared/settings'
import { setContextRingInComposer } from '../../src/renderer/lib/contextRingSetting'
import { searchSettings, type SettingsSearchPage } from '../../src/renderer/lib/settingsSearch'
import { ComposerFooter } from '../../src/renderer/components/ComposerFooter'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import type { ContextUsageSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let view: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  host.className = 'composer'
  document.body.append(host)
  view = createRoot(host)
})

afterEach(() => {
  setContextRingInComposer(false)
  act(() => view.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const provider: ProviderWithStatus = {
  id: 'claude-subscription',
  label: 'Claude Code',
  models: [{ id: 'opus', label: 'Opus 5.5' }],
  caps: { toolControl: 'exact', autoPermissionMode: true, contextUsage: 'reported' } as ProviderWithStatus['caps']
}

/** A measured thread whose cache expired an hour ago: 43.9K of 1M, 41K of it read from the cache. */
const measured = (): ContextUsageSnapshot => ({
  percent: 4, used: 43_888, limit: 1_000_000, modelName: 'opus', source: 'measured',
  categories: [
    { label: 'Read from cache', color: '#22c55e', tokens: 41_000 },
    { label: 'Written to cache', color: '#f59e0b', tokens: 2_000 },
    { label: 'Sent uncached', color: '#06b6d4', tokens: 864 },
    { label: 'New conversation', color: '#818cf8', tokens: 24 }
  ],
  request: { cached: 41_000, uncached: 2_864 },
  promptCache: { lastRequestAt: Date.now() - 2 * 60 * 60_000, ttlMs: 60 * 60_000 }
})

function composer(contextUsage: ContextUsageSnapshot, open = false) {
  const onContextOpenChange = vi.fn()
  act(() => view.render(createElement(ComposerFooter, {
    run: {
      providers: [provider], selectedProviderId: 'claude-subscription', selectedModelId: 'opus',
      modelMenuOpen: false, onModelMenuOpenChange: vi.fn(), onModelSelect: vi.fn(), onOpenSettings: vi.fn(),
      contextUsage, contextOpen: open, onContextOpenChange, onCompactNow: vi.fn()
    },
    onAttachClick: vi.fn()
  })))
  return { onContextOpenChange }
}

const ring = () => document.querySelector<HTMLButtonElement>('.context-usage-btn')
const chip = () => document.querySelector<HTMLElement>('.composer-idle-chip')

describe('context ring in composer', () => {
  it('is off by default, also for settings saved before it existed', () => {
    expect(getDefaultSettings().appearance.contextRingInComposer).toBe(false)
    expect(normalizeAppearance({}).contextRingInComposer).toBe(false)
    expect(normalizeAppearance({ contextRingInComposer: true }).contextRingInComposer).toBe(true)
    expect(normalizeAppearance({ contextRingInComposer: 'yes' as never }).contextRingInComposer).toBe(false)
  })

  it('hides the ring while off, and the Full/Compact chip still shows with the measured count', () => {
    composer(measured())
    expect(ring()).toBeNull()
    expect(chip()?.textContent).toBe('Full · 44K')
  })

  it('closes an open popover when the ring is turned off', () => {
    setContextRingInComposer(true)
    composer(measured(), true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => setContextRingInComposer(false))
    const { onContextOpenChange } = composer(measured(), true)
    expect(onContextOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the ring when on, its tooltip splitting the request into cached and new', () => {
    setContextRingInComposer(true)
    composer(measured())
    expect(ring()?.title).toBe('4% · 43.9K of 1M · Cached 41K · New 2.9K')
    expect(ring()?.getAttribute('aria-label')).toBe('Context usage: 4% · 43.9K of 1M tokens')
    expect(chip()).not.toBeNull()
  })

  it('leaves the split out of an estimate', () => {
    setContextRingInComposer(true)
    const { request: _request, ...estimate } = measured()
    composer({ ...estimate, source: 'estimated', categories: [{ label: 'System, tools & instructions', color: '#6b7280', tokens: 43_888 }] })
    expect(ring()?.title).toBe('4% · ~43.9K of 1M')
  })

  it('is found by Settings search on the Appearance page', () => {
    const pages: SettingsSearchPage[] = [{ id: 'appearance', label: 'Appearance', keywords: [] }]
    expect(searchSettings('context ring', pages)[0]).toMatchObject({ title: 'Context ring in composer', section: 'appearance', anchor: 'appearance-context-ring' })
  })
})

describe('Settings › Appearance › Composer', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-context-ring-'))
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'darwin' }
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('groups the composer options under a Composer heading, and the toggle turns the ring on and survives a reload', async () => {
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
      onCommitAcrylicIntensity: () => undefined,
      onPreviewFrostedComposer: () => undefined,
      onCommitFrostedComposer: () => undefined
    })))
    draw()
    applyAppearance(store.get().appearance)

    const heading = [...host.querySelectorAll('.settings-group-title')].find((title) => title.textContent === 'Composer')!
    expect(heading).toBeDefined()
    const group = heading.closest('[aria-labelledby]') ?? heading.parentElement!.parentElement!
    const titles = [...group.querySelectorAll('.settings-item-title')].map((title) => title.textContent)
    expect(titles).toEqual(['Context ring in composer', 'Frosted composer'])
    // The general appearance options stay outside it.
    expect([...host.querySelectorAll('.settings-item-title')].map((title) => title.textContent)).toEqual(expect.arrayContaining(['Color theme', 'Render math', 'Project colors on threads']))
    expect(titles).not.toContain('Render math')

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Context ring in composer"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => { toggle.click() })
    expect(store.get().appearance.contextRingInComposer).toBe(true)
    expect(host.querySelector('[role="switch"][aria-label="Context ring in composer"]')?.getAttribute('aria-checked')).toBe('true')
    expect(new SettingsStore(MousseConfigStore.load(home)).get().appearance.contextRingInComposer).toBe(true)

    // useTheme hands the saved value to the composer when settings change.
    setContextRingInComposer(store.get().appearance.contextRingInComposer)
    act(() => view.unmount())
    view = createRoot(host)
    composer(measured())
    expect(ring()).not.toBeNull()
  })
})
