import { useEffect, useMemo, useState } from 'react'
import { isNetErrorCode, NET_ERRORS, type NodeId } from '../../shared/net'
import { notSharingNodes, refreshComputers, useComputers } from '../lib/computers'
import type { Device } from '../lib/netDevices'
import { cachedRemoteComposerOptions, onRemoteComposerOptionsRead, readRemoteComposerOptions, type RemoteComposerOptions } from '../lib/remoteComputers'
import { useAppStore } from '../stores/appStore'

const NO_NODES: ReadonlySet<string> = new Set()

/**
 * The user's devices that a chat can be started on (none while threads of other computers are not routed), kept
 * by the one reader of `bridge.nodes` that the thread views share (`lib/computers.ts`); `refresh` reads again
 * (a menu opening).
 */
export function useRunOnDevices(): { devices: readonly Device[]; notSharing: ReadonlySet<string>; refresh: () => void } {
  const { devices } = useComputers()
  // Derive a primitive key inside the selector so unrelated thread touches/updates never re-render the chat.
  const notSharingKey = useAppStore((state) => {
    const nodes = notSharingNodes([...state.threads, ...state.projects])
    return nodes.size === 0 ? '' : [...nodes].sort().join('\n')
  })
  const notSharing = useMemo(
    () => (notSharingKey ? new Set(notSharingKey.split('\n')) : NO_NODES),
    [notSharingKey]
  )
  // Each computer's models are read once it is connected, so picking it shows them at once.
  useEffect(() => {
    for (const device of devices)
      if (device.state === 'open' && !cachedRemoteComposerOptions(device.node))
        void readRemoteComposerOptions(device.node).catch(() => undefined)
  }, [devices])
  return { devices, notSharing, refresh: () => void refreshComputers() }
}

/** The longest wait between attempts to read a computer's models while it does not answer. */
const RETRY_MAX_MS = 15_000

/** That computer refused this device (not allowed, removed, not a member): asking again on a timer gets the same answer. */
function refused(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return isNetErrorCode(code) && NET_ERRORS[code].category === 'denied'
}

/**
 * The models another computer offers a chat that runs there (a new one, or a thread of it): its
 * last answer at once, then a fresh one. While it does not answer, it is asked again, sooner at
 * first; until it has answered once, `loaded` is false. A computer that refuses this device is
 * asked again only when the window comes back into focus or a send there was refused.
 */
export function useRemoteComposerOptions(node: NodeId | undefined): RemoteComposerOptions & { loaded: boolean } {
  const [state, setState] = useState<{ node: NodeId; options: RemoteComposerOptions } | undefined>()
  useEffect(() => {
    if (!node) return
    let cancelled = false
    let delay = 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    const cached = cachedRemoteComposerOptions(node)
    if (cached) setState({ node, options: cached })
    const read = () => {
      clearTimeout(timer)
      if (cancelled) return
      void readRemoteComposerOptions(node).then(
        (options) => {
          if (cancelled) return
          delay = 1000
          setState({ node, options })
        },
        (error: unknown) => {
          if (cancelled) return
          clearTimeout(timer)
          if (refused(error)) return
          timer = setTimeout(read, delay)
          delay = Math.min(delay * 2, RETRY_MAX_MS)
        }
      )
    }
    read()
    // What that computer lets this device do can change while the chat is open; coming back to the window asks again,
    // and so does a send there refused because it changed.
    window.addEventListener('focus', read)
    const offRead = onRemoteComposerOptionsRead((readNode, options) => { if (!cancelled && readNode === node) setState({ node, options }) })
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('focus', read); offRead() }
  }, [node])
  const options = state && state.node === node ? state.options : node ? cachedRemoteComposerOptions(node) : undefined
  return node && options
    ? { ...options, loaded: true }
    : { providers: [], defaultModel: null, loaded: false }
}
