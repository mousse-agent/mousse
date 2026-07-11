import { useRef, type PointerEventHandler } from 'react'

export function useWindowDrag(): {
  onPointerDown: PointerEventHandler<HTMLElement>
  onPointerMove: PointerEventHandler<HTMLElement>
  onPointerUp: PointerEventHandler<HTMLElement>
  onPointerCancel: PointerEventHandler<HTMLElement>
} {
  const draggingPointerId = useRef<number | null>(null)

  const getDragPoint = (event: React.PointerEvent<HTMLElement>) => ({
    screenX: event.screenX,
    screenY: event.screenY
  })

  const onPointerDown: PointerEventHandler<HTMLElement> = (event) => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return

    draggingPointerId.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    void window.mousse.window.dragStart(getDragPoint(event))
  }

  const onPointerMove: PointerEventHandler<HTMLElement> = (event) => {
    if (draggingPointerId.current !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      draggingPointerId.current = null
      void window.mousse.window.dragEnd()
      return
    }

    void window.mousse.window.dragMove(getDragPoint(event))
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (draggingPointerId.current !== event.pointerId) return
    draggingPointerId.current = null
    void window.mousse.window.dragEnd()
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag
  }
}
