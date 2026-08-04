import { type PointerEvent, type ReactNode, useCallback, useState } from 'react'

const STORAGE_KEY = 'mousse:main-panel-sidebar-width'
const MIN_WIDTH = 160
const MIN_CONTENT_WIDTH = 240

function initialWidth(defaultWidth: number): number {
  const stored = Number.parseInt(window.localStorage.getItem(STORAGE_KEY) ?? '', 10)
  return Number.isFinite(stored) ? Math.max(MIN_WIDTH, stored) : defaultWidth
}

export function ResizablePanelSidebar({
  className,
  defaultWidth,
  children
}: {
  className: string
  defaultWidth: number
  children: ReactNode
}) {
  const [width, setWidth] = useState(() => initialWidth(defaultWidth))

  const updateWidth = useCallback((next: number, parentWidth?: number) => {
    const max = parentWidth ? Math.max(MIN_WIDTH, parentWidth - MIN_CONTENT_WIDTH) : Infinity
    const value = Math.round(Math.min(max, Math.max(MIN_WIDTH, next)))
    setWidth(value)
    window.localStorage.setItem(STORAGE_KEY, String(value))
  }, [])

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const panelWidth = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width
    event.currentTarget.setPointerCapture(event.pointerId)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const move = (moveEvent: globalThis.PointerEvent) =>
      updateWidth(startWidth + moveEvent.clientX - startX, panelWidth)
    const stop = () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <div className={`${className} resizable-panel-sidebar`} style={{ width }}>
      {children}
      <div
        className="panel-sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          updateWidth(width + (event.key === 'ArrowRight' ? 16 : -16), event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width)
        }}
      />
    </div>
  )
}
