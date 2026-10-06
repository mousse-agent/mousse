import { useEffect, useRef, type ReactNode } from 'react'

/** A resize can end over the caption controls as the native window moves.
 * Only a click that began on Close may close a Linux window. */
export function WindowCloseButton({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const press = useRef<{ x: number; y: number; pointerId: number; released: boolean } | null>(null)
  const linux = window.mousse.platform === 'linux'
  useEffect(() => {
    if (!linux) return
    const clear = () => { press.current = null }
    const move = (event: PointerEvent) => {
      const start = press.current
      if (start && event.pointerId === start.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) clear()
    }
    const up = (event: PointerEvent) => {
      if (press.current?.pointerId !== event.pointerId) return
      if (event.target instanceof Node && button.current?.contains(event.target)) press.current.released = true
      else clear()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [linux])
  return <button ref={button} type="button" className="icon-btn icon-btn-titlebar titlebar-close" title="Close" aria-label="Close"
    onPointerDown={(event) => { press.current = event.button === 0 ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId, released: false } : null }}
    onPointerLeave={() => { press.current = null }}
    onPointerCancel={() => { press.current = null }}
    onBlur={() => { press.current = null }}
    onClick={(event) => {
      const intentional = event.detail === 0 || press.current?.released === true
      press.current = null
      if (linux && !intentional) { event.preventDefault(); event.stopPropagation(); return }
      onClose()
    }}>{children}</button>
}
