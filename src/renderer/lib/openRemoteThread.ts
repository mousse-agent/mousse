import type { NodeId } from '../../shared/net'

/** A thread that runs on another computer, as the composer hands it to the thread view. */
export interface RemoteThreadTarget {
  nodeId: NodeId
  entityId: string
  deviceName?: string
  title?: string
}

/** Event the app window raises when a chat started from the composer has been created on another computer. */
export const OPEN_REMOTE_THREAD_EVENT = 'mousse:open-remote-thread'

/**
 * Shows a thread that runs on another computer. This is only the seam the composer calls:
 * it announces the thread on the window, and the remote thread view takes it from here.
 */
export function openRemoteThread(target: RemoteThreadTarget): void {
  window.dispatchEvent(new CustomEvent<RemoteThreadTarget>(OPEN_REMOTE_THREAD_EVENT, { detail: target }))
}
