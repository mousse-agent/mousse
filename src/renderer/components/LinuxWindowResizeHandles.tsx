import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { WINDOW_RESIZE_BORDER, WINDOW_RESIZE_CORNER, WINDOW_RESIZE_EDGES, type WindowResizeEdge } from '../../shared/windowResize'
import '../styles/linux-window.css'

/** The handles sit above titlebar drag regions and portaled dialogs. */
export function LinuxWindowResizeHandles() {
  const gesture = useRef<{ pointerId: number; element: HTMLDivElement; frame?: number } | null>(null)
  const stop = useCallback(() => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    if (current.frame !== undefined) cancelAnimationFrame(current.frame)
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    void window.mousse.window.resizeEnd(current.pointerId)
  }, [])
  useEffect(() => {
    if (window.mousse.platform !== 'linux') return
    window.addEventListener('blur', stop)
    return () => { window.removeEventListener('blur', stop); stop() }
  }, [stop])
  if (window.mousse.platform !== 'linux') return null
  const down = (edge: WindowResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || document.documentElement.dataset.windowMaximized === 'true') return
    event.preventDefault(); event.stopPropagation()
    stop()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { pointerId: event.pointerId, element: event.currentTarget }
    void window.mousse.window.resizeStart(edge, event.pointerId)
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) { stop(); return }
    if (current.frame !== undefined) return
    current.frame = requestAnimationFrame(() => {
      current.frame = undefined
      if (gesture.current === current) void window.mousse.window.resizeMove(current.pointerId)
    })
  }
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => { if (gesture.current?.pointerId === event.pointerId) stop() }
  return <div className="linux-window-resize-handles" aria-hidden="true" style={{ '--window-resize-border': `${WINDOW_RESIZE_BORDER}px`, '--window-resize-corner': `${WINDOW_RESIZE_CORNER}px` } as CSSProperties}>
    {WINDOW_RESIZE_EDGES.map((edge) => <div key={edge} data-resize-edge={edge} className={`linux-window-resize-handle resize-${edge}`}
      onPointerDown={(event) => down(edge, event)} onPointerMove={move}
      onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer} />)}
  </div>
}
