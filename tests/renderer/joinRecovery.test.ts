// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetStatus } from '../../src/shared/net'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')

/** The daemon as the Devices page sees it: a status, and answers or errors per method. */
const daemon: { status: NetStatus; answers: Record<string, () => unknown> } = { status: { enabled: false, keystore: 'missing', routes: [], peers: [] }, answers: {} }
const request = vi.fn(async (method: string, _params?: unknown) => {
  if (daemon.answers[method]) return daemon.answers[method]()
  switch (method) {
    case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
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
const mount = async () => { await act(async () => root.render(createElement(EngineDevicesSection))); await flush() }
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
    expect(host.textContent).toContain('Studio Mac')
    expect(host.textContent).toContain('Connecting didn’t finish')
    await click(button('Retry'))
    expect(calls('net.join.retry')).toEqual([{}])
    expect(alert()).toBe('Couldn’t reach Studio Mac. Check that it’s on and that both computers are on the same network or tailnet, then try again.')
  })

  it('says why a retry failed for a lapsed pass too, where no Reconnecting note shows', async () => {
    daemon.answers['net.join.retry'] = () => { throw joinError('bad_delegation') }
    await mount()
    await click(button('Retry'))
    expect(alert()).toBeTruthy()
    expect(alert()).not.toContain('bad_delegation')
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
