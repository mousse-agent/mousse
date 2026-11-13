import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { useMotionScale } from './motion'
import '../styles/turning.css'

/**
 * How each spinner class turns: one full turn every `ms`, linearly, every frame. Every rotating spinner turns this
 * way, through Turning, and no stylesheet rotates anything forever (tests/renderer/loopingIndicatorSteps.test.ts).
 *
 * Why here and not in CSS. Chromium runs an `<svg>` element's transform animation on the main thread: style, a
 * commit and a repaint every frame. So the turn is on a `<span>` around the still svg, which the compositor runs.
 * It is a Web Animation rather than a CSS one because a CSS animation that repeats wakes the main thread at every
 * iteration (a few frames of style and commit each turn) once the document listens for `animationiteration`, and
 * React listens for it on its root. A Web Animation fires no iteration events, so while a spinner turns the main
 * thread does nothing for it.
 *
 * Motion: `keep` spinners show pending work and keep turning with Animation speed Off or the OS reduced-motion
 * setting (as `.icon-spin` and `.spin` did in CSS); the others are still then.
 */
const TURNS: Readonly<Record<string, { ms: number; keep?: boolean; from?: number }>> = {
  'icon-spin': { ms: 1000, keep: true },
  spin: { ms: 800, keep: true },
  'animate-spin': { ms: 1000 },
  'chat-spin': { ms: 1000 },
  'inbox-spin': { ms: 1100 },
  'pr-panel-spin': { ms: 1000 },
  'side-card-action-spin': { ms: 900 },
  'side-card-git-next-spin': { ms: 900 },
  'read-aloud-spin': { ms: 900 },
  'composer-transcribing-spin': { ms: 900 },
  'downloads-ring-spin': { ms: 1000, from: -90 },
}

/** Classes that turn an icon. */
export const TURNING_CLASSES: ReadonlySet<string> = new Set(Object.keys(TURNS))

/** The turn a class list asks for, if any: the first turning class wins. */
export function turnOf(className: string | undefined) {
  const name = className?.split(/\s+/).find((part) => part in TURNS)
  return name === undefined ? undefined : TURNS[name]
}

/** True when the class list names a turning class. */
export function turns(className: string | undefined): boolean {
  return turnOf(className) !== undefined
}

/**
 * A span that turns around its content while its classes name a turning class. It keeps every class, so it sits and
 * sizes as the icon did (turning.css, which also switches off Tailwind's CSS `animate-spin` on it).
 */
export function Turning({ className, children }: { className: string; children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const turn = turnOf(className)
  const motionOff = useMotionScale() === 0
  const still = !turn || (motionOff && !turn.keep)
  const ms = turn?.ms ?? 0
  const from = turn?.from ?? 0
  useLayoutEffect(() => {
    const span = ref.current
    if (still || !span || typeof span.animate !== 'function') return
    const animation = span.animate(
      [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + 360}deg)` }],
      { duration: ms, iterations: Infinity, easing: 'linear' },
    )
    return () => animation.cancel()
  }, [still, ms, from])
  return <span ref={ref} className={`turning ${className}`.trim()}>{children}</span>
}

/**
 * Draws an icon, inside a Turning span when its classes turn it. `draw` receives the classes the `<svg>` keeps: all
 * of them for a still icon, none for a turning one (the span takes them).
 */
export function turnable(className: string | undefined, draw: (className: string) => ReactElement): ReactElement {
  if (!turns(className)) return draw(className ?? '')
  return <Turning className={className!}>{draw('')}</Turning>
}
