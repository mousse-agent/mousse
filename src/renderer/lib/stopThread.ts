import { useAppStore } from '../stores/appStore'
import { STOP_RECONCILE_MS } from './optimisticStop'

/**
 * A person's Stop of a thread from this window: the thread shows stopped at once (`lib/optimisticStop`), then the
 * daemon is asked. When the Stop stopped nothing, or the daemon still reports the turn running `STOP_RECONCILE_MS`
 * later, the daemon's state is shown again. Resolves whether anything was stopped.
 */
export async function stopThreadNow(threadId: string): Promise<boolean> {
  const requestedAt = useAppStore.getState().markStopRequested(threadId)
  let stopped = false
  try {
    stopped = await window.mousse.orchestrator.abort(threadId)
  } finally {
    if (requestedAt !== undefined) {
      if (!stopped) useAppStore.getState().revertStopRequest(threadId, requestedAt)
      else setTimeout(() => useAppStore.getState().revertStopRequest(threadId, requestedAt), STOP_RECONCILE_MS)
    }
  }
  return stopped
}
