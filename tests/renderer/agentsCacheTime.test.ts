// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsSettings } from '../../src/renderer/components/settings/AgentsSettings'
import { useProviderSnapshotsStore } from '../../src/renderer/lib/providerSnapshots'
import { useAppStore } from '../../src/renderer/stores/appStore'
import * as navigation from '../../src/renderer/lib/settingsNavigation'
import { getDefaultSettings, type SettingsOptions } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS: SettingsOptions = { themes: [], accentColors: [], llmProviders: [], agentTypes: [] }

describe('Settings > Agents > Context > Cache time', () => {
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
    useProviderSnapshotsStore.setState({ scopes: {} })
    vi.restoreAllMocks()
  })

  const show = (snapshots: ReturnType<typeof snapshot>[]) => {
    useProviderSnapshotsStore.setState({ profileId: useAppStore.getState().profileId, scopes: { device: { loading: false, snapshots } } })
    act(() => root.render(createElement(AgentsSettings, { settings: getDefaultSettings(), options: OPTIONS, projects: [], updateSettings: async () => {} })))
  }
  const entries = () => Array.from(host.querySelectorAll('.agents-cache-times .agent-access-cap')).map((entry) => entry.textContent)

  it('lists each Claude Code entry with its effective cache time, under Context', () => {
    show([
      snapshot({ promptCacheHour: { basis: 'subscription', on: true } }),
      snapshot({ instanceId: 'claude:api', displayName: 'Claude Code (API key)', promptCacheHour: { basis: 'per_token', on: false } }),
      snapshot({ instanceId: 'claude:own', displayName: 'Claude Code (own)', promptCacheHour: { basis: 'unconfirmed', userSetting: true, on: false } }),
      snapshot({ instanceId: 'claude:off', displayName: 'Turned off', enabled: { device: false, effective: false, setBy: 'device' }, promptCacheHour: { basis: 'per_token', on: true } }),
      snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })
    ])
    const row = host.querySelector('[data-settings-anchor="agents-cache-time"]')!
    expect(row.closest('section.settings-group')?.querySelector('h3')?.textContent?.trim()).toBe('Context')
    expect(entries()).toEqual(['Claude Code1 hour', 'Claude Code (API key)5 minutesChange', 'Claude Code (own)Set in Claude CodeChange'])
  })

  it('opens the entry’s switch in Providers; a subscription has none', () => {
    const open = vi.spyOn(navigation, 'openProvider').mockImplementation(() => {})
    show([
      snapshot({ promptCacheHour: { basis: 'subscription', on: true } }),
      snapshot({ instanceId: 'claude:api', displayName: 'Claude Code (API key)', promptCacheHour: { basis: 'per_token', on: true } })
    ])
    expect(host.querySelector('[aria-label="Change Claude Code in Providers"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Change Claude Code (API key) in Providers"]')!.click())
    expect(open).toHaveBeenCalledWith('claude:api', 'providers-prompt-cache-hour')
  })

  it('is left out when no Claude Code entry is on', () => {
    show([snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })])
    expect(host.querySelector('[data-settings-anchor="agents-cache-time"]')).toBeNull()
  })
})
