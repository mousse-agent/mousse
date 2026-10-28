import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NO_COMPUTERS,
  computersFrom,
  offlineLabel,
  refreshComputers,
  routedThreadsOn,
  threadComputerState,
  useComputersStore
} from '../../src/renderer/lib/computers'
import type { Device } from '../../src/renderer/lib/netDevices'
import { useAppStore } from '../../src/renderer/stores/appStore'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const device = (patch: Partial<Device> = {}): Device => ({
  node: 'nod_studio' as Device['node'],
  name: 'Studio',
  caps: ['read', 'chat', 'write', 'settings'],
  keyEpoch: 1,
  expiresAt: 0,
  self: false,
  revoked: false,
  state: 'open',
  kind: 'computer',
  ...patch
})

describe('which devices are computers', () => {
  it('lists the other computers by node, with their state', () => {
    const byNode = computersFrom([
      device(),
      device({ node: 'nod_mac' as Device['node'], name: 'Mac mini', state: 'closed', lastSeenAt: NOW - 60_000, version: '0.1.3' })
    ])
    expect(byNode.nod_studio).toEqual({ node: 'nod_studio', name: 'Studio', online: true })
    expect(byNode.nod_mac).toEqual({ node: 'nod_mac', name: 'Mac mini', online: false, lastSeenAt: NOW - 60_000, version: '0.1.3' })
  })

  it('leaves out this computer, a revoked device and a phone, and keeps a device with no recorded kind', () => {
    const byNode = computersFrom([
      device({ node: 'nod_self' as Device['node'], self: true }),
      device({ node: 'nod_gone' as Device['node'], revoked: true }),
      device({ node: 'nod_phone' as Device['node'], kind: 'phone' }),
      device({ node: 'nod_old' as Device['node'], name: 'Old daemon', kind: undefined })
    ])
    expect(Object.keys(byNode)).toEqual(['nod_old'])
  })
})

describe('what a thread row says about its computer', () => {
  it('is connected unless the row or the device list says it is not', () => {
    expect(threadComputerState({}, { online: true })).toBe('online')
    expect(threadComputerState({}, undefined)).toBe('online')
    expect(threadComputerState({}, { online: false })).toBe('offline')
    expect(threadComputerState({ offline: true }, { online: true })).toBe('offline')
  })

  it('says a computer that stopped sharing is not offline', () => {
    expect(threadComputerState({ notShared: true }, { online: false })).toBe('not-shared')
    expect(threadComputerState({ notShared: true, offline: true }, undefined)).toBe('not-shared')
  })

  it('words the offline state with the last time the computer was seen', () => {
    expect(offlineLabel({ lastSeenAt: NOW - 5 * 60_000 }, NOW)).toBe('Offline · last seen 5m ago')
    expect(offlineLabel({}, NOW)).toBe('Offline')
    expect(offlineLabel(undefined, NOW)).toBe('Offline')
  })
})

describe('threads of other computers are routed', () => {
  it('needs Bridge and the routing flag, and treats a daemon without the flag as off', () => {
    const features = (netBridge: boolean, netBridgeThreads?: boolean) => ({ features: { netBridge, netSpaces: false, ...(netBridgeThreads === undefined ? {} : { netBridgeThreads }) } }) as never
    expect(routedThreadsOn(features(true, true))).toBe(true)
    expect(routedThreadsOn(features(true, false))).toBe(false)
    expect(routedThreadsOn(features(false, true))).toBe(false)
    expect(routedThreadsOn(features(true))).toBe(false)
    expect(routedThreadsOn({} as never)).toBe(false)
    expect(routedThreadsOn(undefined)).toBe(false)
  })
})

describe('reading the computers', () => {
  const asked: string[] = []
  let status: Record<string, unknown>
  let nodes: Device[]
  beforeEach(() => {
    asked.length = 0
    status = { enabled: true, self: { node: 'nod_self' }, keystore: 'unlocked', features: { netBridge: true, netSpaces: true, netBridgeThreads: true } }
    nodes = [device(), device({ node: 'nod_self' as Device['node'], self: true })]
    useComputersStore.setState(NO_COMPUTERS)
    ;(globalThis as { window?: unknown }).window = {
      mousse: {
        platformRequest: {
          request: async (method: string) => {
            asked.push(method)
            if (method === 'net.status') return status
            if (method === 'bridge.nodes') return { nodes }
            throw new Error('unexpected ' + method)
          }
        }
      }
    }
  })
  afterEach(() => { delete (globalThis as { window?: unknown }).window })

  it('reads the status and the devices, and keeps the computers by node', async () => {
    await refreshComputers()
    expect(asked).toEqual(['net.status', 'bridge.nodes'])
    expect(useComputersStore.getState()).toMatchObject({ loaded: true, routed: true, byNode: { nod_studio: { name: 'Studio', online: true } } })
    expect(Object.keys(useComputersStore.getState().byNode)).toEqual(['nod_studio'])
  })

  it('asks for no devices while threads of other computers are not routed, or Net is locked', async () => {
    status = { ...status, features: { netBridge: true, netSpaces: true, netBridgeThreads: false } }
    await refreshComputers()
    expect(asked).toEqual(['net.status'])
    expect(useComputersStore.getState()).toMatchObject({ loaded: true, routed: false, byNode: {} })
    asked.length = 0
    status = { ...status, features: { netBridge: true, netSpaces: true, netBridgeThreads: true }, keystore: 'locked' }
    await refreshComputers()
    expect(asked).toEqual(['net.status'])
    expect(useComputersStore.getState().byNode).toEqual({})
  })

  it('shares one read among callers that arrive while it runs, and reads once more afterwards', async () => {
    const first = refreshComputers()
    const second = refreshComputers()
    expect(second).toBe(first)
    await first
    await new Promise((done) => setTimeout(done, 10))
    expect(asked.filter((method) => method === 'net.status')).toHaveLength(2)
  })

  it('keeps the last list when a read fails, and marks the first as done', async () => {
    await refreshComputers()
    const failing = (globalThis as unknown as { window: { mousse: { platformRequest: { request: () => Promise<never> } } } }).window
    failing.mousse.platformRequest.request = async () => { throw new Error('daemon gone') }
    await refreshComputers()
    expect(useComputersStore.getState().byNode.nod_studio?.name).toBe('Studio')
    useComputersStore.setState(NO_COMPUTERS)
    await refreshComputers()
    expect(useComputersStore.getState()).toMatchObject({ loaded: true, byNode: {} })
  })

  it('drops an answer that arrives after a profile switch', async () => {
    const before = useAppStore.getState().profileId
    const reading = refreshComputers()
    useAppStore.setState({ profileId: 'another-profile' })
    await reading
    expect(useComputersStore.getState().loaded).toBe(false)
    useAppStore.setState({ profileId: before })
  })
})
