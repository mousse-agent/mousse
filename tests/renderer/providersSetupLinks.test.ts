// @vitest-environment jsdom
/**
 * Getting to a provider: Agents' default model, with nothing to choose, opens Providers; Providers
 * asks which scope it applies to only once there is a project to choose.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'
import type { Project } from '../../src/shared/types'

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

describe('the Providers scope', () => {
  /** Mounted in a window (a server render reads the store's first state, without projects). */
  const render = () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(ProvidersSettings, {
      settings: {} as never,
      refreshProviderData: async () => ({ opts: {} as never }),
      updateSettings: async () => undefined,
      ensureValidProviderSelection: async (next) => next
    })))
    const html = host.innerHTML
    act(() => root.unmount())
    return html
  }

  it('is shown only once there is a project to choose, still naming this device', () => {
    ;(window as unknown as { mousse: unknown }).mousse = {
      providers: {
        snapshots: () => new Promise(() => {}),
        onSnapshots: () => () => {},
        onOperation: () => () => {},
        catalog: { addOptions: async () => [] }
      }
    }
    expect(render()).not.toContain('Applying settings for')
    const project: Project = { id: 'p1', name: 'Alpha', path: '/work/p1', createdAt: '2026-10-01T00:00:00.000Z', order: 0 }
    useAppStore.setState({ projects: [project] })
    const html = render()
    expect(html).toContain('Applying settings for')
    expect(html).toContain('aria-label="Settings scope"')
    expect(html).toContain('This device')
  })
})

describe('the provider editor surface', () => {
  it('is the pane alone: Setup and the other sections add no surface of their own', () => {
    const css = readFileSync('src/renderer/styles/providers.css', 'utf8')
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? ''
    const rows = rule('.prov-editor .settings-group-rows')
    expect(rows).toMatch(/background:\s*none/)
    expect(rows).toMatch(/box-shadow:\s*none/)
    expect(rows).not.toContain('--settings-surface)')
    expect(rule('.prov-editor .settings-group-rows > .settings-item:hover')).toMatch(/background:\s*none/)
    // The pane stays the one subtle surface.
    expect(rule('.prov-pane')).toContain('background: var(--settings-surface)')
  })
})
