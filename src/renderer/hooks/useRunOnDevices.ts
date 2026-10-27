import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import type { Device } from '../lib/netDevices'
import { readRemoteComposerOptions, readRemoteProjects, readRunOnDevices, type RemoteComposerOptions } from '../lib/remoteComputers'

/** How often the list is read again while the window is open, so a computer that connects shows up. */
const DEVICE_REFRESH_MS = 30_000

/**
 * The user's devices, read on mount, whenever the window regains focus, every half minute, and
 * whenever `refresh` is called (a menu opening).
 */
export function useRunOnDevices(): { devices: Device[]; refresh: () => void } {
  const [devices, setDevices] = useState<Device[]>([])
  const alive = useRef(true)
  const refresh = useCallback(() => {
    void readRunOnDevices().then((next) => { if (alive.current) setDevices(next) })
  }, [])
  useEffect(() => {
    alive.current = true
    refresh()
    const timer = window.setInterval(refresh, DEVICE_REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])
  return { devices, refresh }
}

/**
 * The projects of the picked computer; none while this computer is picked. `failed` is set when
 * the computer cannot be reached, so the picker can say so once.
 */
export function useRemoteProjects(node: NodeId | undefined): {
  projects: Project[]
  failed: boolean
  add: (project: Project) => void
} {
  const [state, setState] = useState<{ node: NodeId | undefined; projects: Project[]; failed: boolean }>({ node, projects: [], failed: false })
  useEffect(() => {
    let cancelled = false
    if (!node) return
    void readRemoteProjects(node).then(
      (projects) => { if (!cancelled) setState({ node, projects, failed: false }) },
      () => { if (!cancelled) setState({ node, projects: [], failed: true }) }
    )
    return () => { cancelled = true }
  }, [node])
  const add = useCallback((project: Project) => {
    setState((current) => current.projects.some((entry) => entry.id === project.id)
      ? current
      : { ...current, projects: [...current.projects, project] })
  }, [])
  // Projects read for another computer are never shown for this one.
  return state.node === node && node ? { projects: state.projects, failed: state.failed, add } : { projects: [], failed: false, add }
}

/**
 * The models the picked computer offers a new chat. Empty until it answers, and when it cannot
 * be reached (the project list already reports that).
 */
export function useRemoteComposerOptions(node: NodeId | undefined): RemoteComposerOptions & { loaded: boolean } {
  const [state, setState] = useState<{ node: NodeId | undefined; options: RemoteComposerOptions }>({ node, options: { providers: [], defaultModel: null } })
  useEffect(() => {
    let cancelled = false
    if (!node) return
    void readRemoteComposerOptions(node).then(
      (options) => { if (!cancelled) setState({ node, options }) },
      () => { if (!cancelled) setState({ node, options: { providers: [], defaultModel: null } }) }
    )
    return () => { cancelled = true }
  }, [node])
  return state.node === node && node
    ? { ...state.options, loaded: true }
    : { providers: [], defaultModel: null, loaded: false }
}
