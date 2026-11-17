// @vitest-environment jsdom
/**
 * Settings → Devices on a computer that is not the keeper: each row says online or last seen, the route, whether the
 * device is connected here and, for a connected computer, its preset; the keeper's row says it keeps the list and warns
 * when it has been out of reach for days. A device's detail says what it may do here and what this computer may do
 * there, the second from the other computer's own answer (`bridge.access.there`).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'
import type { BridgeAccessThere } from '../../src/shared/net/local'
import { passEndLabel } from '../../src/renderer/lib/netDevices'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

const DAY = 86_400_000
const now = Date.now()
const work = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true, agentReach: 'launched', work: true }
const row = (node: string, name: string, extra: Record<string, unknown>) => ({
  node, name, caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: now + 5 * DAY, kind: 'computer',
  self: false, revoked: false, state: 'open', connection: 'connected', routeHeld: true, policy: work, ...extra
})
let nodes: Array<ReturnType<typeof row>>
let answers: Record<string, BridgeAccessThere | undefined>
const viewThere: BridgeAccessThere = {
  state: 'known',
  access: { v: 1, blocked: false, threads: true, work: false, terminal: false, editor: false, bots: true, maxPermissionMode: 'accept_edits', agentReach: 'launched' }
}
beforeEach(() => {
  nodes = [
    row('node_a', 'Laptop', { self: true, expiresAt: now + 3 * DAY }),
    row('node_k', 'Studio Mac', { keeper: true, state: 'closed', lastSeenAt: now - 4 * DAY }),
    row('node_b', 'Mini', { route: { transport: 'tailscale', direction: 'out' } }),
    row('node_c', 'Desk PC', { connection: 'none' }),
    row('node_d', 'Old Mac', {}),
    row('node_p', 'Pixel', { kind: 'phone', caps: ['read', 'chat', 'write'] })
  ]
  answers = { node_b: viewThere, node_c: { state: 'not_connected' }, node_d: { state: 'unknown', reason: 'older' } }
})

const request = vi.fn(async (method: string, params?: { node?: string }) => {
  switch (method) {
    case 'net.status':
      return { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], workOnThreads: true, shareBots: true, self: { node: 'node_a', user: 'user_a', isAuthority: false } } as unknown as NetStatus
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes }
    case 'bridge.access.there': return answers[params!.node!]
    case 'bridge.activity': return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
    default: return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  request.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'Laptop' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(NetDevicesSection))); await flush() }
const rowText = (node: string) => host.querySelector(`[data-device-node="${node}"]`)?.textContent ?? ''
const open = async (name: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="Show details for ${name}"]`)!.click()); await flush() }
/** The description of a detail row, by its title. */
const detail = (title: string) =>
  [...host.querySelectorAll('.settings-item')].find((item) => item.querySelector('.settings-item-title')?.textContent === title)?.querySelector('.settings-item-desc')?.textContent

describe('device rows', () => {
  it('say online or last seen, the route, connected here or not, and a connected computer’s preset', async () => {
    await mount()
    expect(rowText('node_b')).toContain('Computer · Online · via Tailscale · connected here · Work on threads')
    expect(rowText('node_c')).toContain('Online · not connected here')
    expect(rowText('node_c')).not.toContain('Work on threads')
  })

  it('a phone row shows no thread preset', async () => {
    await mount()
    expect(rowText('node_p')).toContain('Phone · Online · connected here')
    for (const preset of ['View and chat', 'Work on threads', 'Full control', 'Custom']) expect(rowText('node_p')).not.toContain(preset)
  })

  it('the keeper’s row says it keeps the list, and warns when it has been out of reach for days', async () => {
    await mount()
    expect(rowText('node_k')).toContain('keeps your device list')
    // The earliest pass the keeper signed for another device ends first: this computer's own.
    expect(rowText('node_k')).toContain(`Not reachable for 4 days · passes end ${passEndLabel(now + 3 * DAY)}`)
    expect(rowText('node_b')).not.toContain('keeps your device list')
  })

  it('a keeper seen yesterday, or online, has no warning', async () => {
    nodes[1] = { ...nodes[1]!, lastSeenAt: now - DAY }
    await mount()
    expect(rowText('node_k')).toContain('keeps your device list')
    expect(rowText('node_k')).not.toContain('Not reachable')
    nodes[1] = { ...nodes[1]!, state: 'open', lastSeenAt: now - 5 * DAY }
    await act(async () => vi.advanceTimersByTime(5000))
    await flush()
    expect(rowText('node_k')).not.toContain('Not reachable')
  })
})

describe('a device’s detail', () => {
  it('a connected computer: what it may do here, and what that computer answers this one may do there', async () => {
    await mount()
    await open('Mini')
    expect(detail('May do here')).toBe('Works on threads · bots')
    expect(detail('This computer may do there')).toBe('Reads threads · bots')
    expect(request.mock.calls.filter(([method]) => method === 'bridge.access.there')).toContainEqual(['bridge.access.there', { node: 'node_b' }])
  })

  it('a computer not connected here may do nothing here, and one that has not connected this computer says so', async () => {
    await mount()
    await open('Desk PC')
    expect(detail('May do here')).toBe('Nothing · not connected here')
    expect(detail('This computer may do there')).toBe('Nothing · not connected there')
  })

  it('a computer on an older build is unknown', async () => {
    await mount()
    await open('Old Mac')
    expect(detail('This computer may do there')).toBe('Unknown')
  })

  it('a computer that goes offline is unknown, with when it last answered', async () => {
    await mount()
    await open('Mini')
    expect(detail('This computer may do there')).toBe('Reads threads · bots')
    nodes[2] = { ...nodes[2]!, state: 'closed', lastSeenAt: now }
    await act(async () => vi.advanceTimersByTime(5000))
    await flush()
    expect(detail('This computer may do there')).toBe('Unknown · last checked just now')
  })

  it('a phone: what it may do here, and no question to it', async () => {
    await mount()
    await open('Pixel')
    expect(detail('May do here')).toBe('Uses threads · bots')
    expect(detail('This computer may do there')).toBeUndefined()
    expect(request.mock.calls.filter(([method, params]) => method === 'bridge.access.there' && (params as { node: string }).node === 'node_p')).toEqual([])
  })
})
