import { useEffect } from 'react'
import { create } from 'zustand'
import type { NodeId } from '../../shared/net'
import type { NetStatus } from '../../shared/net/local'
import { isThreadStarted } from '../../shared/threadTitle'
import type { Thread, ThreadActivityState } from '../../shared/types'
import type { RemotePause } from '../services/remoteThreadDisplay'
import { connectedRemoteDevices } from '../components/sideCard/deviceMenu'
import { useAppStore } from '../stores/appStore'
import type { Device } from './netDevices'
import { readRunOnDevices } from './remoteComputers'
import { remoteQuestionCount, remoteThreadKey, type RemoteThreadEntry } from './remoteThreadStore'

/**
 * A thread on another computer that some device of the user started there through Bridge. Every
 * computer lists these, so a thread started from one device is visible from all of them.
 */
export interface RemoteListedThread {
  key: string
  ref: { nodeId: NodeId; entityId: string }
  deviceName: string
  name: string
  updatedAt: string
  worktreeEnabled?: boolean
  /** The project of this computer it was started from; only the computer that started it knows it. */
  localProjectId?: string
}

/**
 * Whether the other computers' threads come in this computer's own lists (the routing flag, with Bridge on).
 * Then the rows listed below would show every one of them twice, so the sidebar leaves them out.
 */
export const useRoutedThreads = create<{ on: boolean }>(() => ({ on: false }))

/** Routing is on for a profile when Bridge is and so is the flag that routes threads. */
export function routedThreadsOn(status: Pick<NetStatus, 'features'> | undefined): boolean {
  return status?.features?.netBridge === true && status.features.netBridgeThreads === true
}

/** Keeps `useRoutedThreads` current for the profile: read now, and again whenever the daemon reports a change. */
export function useRoutedThreadsFlag(profileId: string | null): boolean {
  const on = useRoutedThreads((state) => state.on)
  useEffect(() => {
    useRoutedThreads.setState({ on: false })
    if (!profileId) return
    let live = true
    const apply = (status: Pick<NetStatus, 'features'> | undefined): void => {
      if (live) useRoutedThreads.setState({ on: routedThreadsOn(status) })
    }
    void window.mousse.platformRequest.request<NetStatus>('net.status', {}).then(apply, () => undefined)
    const off = window.mousse.net.onUpdated(apply)
    return () => {
      live = false
      off()
    }
  }, [profileId])
  return on
}

/** How often the other computers' lists are read again while the app is open. */
export const REMOTE_THREAD_LIST_MS = 30_000

export const useRemoteListedThreads = create<{ threads: RemoteListedThread[] }>(() => ({ threads: [] }))

/** One computer's threads that another device started there: begun, not settled, not subagents. */
export function startedElsewhere(
  threads: readonly Thread[],
  device: Pick<Device, 'node' | 'name'>,
  self: NodeId | undefined
): RemoteListedThread[] {
  return threads.flatMap((thread) => {
    const from = thread.startedFrom
    if (!from || thread.settledAt || thread.lineage || !isThreadStarted(thread)) return []
    const ref = { nodeId: device.node, entityId: thread.id }
    return [{
      key: remoteThreadKey(ref),
      ref,
      deviceName: device.name,
      name: thread.name,
      updatedAt: thread.updatedAt,
      ...(thread.worktreeEnabled ? { worktreeEnabled: true } : {}),
      ...(self && from.node === self && from.projectId ? { localProjectId: from.projectId } : {})
    }]
  })
}

export interface RemoteThreadListDeps {
  devices: () => Promise<Device[]>
  threads: (node: NodeId) => Promise<Thread[]>
  /** False once the answer is no longer wanted (the profile changed). */
  current: () => boolean
}

const defaultDeps = (profileId: string | null): RemoteThreadListDeps => ({
  devices: readRunOnDevices,
  threads: async (node) => {
    const value = await window.mousse.platformRequest.request<{ threads?: Thread[] }>('bridge.hub.threads', { target: node })
    return Array.isArray(value?.threads) ? value.threads : []
  },
  current: () => useAppStore.getState().profileId === profileId
})

let pending: Promise<void> | undefined

/**
 * Reads every connected computer's list again. A computer that does not answer keeps the rows it
 * listed last; a computer that is no longer connected drops its rows.
 */
