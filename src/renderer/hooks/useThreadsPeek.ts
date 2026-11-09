import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the pointer rests on the rail before the closed sidebar peeks, so passing over it to click an icon doesn't. */
export const RAIL_PEEK_INTENT_MS = 200
/** Grace period so moving between the rail, the edge strip and the panel doesn't flicker. */
export const PEEK_CLOSE_GRACE_MS = 150
/** The slide-out runs before unmounting, so close animates like open does. */
const PEEK_SLIDE_OUT_MS = 200

type Timer = 'intent' | 'close' | 'unmount'

/**
 * Hover-to-reveal for the closed threads sidebar. The edge strip and the panel open it at once; the rail opens it
 * after a short rest. It closes once the pointer has left all of them. `enabled` is false while the sidebar is
 * expanded or a rail page replaces the workspace.
 */
export function useThreadsPeek(enabled: boolean) {
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  const shownRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const timers = useRef<Record<Timer, number | null>>({ intent: null, close: null, unmount: null })

  const clear = useCallback((...names: Timer[]) => {
    for (const name of names) {
      const id = timers.current[name]
      if (id !== null) window.clearTimeout(id)
      timers.current[name] = null
    }
  }, [])

  const show = useCallback(() => {
    clear('intent', 'close', 'unmount')
    if (!enabledRef.current) return
    shownRef.current = true
    setClosing(false)
    setShown(true)
  }, [clear])

  const scheduleClose = useCallback(() => {
    clear('intent', 'close', 'unmount')
    if (!shownRef.current) return
    timers.current.close = window.setTimeout(() => {
      timers.current.close = null
      setClosing(true)
      timers.current.unmount = window.setTimeout(() => {
        timers.current.unmount = null
        shownRef.current = false
        setShown(false)
        setClosing(false)
      }, PEEK_SLIDE_OUT_MS)
    }, PEEK_CLOSE_GRACE_MS)
  }, [clear])

  /** Pointer entered the rail: keep an open peek open, otherwise open after the intent delay. */
  const enterRail = useCallback(() => {
    if (!enabledRef.current) return
    if (shownRef.current) return show()
    clear('intent')
    timers.current.intent = window.setTimeout(() => {
      timers.current.intent = null
      show()
    }, RAIL_PEEK_INTENT_MS)
  }, [clear, show])

  /** A press on the rail is a click on an icon, not a request to peek. */
  const cancelIntent = useCallback(() => clear('intent'), [clear])

  useEffect(() => {
    if (enabled) return
    clear('intent', 'close', 'unmount')
    shownRef.current = false
    setShown(false)
    setClosing(false)
  }, [enabled, clear])

  useEffect(() => () => clear('intent', 'close', 'unmount'), [clear])

  return { open: shown && !closing, show, scheduleClose, enterRail, leaveRail: scheduleClose, cancelIntent }
}
