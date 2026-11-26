// @vitest-environment jsdom
/**
 * Settings → Providers manages another of the user's computers: the toolbar names the computers that work on threads
 * with this one, and with one chosen every call of the page goes to it, sign-ins included. Mounted over a fake service.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings } from '../../src/renderer/components/providers/ProvidersSettings'
import { ArgsRow, EnvRow, ExecutableRow } from '../../src/renderer/components/providers/CliSections'
import { NO_COMPUTERS, useComputersStore } from '../../src/renderer/lib/computers'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { RemoteProviderEvent } from '../../src/shared/harness/types'
import { getDefaultSettings } from '../../src/shared/settings'
import { snapshot } from '../providerSnapshotFixture'

const MAC = 'nod_0123456789abcdefghjkmnpqrs'
const device = (node: string, name: string, patch: Record<string, unknown> = {}) => ({
  node, name, caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state: 'open', ...patch
})

describe('Settings → Providers of another computer', () => {
  let host: HTMLDivElement
  let root: Root
  let nodes: unknown[]
  // The snapshot store listens once per module, so its listener outlives each test's mount.
  const remoteListeners: Array<(event: RemoteProviderEvent) => void> = []
  let local: Record<string, ReturnType<typeof vi.fn>>
  let remote: ReturnType<typeof vi.fn>
  let openLoginUrl: ReturnType<typeof vi.fn>
  let macEntries: InstanceSnapshot[]

  const settle = async () => {
    for (let round = 0; round < 8; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const text = () => document.body.textContent ?? ''
  const click = async (element: Element | undefined | null) => {
    if (!element) throw new Error('nothing to click')
    await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }
  const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  const computerMenu = () => document.body.querySelector('[role="combobox"][aria-label="Computer"]')
  const chooseComputer = async (name: string) => {
    await click(computerMenu())
    await click([...document.body.querySelectorAll('[role="option"]')].find((option) => option.textContent?.trim() === name))
  }
  const remoteCalls = (method: string) => remote.mock.calls.filter((call) => call[1] === method)

  const mount = async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
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
    useComputersStore.setState(NO_COMPUTERS)
    nodes = [device('nod_self00000000000000000000000', 'This PC', { self: true }), device(MAC, 'Mac mini')]
    macEntries = [snapshot({ instanceId: 'claude:work', builtIn: false, displayName: 'Work Claude', auth: { state: 'signed_out', account: undefined }, nextStep: { action: 'sign_in', label: 'Sign in' } })]
    local = {
      setEnabled: vi.fn(async () => snapshot()),
      signIn: vi.fn(),
      respondSignIn: vi.fn(),
      recheck: vi.fn(async () => snapshot())
    }
    openLoginUrl = vi.fn(async () => ({ ok: true }))
    remote = vi.fn(async (_node: string, method: string, params: Record<string, unknown>) => {
      switch (method) {
        case 'providers.snapshots': return macEntries
        case 'providers.catalog.addOptions': return []
        case 'providers.instances.setEnabled': return snapshot({ ...macEntries[0], enabled: { device: params.enabled as boolean, effective: params.enabled as boolean, setBy: 'device' } })
        case 'providers.instances.signIn': return { operationId: 'op-mac-1', instanceId: params.instanceId, kind: 'sign_in' }
        case 'providers.instances.respondSignIn': return true
        case 'providers.instances.recheck': return macEntries[0]
        default: throw new Error(`unexpected ${method}`)
      }
    })
    ;(window as unknown as { mousse: unknown }).mousse = {
      platform: 'linux',
      dialog: { pickExecutable: async () => null },
      platformRequest: {
        request: async (method: string) => {
          if (method === 'net.status') return { enabled: true, self: { node: 'nod_self00000000000000000000000' }, keystore: 'unlocked', features: { netBridge: true, netBridgeThreads: true } }
          if (method === 'bridge.nodes') return { nodes }
          throw new Error('not here')
        }
      },
      providers: {
        snapshots: async () => [snapshot()],
        onSnapshots: () => () => {},
        onOperation: () => () => {},
        onRemote: (listener: (event: RemoteProviderEvent) => void) => {
          remoteListeners.push(listener)
          return () => {}
        },
        openLoginUrl,
        remote,
        catalog: { addOptions: async () => [] },
        registry: { search: async () => [] },
        instances: local
      }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it('offers no computer choice while this is the only computer', async () => {
    nodes = [device('nod_self00000000000000000000000', 'This PC', { self: true }), device('nod_phone0000000000000000000000', 'Phone', { kind: 'phone' })]
    await mount()
    expect(text()).toContain('Claude Code')
    expect(computerMenu()).toBeNull()
  })

  it("lists the other computer's providers once it is chosen, and turns them on or off there", async () => {
    await mount()
    expect(computerMenu()?.textContent).toContain('This device')
    await chooseComputer('Mac mini')
    expect(text()).toContain('Work Claude')
    expect(text()).not.toContain('Claude Code')
    await click(document.body.querySelector('[aria-label="Enable Work Claude"]'))
    expect(remoteCalls('providers.instances.setEnabled')).toEqual([[MAC, 'providers.instances.setEnabled', { instanceId: 'claude:work', enabled: false }]])
    expect(local.setEnabled).not.toHaveBeenCalled()
  })

  it("opens a sign-in there in this computer's browser, and sends the address it ended on back there", async () => {
    await mount()
    await chooseComputer('Mac mini')
    await click(button('Sign in'))
    expect(remoteCalls('providers.instances.signIn')).toEqual([[MAC, 'providers.instances.signIn', { instanceId: 'claude:work' }]])
    expect(local.signIn).not.toHaveBeenCalled()
    // The Mac's sign-in asks for the browser; its page returns to a server on the Mac.
    await act(async () => {
      for (const listener of remoteListeners)
        listener({
          node: MAC,
          type: 'providers.operation',
          data: { event: { operationId: 'op-mac-1', instanceId: 'claude:work', kind: 'sign_in', phase: 'prompt', prompt: { promptId: 'p1', type: 'auth_url', url: 'https://auth.example/start', usesCallbackServer: true, acceptsRedirectPaste: true } } }
        })
    })
    await settle()
    expect(openLoginUrl).toHaveBeenCalledWith('https://auth.example/start')
    // The browser here cannot reach the Mac's server, so the paste field is open at once.
    const field = document.body.querySelector<HTMLInputElement>('#provider-signin-redirect')
    expect(field).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'http://localhost:1455/auth/callback?code=c')
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Continue'))
    expect(remoteCalls('providers.instances.respondSignIn')).toEqual([
      [MAC, 'providers.instances.respondSignIn', { operationId: 'op-mac-1', response: { promptId: 'p1', kind: 'redirect_url', value: 'http://localhost:1455/auth/callback?code=c' } }]
    ])
    expect(local.respondSignIn).not.toHaveBeenCalled()
  })

  it("shows the other computer's refusal in one line", async () => {
    remote.mockImplementation(async (_node: string, method: string) => {
      if (method === 'providers.snapshots') throw new Error('Mac mini does not let this computer work on it.')
      return []
    })
    await mount()
    if (!computerMenu()?.textContent?.includes('Mac mini')) await chooseComputer('Mac mini')
    const line = [...document.body.querySelectorAll('.prov-error')].map((element) => element.textContent).join('\n')
    expect(line).toContain('Mac mini does not let this computer work on it.')
    expect(line).not.toMatch(/\n/)
  })
})

describe('launch settings another computer hides from this one', () => {
  it('shows the variable names with their values hidden, and saves nothing from here', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const entry = snapshot({
      instanceId: 'claude:work',
      binary: { path: '/opt/claude', version: '2.1.0', source: 'override', owner: 'npm' },
      config: { home: 'default', binaryPath: '/opt/claude', args: [], env: { OPENAI_API_KEY: '', LOG_LEVEL: '' }, launchHidden: true }
    } as never)
    const saved = vi.fn(async () => {})
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        createElement('div', null,
          createElement(EnvRow, { snapshot: entry, onSave: saved }),
          createElement(ArgsRow, { snapshot: entry, onSave: saved }),
          createElement(ExecutableRow, { snapshot: entry, label: 'Claude Code', onSave: saved })
        )
      )
    )
    const names = [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')].map((input) => input.value)
    expect(names).toEqual(['OPENAI_API_KEY', 'LOG_LEVEL'])
    const values = [...host.querySelectorAll<HTMLInputElement>('input[aria-label^="Value of"]')]
    expect(values.map((input) => [input.value, input.placeholder, input.disabled])).toEqual([['', 'Hidden', true], ['', 'Hidden', true]])
    const args = host.querySelector<HTMLInputElement>('input[aria-label="Launch arguments"]')!
    expect([args.placeholder, args.disabled]).toEqual(['Hidden', true])
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Executable path"]')!.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Add variable"]')!.disabled).toBe(true)
    // Leaving a field never writes the hidden (empty) values back.
    await act(async () => {
      for (const input of host.querySelectorAll('input')) input.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
      for (const input of host.querySelectorAll('input')) input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(saved).not.toHaveBeenCalled()
    act(() => root.unmount())
    host.remove()
  })
})
