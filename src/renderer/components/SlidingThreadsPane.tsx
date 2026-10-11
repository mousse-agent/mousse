import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import '../styles/sliding-threads-pane.css'

const CLOSE_FALLBACK_MS = 250

interface SlidingThreadsPaneProps {
  open: boolean
  width: number
  children: ReactNode
  resizer?: ReactNode
  paneRef?: Ref<HTMLDivElement>
  overlay?: boolean
  resizing?: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

/** Animate the reserved flex width as well as the clipped sidebar contents. */
export function SlidingThreadsPane({ open, width, children, resizer, paneRef, overlay = false, resizing = false, onMouseEnter, onMouseLeave }: SlidingThreadsPaneProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const presentRef = useRef(open)
  const openRef = useRef(open)
  openRef.current = open
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(open)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    let frame: number | undefined
    let timer: number | undefined
    if (open) {
      const wasPresent = presentRef.current
      presentRef.current = true
      setPresent(true)
      if (wasPresent || reducedMotion) setExpanded(true)
      else frame = requestAnimationFrame(() => setExpanded(true))
    } else {
      const element = elementRef.current
      const active = document.activeElement
      if (active instanceof HTMLElement && element?.contains(active)) {
        const toggle = element.closest('.app')?.querySelector<HTMLButtonElement>('.titlebar-sidebar-toggle')
        if (toggle) toggle.focus({ preventScroll: true })
        else active.blur()
      }
      setExpanded(false)
      const finish = () => {
        if (openRef.current) return
        // A backgrounded renderer may start its transition after the timer.
        // Keep the inert contents until the actual geometry is collapsed.
        if (!reducedMotion && element) {
          const content = element.querySelector<HTMLElement>('.sliding-threads-pane-content')
          const collapsed = overlay
            ? !content || content.getBoundingClientRect().right <= element.getBoundingClientRect().left + 0.5
            : element.getBoundingClientRect().width <= 0.5
          if (!collapsed) { timer = window.setTimeout(finish, 50); return }
        }
        presentRef.current = false
        setPresent(false)
      }
      if (reducedMotion) finish()
      else timer = window.setTimeout(finish, CLOSE_FALLBACK_MS)
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [open, reducedMotion, overlay])

  const finishClose = () => {
    if (openRef.current) return
    presentRef.current = false
    setPresent(false)
  }

  return (
    <div
      ref={(element) => {
        elementRef.current = element
        if (typeof paneRef === 'function') paneRef(element)
        else if (paneRef) paneRef.current = element
      }}
      className={`sliding-threads-pane${overlay ? ' sliding-threads-pane--overlay' : ''}${expanded ? ' is-expanded' : ''}${present ? '' : ' is-hidden'}${resizing ? ' is-resizing' : ''}`}
      style={{ '--threads-pane-width': `${width}px`, '--threads-pane-layout-width': `${width + (resizer ? 1 : 0)}px` } as CSSProperties}
      aria-hidden={!open}
      inert={!open}
      onMouseEnter={onMouseEnter}
      onMouseLeave={() => { if (!elementRef.current?.contains(document.activeElement)) onMouseLeave?.() }}
      onFocusCapture={overlay ? onMouseEnter : undefined}
      onBlurCapture={overlay ? (event) => { if (!event.currentTarget.contains(event.relatedTarget)) onMouseLeave?.() } : undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'width') finishClose()
      }}
    >
      <div className="sliding-threads-pane-clip">
        <div className="sliding-threads-pane-content" onTransitionEnd={(event) => {
          if (overlay && event.target === event.currentTarget && event.propertyName === 'transform') finishClose()
        }}>
          {present && children}
        </div>
      </div>
      {present && resizer}
    </div>
  )
}
