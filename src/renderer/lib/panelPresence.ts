import { useEffect, useState } from 'react'
import { scaleMotionMs } from './motion'

/** The app panel's open and close motion, `--ui-dur-slow` in polish.css at Normal speed. */
export const PANEL_MOTION_MS = 200

/**
 * True while the app panel slides out after `open` turns false, from that same render on, so the panel stays laid
 * out until its motion ends. Always false with motion off.
 */
export function usePanelClosing(open: boolean): boolean {
  const [was, setWas] = useState(open)
  const [closing, setClosing] = useState(false)
  if (was !== open) {
    setWas(open)
    setClosing(!open && scaleMotionMs(PANEL_MOTION_MS) > 0)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(false), scaleMotionMs(PANEL_MOTION_MS))
    return () => clearTimeout(timer)
  }, [closing])
  return closing && !open
}
