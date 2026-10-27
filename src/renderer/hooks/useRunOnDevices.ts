import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import type { Device } from '../lib/netDevices'
import { readRemoteProjects, readRunOnDevices } from '../lib/remoteComputers'

/** The user's devices, read on mount and again whenever `refresh` is called (a menu opening). */
export function useRunOnDevices(): { devices: Device[]; refresh: () => void } {
  const [devices, setDevices] = useState<Device[]>([])
  const alive = useRef(true)
  const refresh = useCallback(() => {
    void readRunOnDevices().then((next) => { if (alive.current) setDevices(next) })
  }, [])
  useEffect(() => {
    alive.current = true
    refresh()
    return () => { alive.current = false }
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
