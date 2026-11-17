// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

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
const nodes = [
  row('node_a', 'Studio Mac', { self: true, connection: 'connected' }),
  row('node_b', 'Laptop', { connection: 'none', routeHeld: true }),
  row('node_c', 'Desk PC', { connection: 'disconnected', routeHeld: false }),
  row('node_d', 'Mini', { connection: 'connected', routeHeld: true, state: 'open' })
]
const request = vi.fn(async (method: string, _params?: unknown) => {
  switch (method) {
    case 'net.status':
      return { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], self: { node: 'node_a', user: 'user_a', isAuthority: true } } as unknown as NetStatus
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes }
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
const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

it('a device not connected here offers Connect when its route is held, and a link from it otherwise', async () => {
  await act(async () => root.render(createElement(NetDevicesSection)))
  await flush()
  const laptop = rowOf('node_b'), desk = rowOf('node_c')
  expect(laptop.textContent).toContain('Not connected here')
  expect(desk.textContent).toContain('Not connected here')
  expect(desk.textContent).toContain('Paste a link from Desk PC')
  expect(buttonIn(desk, 'Connect')).toBeUndefined()
  await act(async () => buttonIn(laptop, 'Connect')!.click())
  await flush()
  expect(calls('bridge.connect')).toEqual([{ node: 'node_b' }])
})

it('a connected device offers Disconnect in its menu, and one not connected does not', async () => {
  await act(async () => root.render(createElement(NetDevicesSection)))
  await flush()
  const mini = rowOf('node_d')
  expect(mini.textContent).not.toContain('Not connected here')
  await act(async () => mini.querySelector<HTMLButtonElement>('[aria-label="More actions for Mini"]')!.click())
  await act(async () => [...mini.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Disconnect')!.click())
  await flush()
  expect(calls('bridge.disconnect')).toEqual([{ node: 'node_d' }])
  await act(async () => rowOf('node_b').querySelector<HTMLButtonElement>('[aria-label="More actions for Laptop"]')!.click())
  expect([...rowOf('node_b').querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).not.toContain('Disconnect')
})
