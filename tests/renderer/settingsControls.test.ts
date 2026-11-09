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

  const show = (options: SettingsOptions = OPTIONS) => {
    const updates = vi.fn()
    const draw = () => act(() => root.render(createElement(AgentsSettings, {
      settings: store.get(),
      options,
      projects: [],
      updateSettings: async (partial) => { updates(partial); store.set(partial); draw() }
    })))
    draw()
    return { updates }
  }
  const field = () => host.querySelector<HTMLInputElement>('#agents-context-compaction')!
  const pick = (label: string) => {
    act(() => field().click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === label)!
    act(() => option.click())
  }
  // Typing as React sees it: the native value setter, then an input event.
  const type = (text: string) => act(() => {
    const input = field()
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const note = () => host.querySelector('.settings-compaction-note')
  const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().context

  it('is one field, Off, Auto or a size; Off keeps the size, so turning it back on offers the same one', () => {
    store.set({ context: { compactionEnabled: true, compactionTokens: 512000 } })
    show()
    expect(host.querySelectorAll('[role="switch"][aria-label="Compact context"]')).toHaveLength(0)
    expect(field().getAttribute('role')).toBe('combobox')
    expect(field().value).toBe('512k tokens')
    act(() => field().click())
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(['Off', 'Auto', '128k tokens', '256k tokens', '512k tokens', '1M tokens'])
    act(() => document.querySelector<HTMLElement>('[role="option"]')!.click())
    expect(saved()).toEqual({ compactionEnabled: false, compactionTokens: 512000, idleCompaction: 'suggest' })
    expect(field().value).toBe('Off')
    pick('512k tokens')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 512000, idleCompaction: 'suggest' })
    pick('Auto')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 'model-max', idleCompaction: 'suggest' })
    expect(field().value).toBe('Auto')
  })

  it('typing 300k and Enter saves 300000 tokens', () => {
    show()
    type('300k')
    press(field(), 'Enter')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 300_000, idleCompaction: 'suggest' })
    expect(field().value).toBe('300k tokens')
    expect(field().getAttribute('aria-invalid')).toBeNull()
  })

  it('a saved size of your own is its own checked entry, and the highlight starts on it', () => {
    store.set({ context: { compactionEnabled: true, compactionTokens: 300_000 } })
    show()
    act(() => field().click())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent))
      .toEqual(['Off', 'Auto', '128k tokens', '256k tokens', '300k tokens', '512k tokens', '1M tokens'])
    const checked = options.filter((option) => option.getAttribute('aria-selected') === 'true')
    expect(checked.map((option) => option.textContent)).toEqual(['300k tokens'])
    expect(checked[0]!.querySelector('.ui-select-check svg')).not.toBeNull()
    expect(document.querySelector('.ui-select-option.active')!.textContent).toBe('300k tokens')
    expect(field().getAttribute('aria-activedescendant')).toBe(checked[0]!.id)
  })

  it('the highlight starts on the saved preset, and on Off only when Off is saved', () => {
    store.set({ context: { compactionEnabled: true, compactionTokens: 256_000 } })
    show()
    press(field(), 'ArrowDown')
    expect(document.querySelector('.ui-select-option.active')!.textContent).toBe('256k tokens')
    press(field(), 'Escape')
    pick('Off')
    press(field(), 'ArrowDown')
    expect(document.querySelector('.ui-select-option.active')!.textContent).toBe('Off')
  })

  it('says it takes typing: a placeholder while the field is empty, and a tooltip', () => {
    show()
    expect(field().title).toBe('Pick a size or type one, like 300k')
    type('')
    expect(field().value).toBe('')
    expect(field().placeholder).toBe('Type a size, like 300k')
  })

  it('a typed size is saved when the field loses focus too', () => {
    show()
    type('0.75m')
    act(() => field().blur())
    expect(saved().compactionTokens).toBe(750_000)
  })

  it('an invalid size saves nothing and says what fits; Escape puts back the saved choice', () => {
    const { updates } = show()
    type('10k')
    press(field(), 'Enter')
    expect(updates).not.toHaveBeenCalled()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(note()!.textContent).toBe('Enter 32k to 2M tokens, like 300k.')
    expect(note()!.getAttribute('role')).toBe('alert')
    expect(field().getAttribute('aria-describedby')).toBe(note()!.id)
    press(field(), 'Escape')
    expect(field().value).toBe('Auto')
    expect(field().getAttribute('aria-invalid')).toBeNull()
    expect(note()).toBeNull()
    expect(saved().compactionTokens).toBe('model-max')
  })

  it('the arrows open the list and Enter picks the highlighted size', () => {
    show()
    press(field(), 'ArrowDown')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(6)
    press(field(), 'ArrowDown')
    press(field(), 'Enter')
    expect(saved().compactionTokens).toBe(128_000)
  })

  it('choosing or typing what is already saved writes nothing', () => {
    const { updates } = show()
    pick('Auto')
    type('auto')
    press(field(), 'Enter')
    act(() => field().blur())
    expect(updates).not.toHaveBeenCalled()
  })

  it('says where the default model compacts when its window is known', () => {
    const provider = {
      id: 'anthropic',
      label: 'Anthropic',
      models: [{ id: 'opus', label: 'Opus 5.5', contextWindow: 1_000_000 }, { id: 'small', label: 'Small', contextWindow: 200_000 }]
    } as unknown as LlmProviderOption
    const options = { ...OPTIONS, llmProviders: [provider] }
    store.set({ provider: { llmProvider: 'anthropic', model: 'opus' } })
    show(options)
    expect(note()!.textContent).toBe('Opus 5.5: compacts near its 1M limit')
    type('300k')
    press(field(), 'Enter')
    expect(note()!.textContent).toBe('Opus 5.5: compacts at 300k of 1M')
    store.set({ provider: { llmProvider: 'anthropic', model: 'small' } })
    show(options)
    expect(note()!.textContent).toBe("Above Small's 200k window: compacts at 184k")
    pick('Off')
    expect(note()).toBeNull()
  })

  it('shows no line when the default model does not state its window', () => {
    store.set({ provider: { llmProvider: 'anthropic', model: 'opus' } })
    show({ ...OPTIONS, llmProviders: [{ id: 'anthropic', label: 'Anthropic', models: [{ id: 'opus', label: 'Opus 5.5' }] } as unknown as LlmProviderOption] })
    expect(note()).toBeNull()
  })

  it("when the cache expires: suggests compacting by default, and Don't suggest keeps the size", () => {
    store.set({ context: { compactionEnabled: true, compactionTokens: 300_000, idleCompaction: 'suggest' } })
    show()
    const row = host.querySelector('[data-settings-anchor="agents-idle-compaction"]')!
    expect(row.querySelector('.settings-item-title')!.textContent).toBe('When the cache expires')
    const trigger = row.querySelector<HTMLElement>('[aria-label="When the cache expires"]')!
    expect(trigger.textContent).toContain('Suggest compacting')
    act(() => trigger.click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent === "Don't suggest")!
    act(() => option.click())
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 300_000, idleCompaction: 'off' })
    // Changing the size afterwards keeps the choice.
    pick('512k tokens')
    expect(saved()).toEqual({ compactionEnabled: true, compactionTokens: 512000, idleCompaction: 'off' })
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
