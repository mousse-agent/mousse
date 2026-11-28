// @vitest-environment jsdom
/**
 * A Codex entry's model provider in its Setup group (docs/plans/codex-own-provider.md): nothing while
 * it runs on ChatGPT and config.toml selects nothing else; "Use it" for the provider config.toml
 * selects, with what it bills; "Use ChatGPT" once it runs there. The key is only ever masked.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEditor } from '../../src/renderer/components/providers/ProviderEditor'
import type { InstanceActions } from '../../src/renderer/components/providers/CliSections'
import type { ModelRouteView } from '../../src/shared/harness/modelRoute'
import { describeStatus, type InstanceSnapshot } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'

const noop = async () => {}
const actions = { configure: noop, enable: noop, install: noop, cancelInstall: noop, update: noop, signIn: noop, signOut: noop, recheck: noop, allowKnownProblem: noop, removeInstall: async () => ({ removed: true }) } as unknown as InstanceActions
const BASE = 'https://llm.example.com/v1'
const OFFER = { table: 'mine', name: 'Mine', baseUrl: BASE, host: 'llm.example.com', keyMasked: '•••• 9z8y' }
const RUNNING: ModelRouteView = { kind: 'custom', table: 'mine', name: 'Mine', host: 'llm.example.com', keyMasked: '•••• 9z8y' }

describe("a Codex entry's model provider", () => {
  let host: HTMLDivElement
  let root: Root
  let modelRoute: ReturnType<typeof vi.fn>
  let setModelRoute: ReturnType<typeof vi.fn>
  const entry: InstanceSnapshot = snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex', config: { home: 'default', args: [], env: {} } })
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const mount = async (shown: InstanceSnapshot = entry) => {
    act(() => root.render(createElement(AgentEditor, { snapshot: shown, status: describeStatus(shown), actions, onSaveModelPrefs: noop, onRefreshModels: noop })))
    await settle()
  }
  const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text)

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    modelRoute = vi.fn(async (): Promise<ModelRouteView> => ({ kind: 'chatgpt', offer: OFFER }))
    setModelRoute = vi.fn(async (input: { route: unknown }): Promise<ModelRouteView> => (input.route ? RUNNING : { kind: 'chatgpt', offer: OFFER }))
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'linux', dialog: { pickExecutable: async () => null }, providers: { instances: { modelRoute, setModelRoute } } }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('offers the provider config.toml selects, agrees to exactly what it showed, then switches back', async () => {
    await mount()
    expect(host.textContent).toContain('Mine in config.toml')
    expect(host.textContent).toContain('llm.example.com · key •••• 9z8y · billed to that key')
    await act(async () => button('Use it')!.click())
    await settle()
    expect(setModelRoute).toHaveBeenCalledWith({ instanceId: 'codex', route: { table: 'mine', baseUrl: BASE } })
    expect(host.textContent).toContain('Runs on Mine')
    expect(button('Use it')).toBeUndefined()
    await act(async () => button('Use ChatGPT')!.click())
    await settle()
    expect(setModelRoute).toHaveBeenLastCalledWith({ instanceId: 'codex', route: null })
    expect(button('Use it')).toBeDefined()
  })

  it('shows nothing while nothing else is selected, and why a selected provider cannot be used', async () => {
    modelRoute.mockImplementation(async () => ({ kind: 'chatgpt' }))
    await mount()
    expect(host.textContent).not.toContain('config.toml')
    act(() => root.unmount())
    root = createRoot(host)
    modelRoute.mockImplementation(async () => ({ kind: 'chatgpt', problem: 'The provider mine sets env_key in config.toml, which Mousse doesn\'t pass on yet.' }))
    await mount({ ...entry, checkedAt: 'later' })
    expect(host.textContent).toContain('sets env_key')
    expect(button('Use it')).toBeUndefined()
  })

  it('says why the route stopped, and offers the changed provider to agree to again', async () => {
    modelRoute.mockImplementation(async () => ({ ...RUNNING, keyMasked: undefined, problem: 'The base URL in config.toml changed. Agree to it again in Settings → Providers.', offer: { ...OFFER, baseUrl: 'https://other.example.com/v1', host: 'other.example.com' } }))
    await mount()
    expect(host.textContent).toContain('The base URL in config.toml changed')
    await act(async () => button('Use it')!.click())
    await settle()
    expect(setModelRoute).toHaveBeenCalledWith({ instanceId: 'codex', route: { table: 'mine', baseUrl: 'https://other.example.com/v1' } })
  })

  it('is not shown for a managed entry, nor asked for', async () => {
    await mount({ ...entry, config: { home: 'private', args: [], env: {}, setup: 'managed' } } as InstanceSnapshot)
    expect(host.textContent).not.toContain('config.toml')
    expect(modelRoute).not.toHaveBeenCalled()
  })
})
