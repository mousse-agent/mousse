// @vitest-environment jsdom
/**
 * Settings → Devices as a person sees it: one Networking switch, the two lists with one add button each, where an
 * engine pairing and a device paired under the old networking sit side by side. Only the daemon is stubbed.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { MousseIdAccount } = await import('../../src/renderer/components/MousseIdAccount')
const { useMousseIdStore } = await import('../../src/renderer/stores/mousseIdStore')
const { SERVICE_ANSWERED_LATE, SERVICE_STOPPED_ANSWERING } = await import('../../src/shared/errors')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { NO_COMPUTERS, useComputersStore } = await import('../../src/renderer/lib/computers')

const policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true }
/** A set-up computer that manages its devices, with one other computer and a phone. */
const daemon = {
  error: undefined as string | undefined,
  removed: false,
  plus: undefined as Record<string, unknown> | undefined,
  finishError: undefined as unknown,
  enabled: true,
  initError: undefined as unknown
}
const request = vi.fn(async (method: string, _params?: unknown) => {
  switch (method) {
    case 'netEngine.status':
      return {
        enabled: true, on: true, helper: { state: 'running' }, approvals: [],
        devices: [{ node: 'n_studio', name: 'Studio Mac', shortId: 'ab12', state: 'connected', route: 'lan' }]
      }
    case 'net.status':
      return {
        enabled: daemon.enabled, keystore: 'unlocked', protected: true, rosterState: 'ok', routes: [], transports: [],
        self: { node: 'nod_self', user: 'usr_a', isAuthority: true, removed: daemon.removed }, peers: [], workOnThreads: true, error: daemon.error
      }
    case 'net.plus.status': return daemon.plus
    case 'net.init':
      if (daemon.initError) throw daemon.initError
      return {}
    case 'net.plus.login.begin':
      return { id: 'login-1', userCode: 'ABCDEF-123456', verificationUri: 'https://id.example/approve', expiresAt: Date.now() + 60_000 }
    case 'net.plus.login.finish':
      if (daemon.finishError) throw daemon.finishError
      return daemon.plus
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes: [
      { node: 'nod_self', name: 'agibook', self: true, revoked: false, caps: ['read'], kind: 'computer', state: 'open', routes: [] },
      { node: 'n_studio', name: 'Studio Mac', self: false, revoked: false, caps: ['read', 'chat', 'write', 'terminal', 'settings'], kind: 'computer', state: 'open', routes: [], policy, connection: 'connected', source: 'engine' },
      { node: 'nod_nas', name: 'Old NAS', self: false, revoked: false, caps: ['read', 'chat', 'write', 'settings'], kind: 'computer', state: 'open', route: { transport: 'relay', direction: 'out' }, routes: [], policy, connection: 'connected' }
    ] }
    case 'bridge.activity': return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
    default: return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  request.mockClear()
  daemon.error = undefined
  daemon.removed = false
  daemon.plus = undefined
  daemon.finishError = undefined
  daemon.enabled = true
  daemon.initError = undefined
  useMousseIdStore.setState({ runtimeOrigin: '' })
  // Settings shows only once the window's profile is bound; before that nothing reads the computers.
  useAppStore.setState({ profileReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    netEngine: { onChanged: () => () => undefined },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  // Each case starts with no computers listed, as a fresh window does.
  useComputersStore.setState(NO_COMPUTERS)
  host.remove()
  document.body.innerHTML = ''
})

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(EngineDevicesSection))); await flush() }
const buttons = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const click = async (target: HTMLElement | undefined) => { expect(target).toBeTruthy(); await act(async () => target!.click()); await flush() }
/** A device's row in the list, and the chosen device's detail, as read. */
const rowText = (node: string) => (host.querySelector(`[data-device-node="${node}"]`)?.textContent ?? '').replace(/\s+/g, ' ')
const detailText = () => (host.querySelector('[data-device-detail]')?.textContent ?? '').replace(/\s+/g, ' ')
const choose = (name: string) => click(host.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`) ?? undefined)
const called = (method: string) => request.mock.calls.filter(([name]) => name === method)

describe('Settings → Devices', () => {
  it('lists an engine pairing and an old pairing in one list, with one switch, both add buttons and none of the old controls', async () => {
    await mount()
    expect(rowText('n_studio')).toContain('Both ways')
    expect(rowText('nod_nas')).toContain('Both ways')
    // The first device shows at once.
    expect(detailText()).toContain('Connected · same network · Both ways')
    expect(detailText()).toContain('Access here')
    expect(buttons('Use another computer')).toHaveLength(1)
    expect(buttons('Let a device in')).toHaveLength(1)
    expect([...host.querySelectorAll('[role="switch"][aria-label="Networking"]')]).toHaveLength(1)
    for (const gone of ['Start over', 'Connection checks', 'Connection add-ons', 'Advertised routes', 'Device name', 'cloudflared'])
      expect(host.textContent).not.toContain(gone)

    // The old pairing opens the same Access panel, and Remove goes to the old networking.
    await choose('Old NAS')
    expect(detailText()).toContain('Connected · via relay')
    expect(detailText()).toContain('All projects, except private threads')
    await click(buttons('Actions for Old NAS')[0])
    await click(buttons('Remove…')[0])
    await click(buttons('Remove').at(-1))
    expect(called('bridge.revoke')).toEqual([['bridge.revoke', { node: 'nod_nas' }]])
  })

  it('turning Networking off turns off both the engine and the old networking', async () => {
    await mount()
    await click(host.querySelector<HTMLElement>('[role="switch"][aria-label="Networking"]')!)
    expect(called('netEngine.disable')).toHaveLength(1)
    expect(called('net.disable')).toHaveLength(1)
  })

  it('a computer removed from your devices is told signing in adds it back, not that it is reconnecting', async () => {
    daemon.error = 'bad_delegation'
    daemon.removed = true
    daemon.plus = { configured: true, connected: false, email: 'me@example.com' }
    useMousseIdStore.setState({ runtimeOrigin: 'https://id.example' })
    await act(async () => root.render(createElement(MousseIdAccount, { onSetUp: () => undefined, lapsed: true })))
    await flush()
    expect(host.textContent).toContain('This computer was removed from your devices. Sign in to add it back.')
    expect(host.textContent).not.toContain('Reconnecting')
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toContain('Sign in')
  })

  it('a computer whose devices list was folded into the account’s one list is told to sign in again to join it', async () => {
    daemon.plus = { configured: false, connected: false, reason: 'list_merged' }
    useMousseIdStore.setState({ runtimeOrigin: 'https://id.example' })
    await act(async () => root.render(createElement(MousseIdAccount, { onSetUp: () => undefined })))
    await flush()
    expect(host.textContent).toContain('Your devices are now on one list. Sign in again to join it.')
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toContain('Sign in')
  })

  it('a sign-in refused because the account keeps its devices list on another computer says so in plain words', async () => {
    daemon.plus = { configured: false, connected: false }
    // As the daemon's refusal reaches the window: code, message and details.
    daemon.finishError = { code: 'conflict', message: 'The same identifier was used with different content.', details: { reason: 'account_network_kept' } }
    useMousseIdStore.setState({ runtimeOrigin: 'https://id.example' })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await act(async () => root.render(createElement(MousseIdAccount, { onSetUp: () => undefined })))
    await flush()
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in')!.click())
    await flush()
    open.mockRestore()
    const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Your Mousse ID already has a devices list on another computer.')
    expect(alert).toContain('can’t join that list without leaving them')
    expect(alert).not.toMatch(/binding|identifier/i)
  })

  /** Signs in from the account row and returns the alert it shows. */
  const signInAlert = async (): Promise<HTMLElement | null> => {
    daemon.plus = daemon.plus ?? { configured: false, connected: false }
    useMousseIdStore.setState({ runtimeOrigin: 'https://id.example' })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await act(async () => root.render(createElement(MousseIdAccount, { onSetUp: () => undefined })))
    await flush()
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in')!.click())
    await flush()
    open.mockRestore()
    return host.querySelector<HTMLElement>('[role="alert"]')
  }

  it('a sign-in whose call to the background service lost its connection says the service stopped answering', async () => {
    // As main answers a platform request whose connection to the service dropped.
    daemon.finishError = { code: 'service_connection_lost', message: SERVICE_STOPPED_ANSWERING }
    expect((await signInAlert())?.textContent).toBe(SERVICE_STOPPED_ANSWERING)
  })

  it('turning networking on for sign-in tells a slow service apart from a dropped one', async () => {
    daemon.enabled = false
    daemon.initError = { code: 'service_timeout', message: SERVICE_ANSWERED_LATE }
    expect((await signInAlert())?.textContent).toBe(`Couldn’t turn on networking: ${SERVICE_ANSWERED_LATE}`)
  })

  it('a generic failure shows its words with the reference in the tooltip, and Copy copies both', async () => {
    const message = 'Something went wrong. Please try again or report this error. Reference: 0d6c1c1e-4a5b-4f43-9d6e-1b2c3d4e5f60'
    daemon.finishError = { code: 'platform_request_failed', message }
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const alert = await signInAlert()
    expect(alert?.textContent).toContain('Something went wrong. Please try again or report this error.')
    expect(alert?.querySelector('[title*="0d6c1c1e"]')).not.toBeNull()
    const copy = alert!.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')!
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith(message)
    expect(copy.textContent).toBe('Copied')
  })

  it('a disconnected account can be signed out, so signing in to a different one is never stuck', async () => {
    daemon.plus = { configured: true, connected: false, email: 'me@example.com' }
    useMousseIdStore.setState({ runtimeOrigin: 'https://id.example' })
    await act(async () => root.render(createElement(MousseIdAccount, { onSetUp: () => undefined })))
    await flush()
    expect(host.textContent).toContain('Disconnected')
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(expect.arrayContaining(['Sign out', 'Sign in']))
    request.mockClear()
    await act(async () => buttons.find((button) => button.textContent === 'Sign out')!.click())
    await flush()
    expect(request.mock.calls.map(([method]) => method)).toContain('net.plus.disconnect')
  })
})
