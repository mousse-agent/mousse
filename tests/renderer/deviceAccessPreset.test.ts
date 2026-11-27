// @vitest-environment jsdom
/**
 * Settings → Devices: what another computer may do here, as one of three presets in its detail (View and chat with bots,
 * Work on threads, Full control). A preset sets the device's fields at once; fields that match none show as Custom,
 * with the single switches still there. A phone has no preset. The page is mounted as a person uses it, with only the
 * daemon stubbed; the daemon's side is `tests/net/bridge/routed/accessClasses.test.ts`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BridgeNodePolicy } from '../../src/shared/net/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')

let root: Root
let host: HTMLElement
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => { (element as HTMLElement).click() })
  await flush()
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label)

const DEFAULTS: BridgeNodePolicy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true, agentReach: 'launched', work: true }
let policy: BridgeNodePolicy
const computer = (node: string, name: string, extra: Record<string, unknown>) =>
  ({ node, name, caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state: 'open', ...extra })
const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
  switch (method) {
    case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
    case 'net.status': return { enabled: true, keystore: 'unlocked', protected: true, self: { node: 'nod_self', isAuthority: true }, transports: [], peers: [], routes: [], workOnThreads: true }
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return {
      nodes: [
        computer('nod_self', 'Desk', { self: true }),
        computer('nod_mac', 'Mac', { policy }),
        computer('nod_phone', 'Pocket', { kind: 'phone', caps: ['read', 'chat', 'write'], policy: DEFAULTS })
      ]
    }
    case 'bridge.activity': return { node: params!.node, since: 0, counts: [], uncertain: 0, refused: 0, entries: [], reads: { calls: 0, bytes: 0, hours: [] }, rules: [] }
    case 'bridge.policy': {
      const { node: _node, ...change } = params!
      policy = { ...policy, ...change }
      return { policy }
    }
    default: return {}
  }
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  request.mockClear()
  policy = { ...DEFAULTS }
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'Desk' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Chooses a device in the list; its detail, with its Access, shows beside the list. */
const openAccess = async (name: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`)!.click())
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
/** Chooses one device; only its detail shows. */
const openDetail = openAccess
const showDevices = async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
  await openDetail('Mac')
}
const presets = () => [...document.querySelectorAll<HTMLElement>('[role="radiogroup"]')].filter((group) => group.querySelector('[role="radio"]')?.textContent === 'View and chat')
const picked = () => presets()[0]!.querySelector('[role="radio"][aria-checked="true"]')?.textContent
const policyCalls = () => request.mock.calls.filter(([method]) => method === 'bridge.policy').map(([, params]) => params)

it('a computer with the defaults works on threads; each preset sets its fields at once and shows picked', async () => {
  await showDevices()
  // One preset control: the computer's. The phone has none.
  expect(presets()).toHaveLength(1)
  await openDetail('Pocket')
  expect(presets()).toHaveLength(0)
  await openDetail('Mac')
  expect(picked()).toBe('Work on threads')

  await click(button('View and chat'))
  expect(policyCalls()).toEqual([{ node: 'nod_mac', work: false, terminal: false, editor: false, maxPermissionMode: 'accept_edits', agentReach: 'launched' }])
  expect(picked()).toBe('View and chat')

  await click(button('Full control'))
  expect(policyCalls()[1]).toEqual({ node: 'nod_mac', work: true, terminal: true, editor: true, maxPermissionMode: 'full', agentReach: 'all' })
  expect(picked()).toBe('Full control')

  await click(button('Work on threads'))
  expect(policy).toMatchObject({ ...DEFAULTS })
  expect(picked()).toBe('Work on threads')
})

it('fields that match no preset show Custom, with no preset picked and the single switches still there', async () => {
  policy = { ...DEFAULTS, work: false, terminal: true }
  await showDevices()
  expect(picked()).toBeUndefined()
  expect(presets()[0]!.closest('.settings-item')!.textContent).toContain('Custom')
  expect(document.querySelector('[role="switch"][aria-label="Terminals from Mac"]')).not.toBeNull()

  // Limits keeps the work switch on its own.
  await click(button('Limits…'))
  await click(document.querySelector('[role="dialog"] [role="switch"][aria-label="Work on threads from Mac"]'))
  await click(button('Save'))
  expect(policyCalls()).toEqual([{ node: 'nod_mac', work: true }])
})

it('a computer whose service predates the switch shows no preset', async () => {
  const { work: _gone, ...older } = DEFAULTS
  policy = older
  await showDevices()
  expect(presets()).toHaveLength(0)
  expect(document.querySelector('[role="switch"][aria-label="Terminals from Mac"]')).not.toBeNull()
})
