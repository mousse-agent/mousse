import { useEffect } from 'react'
import { create } from 'zustand'
import type { NodeId } from '../../shared/net'
import type { NetStatus } from '../../shared/net/local'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { lastSeenLabel, type Device } from './netDevices'

/**
 * One of the user's other computers, as a thread's row names it: the row carries `node`, and this is what
 * that node is called and whether it is connected. The view never parses ids; it looks the node up here.
 */
export interface Computer {
  node: NodeId
  name: string
  /** Connected to this computer right now. */
  online: boolean
  lastSeenAt?: number
  version?: string
}

export interface ComputersState {
  /** False until the first read has finished. */
  loaded: boolean
  /** Threads of other computers are listed and routed (`netBridge` and `netBridgeThreads`). */
  routed: boolean
  byNode: Readonly<Record<string, Computer>>
  /** The devices as `bridge.nodes` lists them (this computer too, with the capabilities it holds); none while not routed. */
  devices: readonly Device[]
}

export const NO_COMPUTERS: ComputersState = { loaded: false, routed: false, byNode: {}, devices: [] }

export const useComputersStore = create<ComputersState>(() => NO_COMPUTERS)

/** Threads of other computers come in this computer's lists when Bridge is on and so is the routing flag. */
export function routedThreadsOn(status: Pick<NetStatus, 'features'> | undefined): boolean {
  return status?.features?.netBridge === true && status.features.netBridgeThreads === true
}

/** The computers among the user's devices: not this one, not revoked, not a phone. */
export function computersFrom(devices: readonly Device[]): Record<string, Computer> {
  const byNode: Record<string, Computer> = {}
  for (const device of devices) {
    if (device.self || device.revoked || device.kind === 'phone') continue
    byNode[device.node] = {
      node: device.node,
      name: device.name,
      online: device.state === 'open',
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
      ...(device.version ? { version: device.version } : {})
    }
  }
  return byNode
}

/**
 * The computers that stopped sharing their threads with this one (they turned the switch off, or blocked this
 * computer): their rows are marked `notShared`. A new chat cannot be created there, whatever the grants say.
 */
export function notSharingNodes(rows: ReadonlyArray<{ node?: string; notShared?: true }>): Set<string> {
  const stopped = new Set<string>()
  for (const row of rows) if (row.node && row.notShared) stopped.add(row.node)
  return stopped
}

/** What a thread row says about the computer it runs on: connected, not connected, or no longer sharing. */
export type ComputerState = 'online' | 'offline' | 'not-shared'

/**
 * The state of the computer a thread runs on. The row says it first (the daemon marks rows it could not
 * refresh); the device list fills in for a row that has not been marked yet.
 */
export function threadComputerState(
  thread: Pick<Thread, 'offline' | 'notShared'>,
  computer: Pick<Computer, 'online'> | undefined
): ComputerState {
  if (thread.notShared) return 'not-shared'
  if (thread.offline || (computer && !computer.online)) return 'offline'
  return 'online'
}

/** "Offline · last seen 5m ago"; without a last-seen time just "Offline". */
export function offlineLabel(computer: Pick<Computer, 'lastSeenAt'> | undefined, now: number): string {
  const seen = lastSeenLabel(computer?.lastSeenAt, now)
  return seen ? `Offline · ${seen}` : 'Offline'
}

/** The name this computer shows for a computer it has no record of. */
export const UNKNOWN_COMPUTER_NAME = 'Another computer'

const request = <T>(method: Parameters<typeof window.mousse.platformRequest.request>[0], params: unknown) =>
  window.mousse.platformRequest.request<T>(method, params)

let reading: Promise<void> | undefined
let readAgain = false

/** Reads the computers again; calls made while a read runs share one more read after it. */
export function refreshComputers(): Promise<void> {
  if (reading) {
    readAgain = true
    return reading
  }
  const profile = useAppStore.getState().profileId
  reading = (async () => {
    try {
      const status = await request<NetStatus>('net.status', {})
      const routed = routedThreadsOn(status)
      const listed = routed && status.enabled && status.self && status.keystore === 'unlocked'
      const nodes = listed ? (await request<{ nodes: Device[] }>('bridge.nodes', {})).nodes : []
      // A profile switch during the read: the answer is for the other profile.
      if (useAppStore.getState().profileId !== profile) return
      useComputersStore.setState({ loaded: true, routed, byNode: computersFrom(nodes), devices: nodes })
    } catch {
      // Without an answer the last list stays; a window with Net off has none to begin with.
      if (useAppStore.getState().profileId === profile && !useComputersStore.getState().loaded)
        useComputersStore.setState({ loaded: true })
    } finally {
      reading = undefined
      if (readAgain) {
        readAgain = false
        void refreshComputers()
      }
    }
  })()
  return reading
}

/** How often the list is read again while a view that shows computers is mounted. */
export const COMPUTERS_REFRESH_MS = 15_000

let subscribers = 0
let stop: (() => void) | undefined

function start(): () => void {
  void refreshComputers()
  const timer = setInterval(() => void refreshComputers(), COMPUTERS_REFRESH_MS)
  const refresh = () => void refreshComputers()
  window.addEventListener('focus', refresh)
  // Net reports a change whenever a device connects or drops.
  const offNet = window.mousse?.net?.onUpdated?.(refresh)
  // The list belongs to one profile.
  const offProfile = useAppStore.subscribe((state, previous) => {
    if (state.profileId === previous.profileId) return
    useComputersStore.setState(NO_COMPUTERS)
    refresh()
  })
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', refresh)
    offNet?.()
    offProfile()
  }
}

/**
 * The user's other computers, kept current while any view that uses them is mounted. A view with nothing
 * from another computer to show passes `enabled: false`, so a window of one computer never polls.
 */
export function useComputers(enabled = true): ComputersState {
  useEffect(() => {
    if (!enabled) return
    if (subscribers++ === 0) stop = start()
    return () => {
      if (--subscribers === 0) {
        stop?.()
        stop = undefined
      }
    }
  }, [enabled])
  return useComputersStore()
}

/** One computer by the `node` of a row; undefined for this computer's own rows and for an unknown node. */
export function useComputer(node: string | undefined): Computer | undefined {
  const { byNode } = useComputers(Boolean(node))
  return node ? byNode[node] : undefined
}
