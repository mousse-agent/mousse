import { useEffect, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'
import '../../styles/collapse.css'

/** Open and close durations; keep in step with `styles/collapse.css`. */
export const COLLAPSE_OPEN_MS = 160
export const COLLAPSE_CLOSE_MS = 130
/** Per-item delay, the number of items that get one, and the list length above which items do not stagger. */
export const COLLAPSE_STAGGER_MS = 12
export const COLLAPSE_STAGGER_ITEMS = 8
export const COLLAPSE_LONG_LIST = 40

/** Class for a native `<details>` disclosure: its content opens and closes with the same height and fade (CSS only). */
export const COLLAPSE_DETAILS_CLASS = 'ui-collapse-details'

type Phase ='closed' | 'entering' | 'open' | 'exiting'

/** False with reduced motion, and where no `matchMedia` exists (no renderer to animate in): changes apply at once. */
export function motionAllowed(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export type CollapseProps = {
  open: boolean
  children: ReactNode
  /** Element of the inner wrapper, which holds `className` and whose children are the items (`ul` for a list). */
  as?: ElementType
  className?: string
  style?: CSSProperties
  id?: string
  /** Rows in the list. Above `COLLAPSE_LONG_LIST` the items do not stagger; the container still animates. */
  itemCount?: number
  /** False when the change was not the user's (a group revealed for the thread being opened): it applies at once. */
  animate?: boolean
  'data-testid'?: string
}

/**
 * Shows `children` when `open`, with a quick height and fade animation when `open` changes.
 *
 * The first render shows the current state without animating, so restoring a group's state (a remount,
 * a thread switch) never plays the motion. Closed content is unmounted once the close finishes; while
 * it closes it is `inert` and hidden from screen readers. With reduced motion it opens and closes at once.
 * The trigger keeps its own `aria-expanded`.
 */
export function Collapse({ open, children, as: Inner = 'div', className, style, id, itemCount, animate = true, 'data-testid': testId }: CollapseProps) {
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed')
  const [shownOpen, setShownOpen] = useState(open)
  // React's "adjust state while rendering": the new phase applies in the same commit as the change of
  // `open`, so an opening group never paints one frame at full height first.
  if (open !== shownOpen) {
    setShownOpen(open)
    const instant = !animate || !motionAllowed()
    setPhase(open ? (instant ? 'open' : 'entering') : (instant ? 'closed' : 'exiting'))
  }

  useEffect(() => {
    if (phase !== 'entering' && phase !== 'exiting') return
    const settle = phase === 'entering'
      ? COLLAPSE_OPEN_MS + COLLAPSE_STAGGER_MS * (COLLAPSE_STAGGER_ITEMS - 1)
      : COLLAPSE_CLOSE_MS
    const timer = setTimeout(() => setPhase(phase === 'entering' ? 'open' : 'closed'), settle + 40)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'closed') return null
  const closing = phase === 'exiting'
  const stagger = itemCount === undefined || itemCount <= COLLAPSE_LONG_LIST
  return (
    <div
      className="ui-collapse"
      data-state={closing ? 'closed' : 'open'}
      data-motion={phase === 'entering' ? 'enter' : closing ? 'exit' : undefined}
      data-stagger={stagger ? '' : undefined}
      inert={closing || undefined}
      aria-hidden={closing || undefined}
    >
      <div className="ui-collapse-clip">
        <Inner className={className} style={style} id={id} data-testid={testId}>
          {children}
        </Inner>
      </div>
    </div>
  )
}
