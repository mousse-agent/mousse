import { useEffect, useRef, useState, type CSSProperties } from 'react'
import '../styles/animated-headline.css'

/** How long the old line takes to blur away before it is dropped (matches the CSS: last delay + duration). */
const LEAVE_MS = 520

/** A stable scatter of 0..1 per character, so the old line breaks up out of order but the same way each time. */
function scatter(index: number): number {
  const x = Math.sin(index * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** The line as words of character spans: a word never breaks across lines, and each character animates on its own. */
function Characters({ text, mode }: { text: string; mode: 'still' | 'enter' | 'leave' }) {
  let index = 0
  const words = text.split(' ')
  return (
    <>
      {words.map((word, wordIndex) => (
        <span key={wordIndex} className="animated-headline-word">
          {[...word].map((character) => {
            const position = index++
            const order = mode === 'leave' ? scatter(position) : position
            return <span key={position} className="animated-headline-char" style={{ '--i': order } as CSSProperties}>{character}</span>
          })}
          {wordIndex < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </>
  )
}

/**
 * A headline that, when its text changes, blurs the old line apart and lets the new one resolve out of the blur,
 * character by character, in the same place. The first text shows as it is; reduced motion swaps it at once.
 */
export function AnimatedHeadline({ text, className, title }: { text: string; className?: string; title?: string }) {
  const [shown, setShown] = useState({ text, leaving: null as string | null, version: 0 })
  const last = useRef(text)

  useEffect(() => {
    if (last.current === text) return
    const previous = last.current
    last.current = text
    setShown((current) => ({ text, leaving: previous, version: current.version + 1 }))
  }, [text])

  // The old line is dropped once it has blurred away; a newer change restarts the wait.
  useEffect(() => {
    if (shown.leaving === null) return
    const version = shown.version
    const timer = window.setTimeout(() => setShown((current) => current.version === version ? { ...current, leaving: null } : current), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [shown.version, shown.leaving])

  return (
    <h1 className={className} title={title} aria-label={shown.text}>
      <span className="animated-headline">
        <span key={shown.version} className={`animated-headline-layer${shown.version > 0 ? ' is-entering' : ''}`} aria-hidden="true">
        <Characters text={shown.text} mode={shown.version > 0 ? 'enter' : 'still'} />
      </span>
      {shown.leaving !== null && (
        <span key={`leave-${shown.version}`} className="animated-headline-layer is-leaving" aria-hidden="true">
          <Characters text={shown.leaving} mode="leave" />
        </span>
      )}
      </span>
    </h1>
  )
}
