/**
 * Keeps a list the service pushes up to date without polling it every second or two. The list is read again:
 * - when the service says it changed (`onChanged`, for lists whose push carries no rows);
 * - when the window comes back (focused, or shown after being minimised or hidden), since pushes to a
 *   window that slept, reloaded or reconnected may have been missed;
 * - every `fallbackMs` while the window shows, for a push that was lost anyway (a subscription race on reload)
 *   and for parts of a list that have no push of their own.
 * A hidden window reads nothing until it shows again.
 */
export interface FollowPushedListDeps {
  refresh: () => void
  fallbackMs: number
  onChanged?: (listener: () => void) => () => void
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  setInterval?: (run: () => void, ms: number) => unknown
  clearInterval?: (timer: unknown) => void
}

/** Starts following; returns the function that stops it. */
export function followPushedList(deps: FollowPushedListDeps): () => void {
  const setTimer = deps.setInterval ?? ((run, ms) => setInterval(run, ms))
  const clearTimer = deps.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  const shown = (): boolean => deps.document.visibilityState !== 'hidden'
  const readIfShown = (): void => {
    if (shown()) deps.refresh()
  }
  const unsubscribe = deps.onChanged?.(readIfShown)
  const timer = setTimer(readIfShown, deps.fallbackMs)
  deps.window.addEventListener('focus', readIfShown)
  deps.document.addEventListener('visibilitychange', readIfShown)
  return () => {
    unsubscribe?.()
    clearTimer(timer)
    deps.window.removeEventListener('focus', readIfShown)
    deps.document.removeEventListener('visibilitychange', readIfShown)
  }
}
