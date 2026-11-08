// @vitest-environment jsdom
/**
 * Bot Phase 1 §5.9 item 7: a bot's Sign in opens Settings → Providers on the entry it names (the
 * bot runner, "Claude for bots"), whether Providers was already showing or mounts afterwards.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import { openProvider } from '../../src/renderer/lib/settingsNavigation'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

describe('Settings → Providers opened on one entry', () => {
  let host: HTMLDivElement
  let root: Root
  let entries: InstanceSnapshot[]

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const selected = () => [...document.body.querySelectorAll('.prov-item-hit[aria-pressed="true"]')].map((item) => item.getAttribute('aria-label'))
  const mount = async () => {
    act(() => root.render(createElement(ProvidersSettings, {
      settings: getDefaultSettings(),
      refreshProviderData: async () => ({ opts: { themes: [], accentColors: [], llmProviders: [], agentTypes: [] } as never }),
      updateSettings: async () => {},
      ensureValidProviderSelection: async (next) => next
    })))
    await settle()
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    entries = [
      snapshot(),
      snapshot({ instanceId: 'claude:bots', displayName: 'Claude for bots', builtIn: false, auth: { state: 'signed_out', canSignIn: true } })
    ]
    ;(window as unknown as { mousse: unknown }).mousse = {
      platform: 'linux',
      dialog: { pickExecutable: async () => null },
      providers: {
        snapshots: async () => entries,
        onSnapshots: () => () => {},
        onOperation: () => () => {},
        openLoginUrl: async () => ({ ok: true }),
        catalog: { addOptions: async () => [] },
        registry: { search: async () => [] },
        instances: {}
      }
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('selects the entry asked for before the page mounted', async () => {
    openProvider('claude:bots')
    await mount()
    expect(selected()).toEqual(['Select Claude for bots'])
  })

  it('selects the entry asked for while the page shows', async () => {
    await mount()
    expect(selected()).toEqual(['Select Claude Code'])
    await act(async () => { openProvider('claude:bots') })
    await settle()
    expect(selected()).toEqual(['Select Claude for bots'])
  })
})
