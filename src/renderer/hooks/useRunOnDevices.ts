import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeId } from '../../shared/net'
import type { Device } from '../lib/netDevices'
import { readRemoteComposerOptions, readRunOnDevices, type RemoteComposerOptions } from '../lib/remoteComputers'

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
 * The models another computer offers a chat that runs there (a new one, or a thread of it). Empty
 * until it answers, and when it cannot be reached.
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
