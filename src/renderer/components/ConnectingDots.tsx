import { useEffect, useRef, useState } from 'react'
import { scaleMotionMs } from '../lib/motion'
import './connecting-dots.css'

/** A composer's placeholder while the app is not connected to its service (`useServiceConnecting`). */
export const CONNECTING_TEXT = 'Connecting…'

/** How long the dots take to fade out once connected; matches the fade in connecting-dots.css. */
const FADE_MS = 240
/** As the empty chat's glow (AmbientGlow): a focused window left alone stops drawing after this long. */
const IDLE_REST_MS = 30_000
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const

/**
 * The background of a composer that is connecting (connecting-dots.css): a grid of dots in the accent colour that
 * soft waves travel across. It sits behind the composer's text, fills its parent (which positions it) and fades out
 * when `shown` turns false. While the window is hidden or not focused, or after IDLE_REST_MS without input, the waves
 * hold where they are, so the window does not keep drawing.
 */
export function ConnectingDots({ shown, instant = false }: {
  shown: boolean
  /** Shown at once, without fading in: it carries on dots another composer showed until now. */
  instant?: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  // Kept for its fade after `shown` turns false.
  const [present, setPresent] = useState(shown)
  useEffect(() => {
    if (shown) {
      setPresent(true)
      return
    }
    const timer = setTimeout(() => setPresent(false), scaleMotionMs(FADE_MS))
    return () => clearTimeout(timer)
  }, [shown])

  useEffect(() => {
    const node = ref.current
    if (!shown || !node) return
    let idle = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const update = () => node.toggleAttribute('data-rest', idle || document.hidden || !document.hasFocus())
    const startIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { idle = true; update() }, IDLE_REST_MS)
    }
    const onActivity = () => {
      startIdleTimer()
      if (idle) { idle = false; update() }
    }
    update()
    startIdleTimer()
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { capture: true, passive: true })
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      clearTimeout(idleTimer)
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true })
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
      node.removeAttribute('data-rest')
    }
  }, [shown, present])

  if (!shown && !present) return null
  return (
    <span ref={ref} className="connecting-dots" data-shown={shown ? '' : undefined} data-instant={instant ? '' : undefined} aria-hidden="true">
      <span className="connecting-dots-wave" />
    </span>
  )
}
