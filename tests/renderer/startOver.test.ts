// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
const calls = (method: string) => request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

const keeper = { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], self: { node: 'node_a' as never, user: 'user_a' as never, isAuthority: true } } as NetStatus

it('Start over confirms what resets and which Spaces to join again, then starts over', async () => {
  daemon.status = keeper
  daemon.answers['net.startOver.check'] = () => ({ allowed: 'alone', keeper: true, spaces: ['Design review'] })
  await mount()
  await click(button('Start over…'))
  const dialog = document.body.textContent!
  expect(dialog).toContain('Start over on this computer?')
  expect(dialog).toContain('Bot signing keys, Space chat links, SSH approvals and links from other computers reset.')
  expect(dialog).toContain('with the key that kept these devices')
  expect(dialog).toContain('Join Design review again afterwards.')
  expect(calls('net.startOver')).toEqual([])
  await click(button('Start over'))
  expect(calls('net.startOver')).toEqual([{}])
})

it('a refused Start over says what stands in the way and offers nothing to press', async () => {
  daemon.status = keeper
  daemon.answers['net.startOver.check'] = () => ({ refused: 'live_devices', keeper: true, live: ['Laptop', 'Phone'], spaces: [] })
  await mount()
  await click(button('Start over…'))
  expect(document.body.textContent).toContain('Laptop, Phone still rely on this computer. Remove them first, then start over.')
  expect(button('Start over')).toBeUndefined()
})
