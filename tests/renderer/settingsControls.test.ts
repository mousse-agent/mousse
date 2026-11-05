// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Segmented } from '../../src/renderer/components/settings/SettingsRow'
import { GeneralSettings } from '../../src/renderer/components/settings/GeneralSettings'
import { AppearanceSettings } from '../../src/renderer/components/settings/AppearanceSettings'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { SettingsModelPicker } from '../../src/renderer/components/settings/SettingsModelPicker'
import { radioKeyTarget } from '../../src/renderer/lib/radioGroupKeys'
import { useUpdateStore } from '../../src/renderer/stores/updateStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { LlmModelOption, LlmProviderOption, SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const press = (target: Element, key: string) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
})
const radios = (group: Element) => [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
const tabStops = (group: Element) => radios(group).filter((radio) => radio.tabIndex === 0)

describe('radio group keys', () => {
  it('move with the arrows, wrap at the ends, and jump with Home and End', () => {
    expect(radioKeyTarget('ArrowRight', 0, 3)).toBe(1)
    expect(radioKeyTarget('ArrowDown', 2, 3)).toBe(0)
    expect(radioKeyTarget('ArrowLeft', 0, 3)).toBe(2)
    expect(radioKeyTarget('ArrowUp', 1, 3)).toBe(0)
    expect(radioKeyTarget('Home', 2, 3)).toBe(0)
    expect(radioKeyTarget('End', 0, 3)).toBe(2)
    expect(radioKeyTarget('Enter', 0, 3)).toBeUndefined()
  })

  it('a segmented control is one tab stop, and the arrows choose', () => {
    let value = 'b'
    const onChange = vi.fn((next: string) => { value = next; draw() })
    const draw = () => act(() => root.render(createElement(Segmented<string>, {
      value,
      ariaLabel: 'Size',
      onChange,
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }]
    })))
    draw()
    const group = host.querySelector('[role="radiogroup"]')!
    expect(tabStops(group).map((radio) => radio.textContent)).toEqual(['B'])
    act(() => radios(group)[1]!.focus())
    press(document.activeElement!, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('c')
    expect(document.activeElement?.textContent).toBe('C')
    expect(tabStops(group).map((radio) => radio.textContent)).toEqual(['C'])
    press(document.activeElement!, 'Home')
    expect(onChange).toHaveBeenLastCalledWith('a')
    press(document.activeElement!, 'End')
    expect(onChange).toHaveBeenLastCalledWith('c')
  })
})

