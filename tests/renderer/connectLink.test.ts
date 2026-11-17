// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

/** The daemon as the Devices page sees it: a status, its devices, and answers or errors per method. */
const daemon: { status: NetStatus; nodes: unknown[]; answers: Record<string, (params: unknown) => unknown> } = { status: {} as NetStatus, nodes: [], answers: {} }
const request = vi.fn(async (method: string, params?: unknown) => {
  if (daemon.answers[method]) return daemon.answers[method](params)
  switch (method) {
    case 'net.status': return daemon.status
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes: daemon.nodes }
    case 'bridge.activity': return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
    default: return {}
  }
})
const failure = (code: string, details?: unknown) => Object.assign(new Error('generic daemon text'), { code, details })
const fresh: NetStatus = { enabled: false, keystore: 'missing', routes: [], peers: [] }
const keeper = { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], self: { node: 'node_a', user: 'user_a', isAuthority: true } } as unknown as NetStatus
const member = { ...keeper, self: { node: 'node_b', user: 'user_a', isAuthority: false } } as unknown as NetStatus
const row = (node: string, name: string, extra: Record<string, unknown>) => ({
  node, name, caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: Date.now() + 86_400_000, kind: 'computer', self: false, revoked: false, state: 'open', ...extra
})
const link = 'ml1_eyJ2IjoxfQ'

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  request.mockClear()
  daemon.status = fresh
  daemon.nodes = []
  daemon.answers = {}
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
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => { await act(async () => root.render(createElement(NetDevicesSection))); await flush() }
const button = (name: string | RegExp, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => typeof name === 'string' ? item.textContent?.trim() === name : name.test(item.textContent ?? ''))
const click = async (element: HTMLElement | undefined) => { expect(element).toBeDefined(); await act(async () => element!.click()); await flush() }
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
  await flush()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const alert = () => dialog()?.querySelector('[role="alert"]')?.textContent ?? null
const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)
const choose = async (action: 'add-link' | 'add-paste') => {
  await click(document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!)
  await click(document.querySelector<HTMLButtonElement>(`[role="menuitem"][data-action="${action}"]`)!)
}

describe('Make a link', () => {
  it('on a fresh computer makes the link as it opens, asking for a passphrase only once the keychain refuses', async () => {
    let refused = false
    daemon.answers['net.link.make'] = (params) => {
      if (!(params as { passphrase?: string }).passphrase && !refused) { refused = true; throw failure('keystore_locked', { reason: 'passphrase' }) }
      return { link, add: true, created: true, expiresAt: Date.now() + 1_800_000, reachable: true }
    }
    await mount()
    await choose('add-link')
    expect(calls('net.link.make')).toEqual([{ name: 'Laptop' }])
    const field = dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(dialog()!.textContent).toContain('The system keychain refused.')
    await type(field, 'correct horse')
    await click(button('Make link'))
    expect(calls('net.link.make')[1]).toEqual({ name: 'Laptop', passphrase: 'correct horse' })
    expect(dialog()!.textContent).toContain('This computer will keep the others connected. Pick the one that is usually on.')
    expect(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(link)
    expect(dialog()!.querySelector('[aria-label="Copy link"]')).not.toBeNull()
    expect(dialog()!.querySelector('input[type="password"]')).toBeNull()
  })

  it('on a member makes a link that only connects, names the keeper, and says when no other computer can reach it', async () => {
    daemon.status = member
    daemon.answers['net.link.make'] = () => ({ link, add: false, created: false, expiresAt: Date.now() + 1_800_000, reachable: false, keeper: 'Studio Mac' })
    await mount()
    await choose('add-link')
    expect(calls('net.link.make')).toEqual([{}])
    expect(dialog()!.textContent).toContain('To add a computer, make the link on Studio Mac.')
    expect(dialog()!.textContent).toContain('Only this computer can reach this link. Allow Mousse through the firewall, or turn on Tailscale or SSH.')
    expect(dialog()!.textContent).not.toContain('keep the others connected')
  })
})

describe('Paste a link', () => {
  it('reads what the link does without pasting it, then joins and ends on Allow or Not now for the computer that made it', async () => {
    daemon.answers['net.link.check'] = () => ({ row: 'join', add: true })
    daemon.answers['net.link.paste'] = () => ({ row: 'join', node: 'node_a', name: 'Studio Mac', connection: 'held', connected: true })
    daemon.answers['bridge.allow'] = () => ({ connection: 'connected' })
    await mount()
    await choose('add-paste')
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, ` ${link}\n`)
    expect(calls('net.link.check')).toEqual([{ link }])
    expect(calls('net.link.paste')).toEqual([])
    expect(dialog()!.textContent).toContain('This computer joins the computer that made the link.')
    await click(button('Join'))
    expect(calls('net.link.paste')).toEqual([{ link, name: 'Laptop' }])
    expect(dialog()!.textContent).toContain('Joined Studio Mac.')
    expect(button('Not now')).toBeDefined()
    expect(button('Allow')!.title).toContain('Work on threads')
    await click(button('Allow'))
    expect(calls('bridge.allow')).toEqual([{ node: 'node_a' }])
    expect(dialog()).toBeNull()
  })

  it('says why a link can’t be used here and offers nothing to press', async () => {
    daemon.status = member
    daemon.answers['net.link.check'] = () => ({ row: 'refused', add: true, reason: 'other_list' })
    await mount()
    await choose('add-paste')
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, link)
    expect(alert()).toBe('This computer is in another list. Two lists can’t be merged.')
    expect(button(/^(Join|Connect|Start over and join)$/)).toBeUndefined()
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, 'hello')
    daemon.answers['net.link.check'] = () => { throw failure('bad_request') }
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, 'not a link')
    expect(alert()).toBe('This isn’t a Mousse link.')
  })

  it('on a computer set up alone, starts over only when asked, or makes a link here instead', async () => {
    daemon.status = { ...keeper }
    daemon.answers['net.link.check'] = () => ({ row: 'start_over', add: true, startOver: { allowed: 'alone', keeper: true, spaces: [] } })
    daemon.answers['net.link.paste'] = () => { throw failure('route_unreachable', { reason: 'link_unreachable' }) }
    daemon.answers['net.link.make'] = () => ({ link, add: true, created: false, expiresAt: Date.now() + 1_800_000, reachable: true })
    await mount()
    await choose('add-paste')
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, link)
    expect(dialog()!.textContent).toContain('This computer is set up alone, so it starts over first.')
    await click(button('Start over and join'))
    expect(calls('net.link.paste')).toEqual([{ link, startOver: true }])
    // No route: the words name the fix on the computer that made the link.
    expect(alert()).toBe('Couldn’t reach the computer that made this link. On it, allow Mousse through the firewall, or connect both computers with Tailscale or SSH.')
    await click(button('Make a link here instead'))
    // The paste screen gives way to a link made here.
    expect(calls('net.link.make')).toEqual([{}])
    expect(dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Connect link"]')!.value).toBe(link)
  })

  it('offers to start from this computer only where the topology allows, and a stale link asks for a new one', async () => {
    daemon.status = member
    let row = 'connect'
    daemon.answers['net.link.check'] = () => ({ row, add: false })
    daemon.answers['net.link.paste'] = () => { throw failure('route_unreachable', { reason: 'link_unreachable' }) }
    await mount()
    await choose('add-paste')
    const field = () => dialog()!.querySelector<HTMLTextAreaElement>('textarea')!
    await type(field(), link)
    await click(button('Connect'))
    expect(button('Start from this computer instead')).toBeDefined()

    // Joining a computer that keeps other devices can't go the other way round.
    row = 'join'
    await type(field(), `${link}A`)
    await click(button('Join'))
    expect(alert()).toContain('allow Mousse through the firewall')
    expect(button('Start from this computer instead')).toBeUndefined()

    daemon.answers['net.link.paste'] = () => { throw failure('invite_invalid', { reason: 'stale' }) }
    await click(button('Join'))
    expect(alert()).toBe('This link was used or replaced. Make a new link.')
  })
})

