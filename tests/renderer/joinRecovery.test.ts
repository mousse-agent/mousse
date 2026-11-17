// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

/** The daemon as the Devices page sees it: a status, and answers or errors per method. */
const daemon: { status: NetStatus; answers: Record<string, () => unknown> } = { status: { enabled: false, keystore: 'missing', routes: [], peers: [] }, answers: {} }
const request = vi.fn(async (method: string, _params?: unknown) => {
  if (daemon.answers[method]) return daemon.answers[method]()
  switch (method) {
    case 'net.status': return daemon.status
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return { nodes: [] }
    default: return {}
  }
})
/** A join error as it crosses the bridge: a code, and the reason and other computer in its details. */
const joinError = (code: string, details?: unknown) => Object.assign(new Error('generic daemon text'), { code, details })

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  request.mockClear()
  daemon.status = { enabled: false, keystore: 'missing', routes: [], peers: [] }
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
const button = (name: string | RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => typeof name === 'string' ? item.textContent?.trim() === name : name.test(item.textContent ?? ''))
const click = async (element: HTMLElement | undefined) => { expect(element).toBeDefined(); await act(async () => element!.click()); await flush() }
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const alert = () => document.querySelector('[role="alert"]')?.textContent ?? null
const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

describe('a join whose answer never arrived', () => {
  beforeEach(() => {
    daemon.status = { enabled: false, keystore: 'unlocked', routes: [], peers: [], unfinishedJoin: { name: 'Studio Mac' } }
  })

  it('offers Retry, and says why a retry failed in plain words', async () => {
    daemon.answers['net.join.retry'] = () => { throw joinError('route_unreachable', { reason: 'unreachable', label: 'Studio Mac' }) }
    await mount()
    expect(host.textContent).toContain('Finishing the connection to Studio Mac')
    // Networking can't start a new set of devices meanwhile.
    expect(host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Networking"]')!.disabled).toBe(true)
    await click(button('Retry'))
    expect(calls('net.join.retry')).toEqual([{}])
    expect(alert()).toBe('Couldn’t reach Studio Mac. Check that it’s on and that both computers are on the same network or tailnet, then try again.')
  })

  it('asks for the passphrase before a retry when the keys are locked', async () => {
    daemon.status = { ...daemon.status, keystore: 'locked' }
    await mount()
    expect(button('Retry')?.disabled).toBe(true)
    await type(host.querySelector<HTMLInputElement>('input[type="password"]')!, 'secret words')
    await click(button('Retry'))
    expect(calls('net.join.retry')).toEqual([{ passphrase: 'secret words' }])
  })

  it('Give up is confirmed, naming the computer that may keep a row', async () => {
    await mount()
    await click(button('Give up…'))
    expect(document.body.textContent).toContain('Studio Mac may already list this computer')
    expect(calls('net.join.abandon')).toEqual([])
    await click(button('Give up'))
    expect(calls('net.join.abandon')).toEqual([{}])
  })
})

describe('joining with a link', () => {
  const openJoin = async () => {
    await click(button(/Add device/))
    await click(button(/Join with invitation/))
  }

  it('asks for no passphrase unless the keychain refuses, then asks once', async () => {
    let refuse = true
    daemon.answers['bridge.join'] = () => {
      if (refuse) { refuse = false; throw joinError('keystore_locked') }
      return { connected: true }
    }
    await mount()
    await openJoin()
    expect(document.querySelectorAll('.devices-dialog input[type="password"]')).toHaveLength(0)
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Device invitation to join"]')!, 'mj1_link')
    await click(button('Join'))
    expect(calls('bridge.join')).toEqual([{ invite: 'mj1_link', name: 'Laptop' }])
    expect(alert()).toBe('The system keychain refused to protect this computer’s keys. Set a passphrase to continue.')
    const passphrase = document.querySelector<HTMLInputElement>('.devices-dialog input[type="password"]')!
    await type(passphrase, 'secret words')
    await click(button('Join'))
    expect(calls('bridge.join')[1]).toEqual({ invite: 'mj1_link', name: 'Laptop', passphrase: 'secret words' })
  })

  it('names the other computer when the clocks are apart', async () => {
    daemon.answers['bridge.join'] = () => { throw joinError('clock_skew', { reason: 'clock', label: 'Studio Mac' }) }
    await mount()
    await openJoin()
    await type(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Device invitation to join"]')!, 'mj1_link')
    await click(button('Join'))
    expect(alert()).toBe('The clocks on this computer and Studio Mac are too far apart. Set both to the correct time, then try again.')
  })
})

it('moves passphrase-protected keys to the keychain in one click', async () => {
  daemon.status = { enabled: true, keystore: 'unlocked', protected: true, passphraseProtected: true, routes: [], peers: [], self: { node: 'node_a' as never, user: 'user_a' as never, isAuthority: true } }
  await mount()
  await click(button('Use the keychain'))
  expect(calls('net.protect')).toEqual([{}])
})
