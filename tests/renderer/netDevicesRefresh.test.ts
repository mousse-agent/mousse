// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NetDevicesSection } = await import('../../src/renderer/components/NetDevicesSection')

/** Networking is off; `net.status` fails while `statusFails` is set, and turning it on fails. */
const daemon = { statusFails: false }
const request = vi.fn(async (method: string) => {
  switch (method) {
    case 'net.status':
      if (daemon.statusFails) throw new Error('The Mousse service is not reachable')
      return { enabled: false, transports: [] }
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'net.init': throw new Error('Could not turn on networking')
    default: return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  daemon.statusFails = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'This Mac' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const poll = async () => { await act(async () => { vi.advanceTimersByTime(5_000) }); await flush() }
const shownError = () => host.querySelector('.devices-error')?.textContent ?? null

describe('devices background refresh', () => {
  it('clears its own error once a later refresh succeeds', async () => {
    await act(async () => root.render(createElement(NetDevicesSection)))
    await flush()
    expect(shownError()).toBeNull()
    daemon.statusFails = true
    await poll()
    expect(shownError()).toBe('The Mousse service is not reachable')
    daemon.statusFails = false
    await poll()
    expect(shownError()).toBeNull()
  })

  it('leaves the error of an action on screen', async () => {
    await act(async () => root.render(createElement(NetDevicesSection)))
    await flush()
    await act(async () => host.querySelector<HTMLElement>('[role="switch"][aria-label="Networking"]')!.click())
    await flush()
    expect(shownError()).toBe('Could not turn on networking')
    await poll()
    expect(shownError()).toBe('Could not turn on networking')
  })
})
