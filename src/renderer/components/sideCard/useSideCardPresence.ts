import { useLayoutEffect, useRef, useState } from 'react'
import {
  createSideCardPresence,
  sideCardPresenceView,
  type SideCardPhase,
  type SideCardPresence,
  type SideCardPresenceView
} from './sideCardPresence'

export { SIDE_CARD_FADE_MS } from './sideCardPresence'

/**
 * Splits "the card should be showing" into mounting and fading so the exit can
 * finish before the card leaves the layout (see sideCardPresence.ts for the
 * phases). Reduced motion keeps the same timings; the stylesheet drops the slide.
 * `animate: false` lets a card that is already wanted at launch appear without
 * a fade-in.
 */
export function useSideCardPresence(present: boolean, animate = true): SideCardPresenceView {
  const [phase, setPhase] = useState<SideCardPhase>(present ? 'shown' : 'unmounted')
  const phaseRef = useRef(phase)
  const presenceRef = useRef<SideCardPresence | null>(null)

  useLayoutEffect(() => {
    const presence = createSideCardPresence((next) => {
      phaseRef.current = next
      setPhase(next)
    }, phaseRef.current)
    presenceRef.current = presence
    return () => {
      presence.dispose()
      presenceRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    presenceRef.current?.setPresent(present, animate)
  }, [present, animate])

  return sideCardPresenceView(phase)
}
