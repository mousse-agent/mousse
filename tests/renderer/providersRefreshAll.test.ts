// @vitest-environment jsdom
/**
 * Settings → Providers has one refresh: it checks every provider again and then refreshes every provider's models,
 * and a provider whose models could not be refreshed is named on the page.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

describe('Settings → Providers refresh', () => {
  let host: HTMLDivElement
  let root: Root
  let entries: InstanceSnapshot[]
  let calls: string[]
  let modelsFail: boolean

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const toolbarButtons = () => [...document.body.querySelectorAll('.prov-toolbar-actions button')]
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
    calls = []
    modelsFail = false
    entries = [snapshot(), snapshot({ instanceId: 'claude:bots', displayName: 'Claude for bots', builtIn: false })]
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
        instances: {
          recheck: async (instanceId: string) => {
            calls.push(`check ${instanceId}`)
            return entries.find((entry) => entry.instanceId === instanceId)
          },
          refreshAllModels: async () => {
            calls.push('models')
            return entries.map((entry, index) =>
              modelsFail && index === 1
                ? { instanceId: entry.instanceId, outcome: 'failed', message: 'timed out', snapshot: entry }
                : { instanceId: entry.instanceId, outcome: 'refreshed', snapshot: entry }
            )
          }
        }
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

  it('checks every provider, then refreshes their models, from one button', async () => {
    await mount()
    const refresh = toolbarButtons().filter((button) => button.getAttribute('aria-label')?.startsWith('Refresh'))
    expect(refresh.map((button) => button.getAttribute('aria-label'))).toEqual(['Refresh providers and models'])
    await act(async () => { (refresh[0] as HTMLButtonElement).click() })
    await settle()
    expect(calls.slice(0, 2).sort()).toEqual(['check claude:bots', 'check claude'].sort())
    expect(calls[2]).toBe('models')
    expect(document.body.querySelector('.prov-error')).toBeNull()
  })

  it('names a provider whose models could not be refreshed', async () => {
    modelsFail = true
    await mount()
    await act(async () => { (document.body.querySelector('[aria-label="Refresh providers and models"]') as HTMLButtonElement).click() })
    await settle()
    expect(document.body.querySelector('.prov-error')?.textContent).toBe('Could not refresh models: Claude for bots (timed out)')
  })
})
