// @vitest-environment jsdom
/**
 * Settings → Devices as a person sees it: one Networking switch, one Add device, and one list where an engine pairing
 * and a device paired under the old networking sit side by side. Only the daemon is stubbed.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { MousseIdAccount } = await import('../../src/renderer/components/MousseIdAccount')
const { useMousseIdStore } = await import('../../src/renderer/stores/mousseIdStore')

const policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true }
const daemon = { error: undefined as string | undefined, removed: false, plus: undefined as Record<string, unknown> | undefined }
const request = vi.fn(async (method: string, _params?: unknown) => {
  switch (method) {
    case 'netEngine.status':
      return {
        enabled: true, on: true, helper: { state: 'running' }, approvals: [],
        devices: [{ node: 'n_studio', name: 'Studio Mac', shortId: 'ab12', state: 'connected', route: 'lan' }]
      }
    case 'net.status':
      return {
        enabled: true, keystore: 'unlocked', protected: true, rosterState: 'ok', routes: [], transports: [],
        self: { node: 'nod_self', user: 'usr_a', isAuthority: true, removed: daemon.removed }, peers: [], workOnThreads: true, shareBots: true, error: daemon.error
      }
    case 'net.plus.status': return daemon.plus
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
  useMousseIdStore.setState({ runtimeOrigin: '' })
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
  host.remove()
  document.body.innerHTML = ''
})

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(EngineDevicesSection))); await flush() }
const buttons = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const click = async (target: HTMLElement | undefined) => { expect(target).toBeTruthy(); await act(async () => target!.click()); await flush() }
const rowText = (node: string) => (host.querySelector(`[data-device-node="${node}"]`)?.textContent ?? '').replace(/\s+/g, ' ')
const called = (method: string) => request.mock.calls.filter(([name]) => name === method)

describe('Settings → Devices', () => {
  it('lists an engine pairing and an old pairing in one list, with one switch, one Add device and none of the old controls', async () => {
    await mount()
    expect(rowText('n_studio')).toContain('Connected · same network · Works on threads')
    expect(rowText('nod_nas')).toContain('Connected · via relay')
    expect(buttons('Add device')).toHaveLength(1)
    expect([...host.querySelectorAll('[role="switch"][aria-label="Networking"]')]).toHaveLength(1)
    for (const gone of ['Start over', 'Connection checks', 'Connection add-ons', 'Advertised routes', 'Device name', 'cloudflared'])
      expect(host.textContent).not.toContain(gone)

    // The old pairing opens the same Access panel, and Remove goes to the old networking.
    await click(buttons('Actions for Old NAS')[0])
    await click(buttons('Access')[0])
    expect(host.textContent).toContain('All projects, except private threads')
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
})
