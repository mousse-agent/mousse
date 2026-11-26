// @vitest-environment jsdom
/**
 * Getting to a provider: Agents' default model, with nothing to choose, opens Providers.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NO_PROVIDERS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

afterEach(() => {
  useAppStore.setState({ projects: [], settingsOpen: false })
})

describe('the default model with no provider', () => {
  it('opens Settings → Providers', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const opened: unknown[] = []
    const listener = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener('mousse:settings-section', listener)
    act(() => root.render(createElement(AgentsSettings, { settings: getDefaultSettings(), options: NO_PROVIDERS, projects: [], updateSettings: async () => {} })))
    expect(host.textContent).toContain('Add a provider to choose a model.')
    expect(host.querySelector('[aria-label="Default model"]')).toBeNull()
    // A conversation is a thread in every label.
    expect(host.textContent).toContain('Thread titles')
    expect(host.textContent).not.toMatch(/\bchats?\b/i)
    const open = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open Providers')!
    act(() => open.click())
    expect(opened).toEqual(['providers'])
    expect(useAppStore.getState().settingsOpen).toBe(true)
    window.removeEventListener('mousse:settings-section', listener)
    act(() => root.unmount())
  })
})

