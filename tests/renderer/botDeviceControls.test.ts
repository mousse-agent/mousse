// @vitest-environment jsdom
/**
 * The controls of which devices reach a bot, on the screens a person uses: About → Devices (each bot), Make private in
 * the bot's menu, and Bots on this computer under each device in Settings → Devices. Each saves what was picked, and
 * nothing else.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBots, installPreload, summary, type FakeBots } from './fakeBotsClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BotAboutPanel } = await import('../../src/renderer/components/bots/BotAboutPanel')
const { BotMenu } = await import('../../src/renderer/components/bots/BotMenu')
const { setBotsClient, useBotsStore } = await import('../../src/renderer/stores/botsStore')
const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')

let root: Root
let host: HTMLElement
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click() }); await flush() }

beforeEach(() => {
  // Devices sits in About's Runs on section, which opens on a click: open it, as the owner had.
  window.localStorage.setItem('mousse-profile-default-mousse:bot-about-open', JSON.stringify(['setup']))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.localStorage.clear()
})

describe('About → Devices', () => {
  let fake: FakeBots
  const botsInitial = useBotsStore.getInitialState()
  const bot = summary('b1', { name: 'Server keeper' })
  beforeEach(() => {
    fake = fakeBots({ bots: [bot] })
    fake.devices.b1 = {
      access: { mode: 'this_computer' },
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
  const toggle = (name: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name} reaches Server keeper"]`)
  const ticks = () => [...host.querySelectorAll('[data-testid="bot-about-device"] [role="switch"]')].map((item) => item.getAttribute('aria-checked'))
  const saves = () => fake.calls.filter(([name]) => name === 'setDevices')

  it('this computer always on, each other device off at first; the tooltip says what a device left out sees', async () => {
    await show()
    const row = host.querySelector('[data-testid="bot-about-devices"]')!
    expect(row.textContent).toContain('Devices')
    expect(row.querySelector('span')!.getAttribute('title')).toMatch(/sees nothing of this bot/)
    expect(toggle('This computer')?.getAttribute('aria-checked')).toBe('true')
    expect(toggle('This computer')?.disabled).toBe(true)
    expect(ticks()).toEqual(['false', 'false'])
    expect(host.querySelectorAll('[data-testid="bot-about-device"]')[1]!.textContent).toContain('Bots off for this device')
  })

  it('saves each device turned on, and this computer alone once the last is off', async () => {
    await show()
    await click(toggle('Pocket'))
    expect(saves()).toEqual([['setDevices', 'b1', { mode: 'chosen', nodes: ['nod_pocket'] }]])
    await click(toggle('Tablet'))
    expect(saves().at(-1)).toEqual(['setDevices', 'b1', { mode: 'chosen', nodes: ['nod_pocket', 'nod_tablet'] }])
    expect(ticks()).toEqual(['true', 'true'])
    await click(toggle('Pocket'))
    await click(toggle('Tablet'))
    expect(saves().at(-1)).toEqual(['setDevices', 'b1', { mode: 'this_computer' }])
    expect(ticks()).toEqual(['false', 'false'])
  })

  it('with no other device, says only this computer reaches it', async () => {
    fake.devices.b1 = { access: { mode: 'this_computer' }, devices: [] }
    await show()
    expect(host.querySelector('[data-testid="bot-about-devices"]')!.textContent).toContain('Only this computer')
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('a refused change goes back to what was saved and says why', async () => {
    await show()
    vi.mocked(fake.client.setDevices).mockRejectedValueOnce({ code: 'forbidden', message: 'Change which devices reach a bot on its own computer.' })
    await click(toggle('Pocket'))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Change which devices reach a bot on its own computer.')
    expect(ticks()).toEqual(['false', 'false'])
  })

  it('with an older service, which has no such choice, shows no row', async () => {
    vi.mocked(fake.client.devices).mockRejectedValueOnce({ code: 'unknown_method', message: 'Unknown method' })
    await show()
    expect(host.querySelector('[data-testid="bot-about-devices"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('Make private in the bot\'s menu', () => {
  let fake: FakeBots
  const botsInitial = useBotsStore.getInitialState()
  afterEach(() => {
    setBotsClient(null)
    useBotsStore.setState(botsInitial)
  })
  /** The bot's menu and its About, both reading the bot from the list, as the chat header and About do. */
  function Bot() {
    const bot = useBotsStore((state) => state.bots.find((entry) => entry.id === 'b1'))
    // The store is emptied after each test, before the root unmounts.
    if (!bot) return null
    return createElement('div', null, createElement(BotMenu, { bot }), createElement(BotAboutPanel, { bot }))
  }
  const show = async (reach?: 'chosen' | 'this_computer') => {
    const bot = summary('b1', { name: 'Server keeper', ...(reach ? { reach } : {}) })
    fake = fakeBots({ bots: [bot] })
    if (reach) fake.devices.b1 = { access: reach === 'chosen' ? { mode: 'chosen', nodes: ['nod_pocket'] } : { mode: 'this_computer' }, devices: [{ node: 'nod_pocket', name: 'Pocket', kind: 'phone' }] }
    installPreload(fake)
    setBotsClient(fake.client)
    useBotsStore.setState({ bots: [bot] })
    await act(async () => root.render(createElement(Bot)))
    await flush()
  }
  const items = async () => {
    await click(host.querySelector('[aria-label="Bot menu"]'))
    const names = [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    await act(async () => { host.querySelector('.bot-menu-root')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    return names
  }
  const pocket = () => host.querySelector('[role="switch"][aria-label="Pocket reaches Server keeper"]')!.getAttribute('aria-checked')

  it('saves this computer alone in one click, and About and the menu follow', async () => {
    await show('chosen')
    expect(pocket()).toBe('true')
    await click(host.querySelector('[aria-label="Bot menu"]'))
    await click([...host.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Make private'))
    expect(fake.calls.filter(([name]) => name === 'setDevices')).toEqual([['setDevices', 'b1', { mode: 'this_computer' }]])
    expect(useBotsStore.getState().bots[0]?.reach).toBe('this_computer')
    expect(pocket()).toBe('false')
    expect(await items()).not.toContain('Make private')
  })

  it('there is nothing to offer for one already private, or with a service that does not say', async () => {
    await show('this_computer')
    expect(await items()).not.toContain('Make private')
    act(() => root.unmount())
    root = createRoot(host)
    await show()
    expect(await items()).not.toContain('Make private')
  })
})

/** Chooses a device in the list; its detail, with its Access, shows beside the list. */
const openAccess = async (name: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`)!.click())
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('Settings → Devices → Bots on this computer', () => {
  const nodes = [
    { node: 'nod_self', name: 'Desk', caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: true, revoked: false, state: 'open' },
    { node: 'nod_pocket', name: 'Pocket', caps: ['read', 'chat', 'write'], keyEpoch: 1, expiresAt: 0, kind: 'phone', self: false, revoked: false, state: 'open', policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true } },
    { node: 'nod_old', name: 'Old laptop', caps: ['read'], keyEpoch: 1, expiresAt: 0, kind: 'phone', self: false, revoked: false, state: 'open', policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false } }
  ]
  const request = vi.fn(async (method: string, params?: { node?: string; bots?: boolean }) => {
    switch (method) {
      case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
      case 'net.status': return { enabled: true, keystore: 'unlocked', protected: true, self: { node: 'nod_self', isAuthority: true }, transports: [], peers: [], routes: [], workOnThreads: true }
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
    await act(async () => root.render(createElement(EngineDevicesSection)))
    await flush()
    // The switch is in each device's detail, one open at a time.
    const details = (name: string) => openAccess(name)
    // A service from before the switch sends none for a device, and shows no switch for it.
    await details('Old laptop')
    expect(host.querySelector('[aria-label="Bots on this computer for Old laptop"]')).toBeNull()
    await details('Pocket')
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('On · reaches this computer\'s bots')
    await click(toggle())
    expect(request).toHaveBeenCalledWith('bridge.policy', { node: 'nod_pocket', bots: false })
    expect(request.mock.calls.filter(([method]) => method === 'bridge.policy')).toHaveLength(1)
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('Off · sees none of this computer\'s bots')
  })
})
