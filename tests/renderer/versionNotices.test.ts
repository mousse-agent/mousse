// @vitest-environment jsdom
/**
 * The one notice when a device is first found cut off for its version (pair-with-IP design §5): it shows wherever
 * the window is, as the computers list is read, once per refusal. The daemon keeps that it showed (`told`), so no
 * window shows it again until the refusal clears; a later refusal is told again.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetEngineDevice } from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ToastHost, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { refreshComputers, useComputersStore, NO_COMPUTERS } = await import('../../src/renderer/lib/computers')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const NOTICE = "Studio needs a Mousse update. It stays disabled here until it's updated."

const studio = (fields: Partial<NetEngineDevice> = {}): NetEngineDevice => ({
  node: 'n1',
  name: 'Studio',
  shortId: 'a1b2c3d4',
  state: 'offline',
  online: false,
  ...fields
})

let devices: NetEngineDevice[] = []
const shown: string[] = []
const request = vi.fn(async (method: string, params: { node?: string }) => {
  switch (method) {
    case 'net.status':
      return { enabled: false }
    case 'netEngine.status':
      return { enabled: true, on: true, helper: { state: 'running' }, devices, approvals: [] }
    case 'bridge.nodes':
      return { nodes: [] }
    case 'netEngine.versionNotice.shown':
      shown.push(params.node!)
      // As the daemon: it keeps that the notice showed.
      devices = devices.map((device) =>
        device.node === params.node && device.needsUpdate ? { ...device, needsUpdate: { ...device.needsUpdate, told: true } } : device
      )
      return {}
  }
  return {}
})

let root: Root
let host: HTMLElement
beforeEach(async () => {
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request } }
  useAppStore.setState({ profileReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ToastHost)))
})
afterEach(() => {
  act(() => dismissToast())
  act(() => root.unmount())
  host.remove()
  useComputersStore.setState(NO_COMPUTERS)
  shown.length = 0
})

const read = async () => {
  await act(async () => {
    await refreshComputers()
  })
}
/** The notices on screen (the toast host draws into the page, not under its own element). */
const notices = () => [...document.body.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent === NOTICE)

describe('the "needs a Mousse update" notice', () => {
  it('shows once for a device found cut off, and the daemon is told so it never repeats', async () => {
    devices = [studio({ needsUpdate: { who: 'there', since: 1_000 } }), studio({ node: 'n2', name: 'Server' })]
    await read()
    expect(notices()).toHaveLength(1)
    expect(shown).toEqual(['n1'])

    // Read again (another change, the window refocused): not again, here or in any window the daemon answers. A notice
    // shown again would be a new toast in place of this one.
    const first = notices()[0]
    await read()
    expect(notices()).toEqual([first])
    expect(shown).toEqual(['n1'])
  })

  it('says nothing for a refusal already told, and tells a new refusal of the same device', async () => {
    devices = [studio({ needsUpdate: { who: 'there', since: 2_000, told: true } })]
    await read()
    expect(notices()).toHaveLength(0)
    expect(shown).toEqual([])

    // It cleared and the device was cut off again later: the daemon forgot the notice with the refusal.
    devices = [studio({ needsUpdate: { who: 'there', since: 3_000 } })]
    await read()
    expect(notices()).toHaveLength(1)
    expect(shown).toEqual(['n1'])
  })
})
