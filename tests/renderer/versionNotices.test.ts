// @vitest-environment jsdom
/**
 * The one notice when a device is first found cut off for its version (pair-with-IP design §5): it shows wherever
 * the window is, as the computers list is read, and only in the window the daemon gives it to
 * (`netEngine.versionNotice.claim`, one per refusal), so two windows never both show it.
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
/** Each ask for a notice, and the refusals the daemon gave away (by `<node> <since>`). */
const asks: Array<{ node: string; since: number }> = []
const given = new Set<string>()
const request = vi.fn(async (method: string, params: { node?: string; since?: number }) => {
  switch (method) {
    case 'net.status':
      return { enabled: false }
    case 'netEngine.status':
      return { enabled: true, on: true, helper: { state: 'running' }, devices, approvals: [] }
    case 'bridge.nodes':
      return { nodes: [] }
    case 'netEngine.versionNotice.claim': {
      asks.push({ node: params.node!, since: params.since! })
      // As the daemon: the first ask for the refusal that holds now is given it.
      const key = `${params.node} ${params.since}`
      if (given.has(key)) return { show: false }
      given.add(key)
      return { show: true }
    }
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
  asks.length = 0
  given.clear()
})

const read = async () => {
  await act(async () => {
    await refreshComputers()
  })
  // The daemon's answer to the ask, then the toast.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
/** The notices on screen (the toast host draws into the page, not under its own element). */
const notices = () => [...document.body.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent === NOTICE)

describe('the "needs a Mousse update" notice', () => {
  it('shows for a device found cut off when the daemon gives this window the notice', async () => {
    devices = [studio({ needsUpdate: { who: 'there', since: 1_000 } }), studio({ node: 'n2', name: 'Server' })]
    await read()
    expect(notices()).toHaveLength(1)
    expect(asks).toEqual([{ node: 'n1', since: 1_000 }])
  })

  it('shows nothing when another window was given it first, though this one has not heard it was told', async () => {
    given.add('n1 2000')
    devices = [studio({ needsUpdate: { who: 'there', since: 2_000 } })]
    await read()
    expect(asks).toEqual([{ node: 'n1', since: 2_000 }])
    expect(notices()).toHaveLength(0)
  })

  it('asks nothing for a refusal already told, and asks again for a new refusal of the same device', async () => {
    devices = [studio({ needsUpdate: { who: 'there', since: 3_000, told: true } })]
    await read()
    expect(asks).toEqual([])
    expect(notices()).toHaveLength(0)

    devices = [studio({ needsUpdate: { who: 'there', since: 4_000 } })]
    await read()
    expect(asks).toEqual([{ node: 'n1', since: 4_000 }])
    expect(notices()).toHaveLength(1)
  })
})