describe('Settings > Appearance and General', () => {
  let home: string
  let store: SettingsStore
  const OPTIONS: SettingsOptions = {
    themes: [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'System' }] as SettingsOptions['themes'],
    accentColors: [{ id: 'lilac', label: 'Lilac', value: '#a78bfa' }, { id: 'blue', label: 'Blue', value: '#60a5fa' }] as SettingsOptions['accentColors'],
    llmProviders: [],
    agentTypes: []
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-general-settings-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const show = () => {
    const draw = () => act(() => root.render(createElement(AppearanceSettings, {
      settings: store.get(),
      options: OPTIONS,
      onUpdate: async (partial) => { store.set(partial); draw() },
      restartRequired: false,
      onRestart: () => {},
      onPreviewAcrylicIntensity: () => {},
      onCommitAcrylicIntensity: () => {}
    })))
    draw()
  }
  const showGeneral = () => {
    const draw = () => act(() => root.render(createElement(GeneralSettings, {
      settings: store.get(),
      onUpdate: async (partial) => { store.set(partial); draw() }
    })))
    draw()
  }
  const group = (label: string) => host.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!

  it('the theme cards are one tab stop; the arrows choose the next theme and save it', () => {
    store.set({ appearance: { ...store.get().appearance, theme: 'dark' } })
    show()
    const themes = group('Color theme')
    expect(tabStops(themes).map((card) => card.textContent)).toEqual(['Dark'])
    act(() => tabStops(themes)[0]!.focus())
    press(document.activeElement!, 'ArrowRight')
    expect(store.get().appearance.theme).toBe('light')
    expect(document.activeElement?.textContent).toBe('Light')
    press(document.activeElement!, 'End')
    expect(store.get().appearance.theme).toBe('system')
  })

  it('the accent colours are a labelled radio group with the same keys', () => {
    store.set({ appearance: { ...store.get().appearance, accentColor: '#a78bfa' } })
    show()
    const accents = group('Accent color')
    expect(radios(accents).map((swatch) => swatch.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    act(() => tabStops(accents)[0]!.focus())
    press(document.activeElement!, 'ArrowLeft')
    expect(store.get().appearance.accentColor).toBe('#60a5fa')
  })

  it('describes the glass in two words', () => {
    show()
    const row = host.querySelector('[data-settings-anchor="appearance-acrylic"]')!
    expect(row.querySelector('.settings-item-desc')!.textContent).toBe('Translucent window')
    expect(row.textContent).not.toContain('Restart to apply')
  })

  it('shows the version without an update button in a build where updates are off', () => {
    act(() => useUpdateStore.setState({ phase: 'disabled', currentVersion: '1.2.3', disabledReason: 'Updates are not available in this build.' }))
    showGeneral()
    const about = host.querySelector('[data-settings-anchor="general-updates"]')!
    expect(about.textContent).toContain('Mousse 1.2.3')
    expect(about.textContent).toContain('Updates are not available in this build.')
    expect(about.querySelector('button')).toBeNull()
    act(() => useUpdateStore.setState({ phase: 'up-to-date' }))
    expect(about.querySelector('button')?.textContent).toContain('Check for updates')
  })
})

describe('Settings > Agents > Compact context', () => {
  let home: string
  let store: SettingsStore
  const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-compaction-settings-'))
    store = new SettingsStore(MousseConfigStore.load(home))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const show = () => {
    const updates = vi.fn()
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options: OPTIONS,
      projects: [],
      updateSettings: async (partial) => { updates(partial); store.set(partial); draw() }
    })))
    draw()
    return { updates }
  }
  const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Compact context"]')!
  const pick = (label: string) => {
    act(() => trigger().click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === label)!
    act(() => option.click())
  }
  const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().context

  it('is one select, Off or a size; Off keeps the size, so turning it back on offers the same one', () => {
    store.set({ context: { compactionEnabled: true, compactionTokens: 512000 } })
    show()
    expect(host.querySelectorAll('[role="switch"][aria-label="Compact context"]')).toHaveLength(0)
    expect(trigger().textContent).toContain('At 512k tokens')
    pick('Off')
    expect(saved()).toEqual({ compactionEnabled: false, compactionTokens: 512000 })
    expect(trigger().textContent).toContain('Off')
    pick('At 512k tokens')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 512000 })
    pick('At model maximum')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 'model-max' })
  })

  it('choosing what is already saved writes nothing', () => {
    const { updates } = show()
    pick('At 128k tokens')
    expect(updates).not.toHaveBeenCalled()
  })
})

describe('the settings model picker', () => {
  const opus: LlmModelOption = { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }
  const provider = { id: 'claude-subscription', label: 'Claude Code', models: [opus] } as unknown as LlmProviderOption

  it('is one control that names the model and its level; the level is chosen inside its menu', () => {
    const onSelect = vi.fn()
    act(() => root.render(createElement(SettingsModelPicker, {
      providers: [provider],
      providerId: 'claude-subscription',
      modelId: 'opus',
      effort: 'high',
      ariaLabel: 'Default model',
      onSelect
    })))
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Default model: Opus 5.5 · High')
    act(() => buttons[0]!.click())
    const column = document.querySelector<HTMLElement>('.model-picker-run-settings')!
    const low = [...column.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent!.startsWith('Low'))!
    act(() => low.click())
    expect(onSelect).toHaveBeenCalledWith('claude-subscription', { model: 'opus', effort: 'low' }, undefined)
    expect(document.querySelector('.model-picker-run-settings')).toBeNull()
  })
})
