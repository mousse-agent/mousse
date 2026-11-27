import { useEffect, useRef, useState } from 'react'
import { scaleMotionMs } from '../../lib/motion'

const SCRAMBLE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** How long a reveal or a hide takes to settle, before the speed scale. */
const SETTLE_MS = 360
/** How often the unsettled characters change while it settles. */
const REROLL_MS = 45

const randomChar = () => SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]

/** `email` with every character but `@` and `.` swapped for a random one: same length, same shape. */
export function scrambleEmail(email: string): string {
  return Array.from(email, (char) => (char === '@' || char === '.' ? char : randomChar())).join('')
}

/**
 * The first `settled` characters of `email` as they are, the rest scrambled. Revealing settles from
 * the left; hiding scrambles from the left, so both read as one sweep.
 */
function partly(email: string, settled: number, revealing: boolean): string {
  const chars = Array.from(email)
  return chars.map((char, index) => {
    const real = revealing ? index < settled : index >= settled
    return real || char === '@' || char === '.' ? char : randomChar()
  }).join('')
}

/**
 * An email shown scrambled and blurred until clicked: a click unscrambles and sharpens it, another
 * hides it again. While hidden, only random text of the same shape is on the page, so a screenshot,
 * a selection or a copy never holds the real address.
 */
export function HiddenEmail({ email, className }: { email: string; className?: string }) {
  const [revealed, setRevealed] = useState(false)
  const [text, setText] = useState(() => scrambleEmail(email))
  const frame = useRef<number | null>(null)
  // Only a click animates: a first render or a new address while hidden never draws real characters.
  const toggled = useRef(false)

  useEffect(() => {
    const duration = scaleMotionMs(SETTLE_MS)
    const length = Array.from(email).length
    const final = revealed ? email : scrambleEmail(email)
    const animate = toggled.current
    toggled.current = false
    if (!animate || duration <= 0 || typeof requestAnimationFrame !== 'function') {
      setText(final)
      return
    }
    const start = performance.now()
    let lastRoll = -Infinity
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      if (progress >= 1) {
        setText(final)
        frame.current = null
        return
      }
      if (now - lastRoll >= REROLL_MS) {
        lastRoll = now
        setText(partly(email, Math.floor(progress * length), revealed))
      }
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [email, revealed])

  const label = revealed ? 'Hide email' : 'Show email'
  return (
    <button
      type="button"
      className={`hidden-email${revealed ? ' is-revealed' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={revealed}
      aria-label={revealed ? `${email}. ${label}` : label}
      title={label}
      onClick={() => {
        toggled.current = true
        setRevealed((value) => !value)
      }}
    >
      <span className="hidden-email-text" aria-hidden="true">{text}</span>
    </button>
  )
}
