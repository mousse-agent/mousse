// @vitest-environment jsdom
/**
 * The two controls of which devices reach a bot, on the screens a person uses: About → Devices (each bot), and Bots on
 * this computer under each device in Settings → Devices. Each saves what was picked, and nothing else.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotAboutPanel } = await import('../../src/renderer/components/bots/BotAboutPanel')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

let root: Root
let host: HTMLElement
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click() }); await flush() }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('About → Devices', () => {
  let fake: FakeBots
  const botsInitial = useBotsStore.getInitialState()
  const bot = summary('b1', { name: 'Server keeper' })
  beforeEach(() => {
    fake = fakeBots({ bots: [bot] })
    fake.devices.b1 = {
      access: { mode: 'all' },
      devices: [
        { node: 'nod_pocket', name: 'Pocket', kind: 'phone' },
        { node: 'nod_tablet', name: 'Tablet', kind: 'computer', botsOff: true }
      ]
    }
    installPreload(fake)
    setBotsClient(fake.client)
  })
  afterEach(() => {
    setBotsClient(null)
    useBotsStore.setState(botsInitial)
  })
  const show = async () => {
    await act(async () => root.render(createElement(BotAboutPanel, { bot })))
    await flush()
  }
  const pick = async (label: string) => {
    await click(host.querySelector('[aria-label="Devices that reach Server keeper"]'))
    await click([...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes(label)))
  }
  const ticks = () => [...host.querySelectorAll<HTMLInputElement>('[data-testid="bot-about-device"] input')]

  it('shows one row, All my devices at first, whose tooltip says what a device left out sees', async () => {
    await show()
    const row = host.querySelector('[data-testid="bot-about-devices"]')!
    expect(row.textContent).toContain('Devices')
    expect(row.textContent).toContain('All my devices')
    expect(row.querySelector('span')!.getAttribute('title')).toMatch(/sees nothing of this bot/)
    expect(ticks()).toHaveLength(0)
  })

  it('saves Only this computer, then Chosen devices ticked one by one, and says which device has bots off', async () => {
    await show()
    await pick('Only this computer')
    expect(fake.calls.filter(([name]) => name === 'setDevices')).toEqual([['setDevices', 'b1', { mode: 'this_computer' }]])
    await pick('Chosen devices')
    expect(fake.calls.at(-1)).toEqual(['setDevices', 'b1', { mode: 'chosen', nodes: [] }])
    expect(ticks().map((input) => input.checked)).toEqual([false, false])
    await click(ticks()[0])
    expect(fake.calls.at(-1)).toEqual(['setDevices', 'b1', { mode: 'chosen', nodes: ['nod_pocket'] }])
    expect(ticks().map((input) => input.checked)).toEqual([true, false])
    expect(host.querySelectorAll('[data-testid="bot-about-device"]')[1]!.textContent).toContain('Bots off for this device')
    await click(ticks()[0])
    expect(fake.calls.at(-1)).toEqual(['setDevices', 'b1', { mode: 'chosen', nodes: [] }])
  })

  it('a refused change goes back to what was saved and says why', async () => {
    await show()
    vi.mocked(fake.client.setDevices).mockRejectedValueOnce({ code: 'forbidden', message: 'Change which devices reach a bot on its own computer.' })
    await pick('Only this computer')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Change which devices reach a bot on its own computer.')
    expect(host.querySelector('[data-testid="bot-about-devices"]')!.textContent).toContain('All my devices')
  })

  it('with an older service, which has no such choice, shows no row', async () => {
    vi.mocked(fake.client.devices).mockRejectedValueOnce({ code: 'unknown_method', message: 'Unknown method' })
    await show()
    expect(host.querySelector('[data-testid="bot-about-devices"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('Settings → Devices → Bots on this computer', () => {
  const nodes = [
    { node: 'nod_self', name: 'Desk', caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: true, revoked: false, state: 'open' },
    { node: 'nod_pocket', name: 'Pocket', caps: ['read', 'chat', 'write'], keyEpoch: 1, expiresAt: 0, kind: 'phone', self: false, revoked: false, state: 'open', policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true } },
    { node: 'nod_old', name: 'Old laptop', caps: ['read'], keyEpoch: 1, expiresAt: 0, kind: 'phone', self: false, revoked: false, state: 'open', policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false } }
  ]
  const request = vi.fn(async (method: string, params?: { node?: string; bots?: boolean }) => {
    switch (method) {
      case 'net.status': return { enabled: true, keystore: 'unlocked', protected: true, self: { node: 'nod_self', isAuthority: true }, transports: [], peers: [], routes: [], workOnThreads: true, shareBots: true }
      case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
      case 'net.ssh.list': return { records: [] }
      case 'bridge.nodes': return { nodes }
      case 'bridge.policy': {
        const device = nodes.find((entry) => entry.node === params?.node)!
        device.policy = { ...device.policy!, bots: params!.bots! }
        return { policy: device.policy }
      }
      default: return {}
    }
  })
  beforeEach(() => {
    request.mockClear()
    ;(window as unknown as { mousse: unknown }).mousse = {
      platformRequest: { request },
      app: { getInfo: async () => ({ deviceName: 'Desk' }) },
      editorAsks: { list: async () => [], onChanged: () => () => undefined }
    }
  })
  const toggle = () => host.querySelector<HTMLElement>('[role="switch"][aria-label="Bots on this computer for Pocket"]')

  it('a phone has the switch, on at first; off is saved for that device alone and reads Off', async () => {
    await act(async () => root.render(createElement(NetDevicesSection)))
    await flush()
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('On · reaches this computer\'s bots')
    // A service from before the switch sends none for a device, and shows no switch for it.
    expect(host.querySelector('[aria-label="Bots on this computer for Old laptop"]')).toBeNull()
    await click(toggle())
    expect(request).toHaveBeenCalledWith('bridge.policy', { node: 'nod_pocket', bots: false })
    expect(request.mock.calls.filter(([method]) => method === 'bridge.policy')).toHaveLength(1)
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('Off · sees none of this computer\'s bots')
  })
})
