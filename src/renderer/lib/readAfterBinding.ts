import { useAppStore } from '../stores/appStore'

/** Whether this window's profile is bound; before that it may call no profile service. */
export const profileBound = (): boolean => useAppStore.getState().profileReady

/**
 * Runs `read` once, when the window is idle after its profile is bound, or `timeout` ms after the binding when it never
 * goes idle. Before the binding the window shows only the startup skeleton and calls no profile service.
 */
export function readWhenIdleAfterBinding(read: () => void, timeout: number): void {
  const schedule = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(read, { timeout })
    else setTimeout(read, timeout)
  }
  if (profileBound()) return schedule()
  const stop = useAppStore.subscribe((state) => {
    if (!state.profileReady) return
    stop()
    schedule()
  })
}
