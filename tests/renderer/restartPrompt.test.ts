// @vitest-environment jsdom
/**
 * The restart that installs a downloaded update, as the person sees it: "vX is ready" with one line when nothing else
 * is affected, or a row for each thing the restart touches, only those that apply (this computer, the turns running
 * in every profile as the service counts them, each computer using this one). Later closes; Restart now installs.
 * The window talks to its app only through the bridge, stubbed here.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../src/shared/updates'
import type { NetEngineStatus } from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { InstallConfirm } = await import('../../src/renderer/components/updates/InstallConfirm')
const { useUpdateStore } = await import('../../src/renderer/stores/updateStore')
const { useComputersStore, NO_COMPUTERS } = await import('../../src/renderer/lib/computers')
type Device = import('../../src/renderer/lib/netDevices').Device

const appState: UpdateState = { phase: 'downloaded', currentVersion: '0.9.2', availableVersion: '0.9.4', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0 }
const laptop: Device = {
  node: 'laptop' as Device['node'], name: 'Laptop', caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state: 'open', source: 'engine'
}

let turns: number | null = 0
let engine: NetEngineStatus | undefined
const install = vi.fn(async () => appState)
let root: Root
let host: HTMLElement
let closed = 0
beforeEach(() => {
  turns = 0
  engine = undefined
  closed = 0
  install.mockClear()
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request: vi.fn(async (method: string) => (method === 'netEngine.status' && engine ? engine : Promise.reject(new Error('none')))) },
    updates: { install, runningTurns: async () => turns }
  }
  useUpdateStore.setState(appState, true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useComputersStore.setState(NO_COMPUTERS)
})

const open = async () => {
  await act(async () => root.render(createElement(InstallConfirm, { open: true, version: '0.9.4', onClose: () => void closed++ })))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const rows = () => [...dialog().querySelectorAll('li')].map((row) => row.textContent)
const button = (name: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)!

describe('the restart prompt', () => {
  it('says it in one line when nothing else is affected; Later closes it without installing', async () => {
    await open()
    expect(dialog().textContent).toContain('v0.9.4 is ready')
    expect(dialog().textContent).toContain("Mousse restarts to finish updating. It's back in a few seconds.")
    expect(rows()).toEqual([])
    await act(async () => button('Later').click())
    expect(closed).toBe(1)
    expect(install).not.toHaveBeenCalled()
  })

  it('adds a row for the running turns the service counts and for each computer using this one; Restart now installs', async () => {
    turns = 2
    engine = { enabled: true, on: true, helper: { state: 'running' }, devices: [{ node: 'laptop', name: 'Laptop', shortId: 'l', state: 'connected', online: true, direction: 'in' }], approvals: [] } as unknown as NetEngineStatus
    useComputersStore.setState({ loaded: true, routed: true, byNode: {}, devices: [laptop] })
    await open()
    expect(rows()).toEqual(['This computerv0.9.2 → v0.9.4Back in a few seconds', '2 running turnsStop, continue them after', 'LaptopReconnects after'])
    // Nothing resumes by itself: the row says the turns are continued after, and its tooltip says how.
    expect(dialog().querySelectorAll('li')[1].getAttribute('title')).toContain('Continue it from its thread')
    await act(async () => button('Restart now').click())
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("counts this window's running turns when the service can't say", async () => {
    turns = null
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    useAppStore.setState({ turnStates: { t1: { phase: 'streaming' } } as never })
    await open()
    expect(rows()[1]).toBe('1 running turnStop, continue them after')
    useAppStore.setState({ turnStates: {} })
  })
})
