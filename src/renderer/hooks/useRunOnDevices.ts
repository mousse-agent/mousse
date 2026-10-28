import { useEffect, useMemo, useState } from 'react'
import type { NodeId } from '../../shared/net'
import { notSharingNodes, refreshComputers, useComputers } from '../lib/computers'
import type { Device } from '../lib/netDevices'
import { readRemoteComposerOptions, type RemoteComposerOptions } from '../lib/remoteComputers'
import { useAppStore } from '../stores/appStore'

/**
 * The user's devices that a chat can be started on (none while threads of other computers are not routed), kept
 * by the one reader of `bridge.nodes` that the thread views share (`lib/computers.ts`); `refresh` reads again
 * (a menu opening).
 */
export function useRunOnDevices(): { devices: readonly Device[]; notSharing: ReadonlySet<string>; refresh: () => void } {
  const { devices } = useComputers()
  const threads = useAppStore((state) => state.threads)
  const projects = useAppStore((state) => state.projects)
  const notSharing = useMemo(() => notSharingNodes([...threads, ...projects]), [threads, projects])
  return { devices, notSharing, refresh: () => void refreshComputers() }
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
    const read = () => void readRemoteComposerOptions(node).then(
      (options) => { if (!cancelled) setState({ node, options }) },
      () => { if (!cancelled) setState({ node, options: { providers: [], defaultModel: null } }) }
    )
    read()
    // What that computer lets this device do can change while the chat is open; coming back to the window asks again.
    window.addEventListener('focus', read)
    return () => { cancelled = true; window.removeEventListener('focus', read) }
  }, [node])
  return state.node === node && node
    ? { ...state.options, loaded: true }
    : { providers: [], defaultModel: null, loaded: false }
}
