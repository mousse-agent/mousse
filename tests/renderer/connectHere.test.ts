// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')

const row = (node: string, name: string, extra: Record<string, unknown>) => ({
  node,
  name,
  caps: ['read', 'chat', 'write', 'settings'],
  keyEpoch: 1,
  expiresAt: Date.now() + 86_400_000,
  kind: 'computer',
  self: false,
  revoked: false,
  state: 'closed',
  ...extra
})
const policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true, agentReach: 'launched', work: true }
const nodes = [
  row('node_a', 'Studio Mac', { self: true, connection: 'connected' }),
  row('node_b', 'Laptop', { connection: 'none', routeHeld: true, policy }),
  row('node_c', 'Desk PC', { connection: 'disconnected', routeHeld: false }),
  row('node_d', 'Mini', { connection: 'connected', routeHeld: true, state: 'open', policy })
]
const request = vi.fn(async (method: string, _params?: unknown) => {
  switch (method) {
    case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
    case 'net.status':
      return { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], self: { node: 'node_a', user: 'user_a', isAuthority: true } } as unknown as NetStatus
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes }
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
    app: { getInfo: async () => ({ deviceName: 'Studio Mac' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const rowOf = (node: string) => document.querySelector<HTMLElement>(`[data-device-node="${node}"]`)!
const buttonIn = (element: ParentNode, name: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === name)
/** Chooses a device in the list; its detail, with its Access, shows beside the list. */
const openAccess = async (name: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`)!.click())
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

it('a device not connected here offers Connect when its route is held, and a link from it otherwise', async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
  const laptop = rowOf('node_b'), desk = rowOf('node_c')
  expect(laptop.textContent).toContain('Not connected here')
  expect(desk.textContent).toContain('Not connected here')
  // Connect sits in the row's menu, only where this computer holds its routes.
  await act(async () => desk.querySelector<HTMLElement>('[aria-label="Actions for Desk PC"]')?.click())
  expect(menuItem('Connect')).toBeUndefined()
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Actions for Laptop"]')!.click())
  await act(async () => menuItem('Connect')!.click())
  await flush()
  expect(calls('bridge.connect')).toEqual([{ node: 'node_b' }])
})

it('a device not connected here shows none of what it may do here until it is', async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
  await openAccess('Laptop')
  expect(document.body.textContent).not.toContain('Access from this device')
  expect(document.body.textContent).not.toContain('Terminals from this device')
  await openAccess('Mini')
  expect(document.body.textContent).toContain('Access from this device')
  expect(document.body.textContent).toContain('Terminals from this device')
})
