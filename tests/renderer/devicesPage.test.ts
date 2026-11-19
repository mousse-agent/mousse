// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')
const { MousseIdAccount } = await import('../../src/renderer/components/MousseIdAccount')
const { useMousseIdStore } = await import('../../src/renderer/stores/mousseIdStore')

const policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false }
/** A set-up computer that manages its devices, with one other computer and a phone. */
const daemon = { error: undefined as string | undefined, removed: false, plus: undefined as Record<string, unknown> | undefined }
const request = vi.fn(async (method: string) => {
  switch (method) {
    case 'net.status':
      return {
        enabled: true, keystore: 'unlocked', protected: true, rosterState: 'ok', routes: [], transports: [],
        self: { node: 'nod_self', user: 'usr_a', isAuthority: true, removed: daemon.removed }, peers: [], workOnThreads: true, error: daemon.error
      }
    case 'net.plus.status': return daemon.plus
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes: [
      { node: 'nod_self', name: 'agibook', self: true, revoked: false, caps: ['read'], kind: 'computer', state: 'open', version: '0.44.2', routes: [] },
      { node: 'nod_agigo', name: 'Agigo', self: false, revoked: false, caps: ['read', 'settings'], kind: 'computer', state: 'open', version: '0.44.2', route: { transport: 'direct', direction: 'out' }, routes: [], policy },
      { node: 'nod_pixel', name: 'Pixel 9', self: false, revoked: false, caps: ['read'], kind: 'phone', state: 'closed', lastSeenAt: Date.now() - 3 * 3600_000, routes: [], policy }
    ] }
    case 'bridge.activity': return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
    default: return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  daemon.error = undefined
  daemon.removed = false
  daemon.plus = undefined
  useMousseIdStore.setState({ runtimeOrigin: '' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'agibook' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(NetDevicesSection))); await flush() }
const list = () => host.querySelector('[data-settings-anchor="devices-list"]')!
const rowText = (node: string) => list().querySelector(`[data-device-node="${node}"]`)?.textContent ?? ''
const toggle = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label$="details for ${name}"]`)!

describe('Settings → Devices', () => {
  it('lists every device on one line each, this computer first, with no permission rows until one is opened', async () => {
    await mount()
    const names = [...list().querySelectorAll('[data-device-node] .settings-item-title')].map((title) => title.textContent)
    expect(names).toEqual(['agibook', 'Agigo', 'Pixel 9'])
    expect(rowText('nod_self')).toContain('This computer')
    expect(rowText('nod_agigo')).toContain('Computer · Online')
    expect(rowText('nod_pixel')).toContain('Phone · Offline · last seen 3h ago')
    expect(list().textContent).not.toContain('Block on this computer')
    expect(list().textContent).not.toContain('Terminals from this device')
  })

  it('opens one device at a time, with its permissions, Block and Remove', async () => {
    await mount()
    await act(async () => toggle('Agigo').click())
    await flush()
    expect(toggle('Agigo').getAttribute('aria-expanded')).toBe('true')
    const text = list().textContent ?? ''
    for (const words of ['Works on threads', 'Limits…', 'Terminals from this device', 'Editor connections from this device', 'Block on this computer', 'Remove from my devices'])
      expect(text).toContain(words)
    await act(async () => toggle('Pixel 9').click())
    await flush()
    expect(toggle('Agigo').getAttribute('aria-expanded')).toBe('false')
    // A phone keeps the phone API: no thread permissions, but Block and Remove.
    expect(list().textContent).not.toContain('Terminals from this device')
    expect(list().textContent).toContain('Block on this computer')
  })

  it('puts this computer’s own switch in its detail and networking under Advanced', async () => {
    await mount()
    const advanced = host.querySelector('details.settings-advanced')!
    expect(advanced.querySelector('[data-settings-anchor="devices-networking"]')).not.toBeNull()
    await act(async () => toggle('agibook').click())
    expect(list().textContent).toContain('Let my other devices work here')
  })

  it('reads a lapsed device pass as Reconnecting, never as the raw code', async () => {
    daemon.error = 'bad_delegation'
    await mount()
    expect(host.textContent).toContain('This computer’s pass to your devices ran out while it was away')
    expect(host.textContent).toContain('Open Mousse on Agigo')
    expect(rowText('nod_self')).toContain('Reconnecting')
    expect(host.textContent).not.toMatch(/bad.delegation|delegation invalid/)
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