describe('Allow', () => {
  it('on the computer that made the link, a held computer wants to connect, with Allow and Remove, and is not offered Connect', async () => {
    daemon.status = keeper
    daemon.nodes = [row('node_a', 'Studio Mac', { self: true, keeper: true, connection: 'connected' }), row('node_b', 'Laptop', { connection: 'held', routeHeld: true })]
    await mount()
    const notice = [...host.querySelectorAll<HTMLElement>('.settings-item')].find((item) => item.textContent?.includes('Laptop wants to connect'))!
    expect(notice).toBeDefined()
    const allow = button('Allow', notice)!
    expect(allow.title).toContain('signed in to Mousse ID connect it on their own')
    expect(button('Remove…', notice)).toBeDefined()
    expect(button('Not now', notice)).toBeUndefined()
    const laptop = host.querySelector<HTMLElement>('[data-device-node="node_b"]')!
    expect(laptop.textContent).toContain('waits for Allow')
    expect(button('Connect', laptop)).toBeUndefined()
    await click(allow)
    expect(calls('bridge.allow')).toEqual([{ node: 'node_b' }])
  })

  it('on the computer that joined, Not now puts the notice away and leaves Allow in the detail', async () => {
    daemon.status = member
    daemon.nodes = [row('node_b', 'Laptop', { self: true, connection: 'connected' }), row('node_a', 'Studio Mac', { keeper: true, connection: 'held', routeHeld: true })]
    await mount()
    expect(host.textContent).toContain('Allow Studio Mac to work here?')
    expect(button('Remove…')).toBeUndefined()
    await click(button('Not now'))
    expect(host.textContent).not.toContain('Allow Studio Mac to work here?')
    expect(calls('bridge.disconnect')).toEqual([])
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Show details for Studio Mac"]')!)
    expect(host.textContent).toContain('Waits for Allow')
    await click(button('Allow'))
    expect(calls('bridge.allow')).toEqual([{ node: 'node_a' }])
  })

  it('Not now after a join puts the page’s own notice for that computer away too', async () => {
    daemon.answers['net.link.check'] = () => ({ row: 'join', add: true })
    daemon.answers['net.link.paste'] = () => {
      daemon.status = member
      daemon.nodes = [row('node_b', 'Laptop', { self: true, connection: 'connected' }), row('node_a', 'Studio Mac', { keeper: true, connection: 'held', routeHeld: true })]
      return { row: 'join', node: 'node_a', name: 'Studio Mac', connection: 'held', connected: true }
    }
    await mount()
    await choose('add-paste')
    await type(dialog()!.querySelector<HTMLTextAreaElement>('textarea')!, link)
    await click(button('Join'))
    await click(button('Not now', dialog()!))
    expect(dialog()).toBeNull()
    expect(host.querySelector('[data-device-node="node_a"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Allow Studio Mac to work here?')
    expect(calls('bridge.allow')).toEqual([])
  })
})
