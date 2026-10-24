import { useLayoutEffect, useState } from 'react'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

/** Keep in sync with the opacity/transform transition on `.thread-side-card` in sideCard.css. */
export const SIDE_CARD_FADE_MS = 180

/**
 * Splits "the card should be showing" into mounting and fading so the exit
 * can finish before the card leaves the layout. `mounted` stays true through
 * the fade-out; `shown` drives the faded-in styling. Reduced motion skips the
 * wait and swaps the card in and out immediately.
 */
export function useSideCardPresence(present: boolean): { mounted: boolean; shown: boolean } {
  const reducedMotion = usePrefersReducedMotion()
  const [mounted, setMounted] = useState(present)
  const [shown, setShown] = useState(present)

  useLayoutEffect(() => {
    if (present) {
      setMounted(true)
      if (reducedMotion) {
        setShown(true)
        return
      }
      // Two frames let the faded-out styles paint once, so the fade-in runs as a transition.
      let inner: number | undefined
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setShown(true)) })
      return () => {
        cancelAnimationFrame(outer)
        if (inner !== undefined) cancelAnimationFrame(inner)
      }
    }
    setShown(false)
    if (reducedMotion) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), SIDE_CARD_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [present, reducedMotion])

  return { mounted, shown }
}
