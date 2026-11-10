/**
 * Keeps the Browser panel's view of the agents' browser access current (`browser.access.status`). The service pushes
 * `browser.access.changed` when the grant, a pending request or a tab an agent waits for changes, and the panel reads
 * the state then, shown or hidden: a hidden panel still opens the tab an agent asked for. Between pushes it reads the
 * state every `shownMs` while the panel is shown and the window visible, and every `hiddenMs` otherwise, for a push
 * that was missed. A push during a read makes one more read after it.
 */
export const BROWSER_ACCESS_SHOWN_MS = 750
export const BROWSER_ACCESS_HIDDEN_MS = 30_000

export interface FollowBrowserAccessDeps {
  read: () => Promise<void>
  /** Whether the panel is on screen now. */
  shown: () => boolean
  onChanged?: (listener: () => void) => () => void
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  shownMs?: number
  hiddenMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Reads now and follows the state; returns the function that stops it. */
export function followBrowserAccess(deps: FollowBrowserAccessDeps): () => void {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let stopped = false
  let running = false
  let again = false
  let timer: unknown
  const delay = (): number => deps.shown() && deps.document.visibilityState !== 'hidden'
    ? deps.shownMs ?? BROWSER_ACCESS_SHOWN_MS
    : deps.hiddenMs ?? BROWSER_ACCESS_HIDDEN_MS
  const read = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    try {
      await deps.read()
    } catch {
      // Read again on the next push or tick.
    }
    running = false
    if (stopped) return
    if (again) {
      again = false
      void read()
      return
    }
    timer = setTimer(() => { timer = undefined; void read() }, delay())
  }
  const onVisibility = (): void => {
    if (deps.document.visibilityState !== 'hidden') void read()
  }
  void read()
  const unsubscribe = deps.onChanged?.(() => { void read() })
  deps.document.addEventListener('visibilitychange', onVisibility)
  return () => {
    stopped = true
    if (timer !== undefined) clearTimer(timer)
    unsubscribe?.()
    deps.document.removeEventListener('visibilitychange', onVisibility)
  }
}