export function refreshRemoteListedThreads(deps: RemoteThreadListDeps = defaultDeps(useAppStore.getState().profileId)): Promise<void> {
  pending ??= (async () => {
    try {
      const devices = await deps.devices()
      const self = devices.find((device) => device.self)?.node
      const previous = useRemoteListedThreads.getState().threads
      const lists = await Promise.all(connectedRemoteDevices(devices).map(async (device) => {
        try {
          return startedElsewhere(await deps.threads(device.node), device, self)
        } catch {
          return previous.filter((thread) => thread.ref.nodeId === device.node)
        }
      }))
      if (deps.current()) useRemoteListedThreads.setState({ threads: lists.flat() })
    } finally {
      pending = undefined
    }
  })()
  return pending
}

/** Keeps the list fresh while the sidebar is shown: now, on an interval, and when the window gets focus. */
export function useRemoteThreadListing(profileId: string | null): void {
  useEffect(() => {
    useRemoteListedThreads.setState({ threads: [] })
    if (!profileId) return
    const refresh = () => void refreshRemoteListedThreads()
    refresh()
    const timer = setInterval(refresh, REMOTE_THREAD_LIST_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [profileId])
}

/**
 * The status a sidebar row shows for a thread this window is attached to: waiting for an answer,
 * paused by a usage limit (with when it resets), or working. Nothing while idle or not attached.
 */
export function remoteRowActivity(
  entry: Pick<RemoteThreadEntry, 'view' | 'sending' | 'questions'> | undefined
): { activity?: ThreadActivityState; pause?: RemotePause } {
  const pause = entry?.view?.active ? undefined : entry?.view?.paused
  if (entry && remoteQuestionCount(entry) > 0) return { activity: 'awaiting_input' }
  if (pause) return { activity: 'paused', pause }
  if (entry?.view?.active || entry?.sending) return { activity: 'processing' }
  return {}
}

/** A remote thread as a sidebar row: listed from its computer, attached in this window, or both. */
export interface RemoteSidebarThread {
  key: string
  ref: { nodeId: NodeId; entityId: string }
  deviceName?: string
  name: string
  updatedAt?: string
  worktreeEnabled?: boolean
  localProjectId?: string
  /** Set once this window is attached to the thread. */
  entry?: RemoteThreadEntry
}

/** No rows: what the sidebar lists of the other computers while their threads are in the merged lists. */
export const NO_REMOTE_SIDEBAR_THREADS: ReturnType<typeof sidebarRemoteThreads> = {
  all: [],
  byProject: new Map(),
  unfiled: []
}

/**
 * Where the sidebar lists remote threads: the ones this window is attached to first (newest
 * attachment first), then the rest by last update. Each sits under the project of this computer it
 * was started from, or with the chats that have no project.
 */
export function sidebarRemoteThreads(
  entries: Readonly<Record<string, RemoteThreadEntry>>,
  order: readonly string[],
  listed: readonly RemoteListedThread[],
  localProjectIds: ReadonlySet<string>
): { all: RemoteSidebarThread[]; byProject: Map<string, RemoteSidebarThread[]>; unfiled: RemoteSidebarThread[] } {
  const listedByKey = new Map(listed.map((thread) => [thread.key, thread]))
  const all: RemoteSidebarThread[] = [...order].reverse().flatMap((key) => {
    const entry = entries[key]
    if (!entry) return []
    const known = listedByKey.get(key)
    const thread = entry.view?.thread
    return [{
      key,
      ref: entry.ref,
      deviceName: entry.deviceName ?? known?.deviceName,
      name: thread?.name ?? entry.title ?? known?.name ?? 'Remote thread',
      updatedAt: thread?.updatedAt ?? known?.updatedAt,
      worktreeEnabled: thread?.worktreeEnabled ?? known?.worktreeEnabled,
      localProjectId: entry.localProjectId ?? known?.localProjectId,
      entry
    }]
  })
  const attached = new Set(all.map((thread) => thread.key))
  all.push(...listed
    .filter((thread) => !attached.has(thread.key))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((thread) => ({ ...thread })))
  const byProject = new Map<string, RemoteSidebarThread[]>()
  const unfiled: RemoteSidebarThread[] = []
  for (const thread of all) {
    const project = thread.localProjectId && localProjectIds.has(thread.localProjectId) ? thread.localProjectId : undefined
    if (project) byProject.set(project, [...(byProject.get(project) ?? []), thread])
    else unfiled.push(thread)
  }
  return { all, byProject, unfiled }
}
