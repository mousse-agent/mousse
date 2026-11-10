import { useLayoutEffect, useState, type RefObject } from 'react'

/** Rows drawn before the list has a measured height, so a list never opens blank. */
export const UNMEASURED_ROWS = 40

export interface RowWindow {
  /** First row drawn. */
  start: number
  /** One past the last row drawn. */
  end: number
}

/**
 * The rows of a fixed-height list that cover the scrolled viewport, plus `overscan` rows on each side.
 * `firstVisible` and `visibleRows` are in rows; an unmeasured viewport (0 rows) draws `UNMEASURED_ROWS`.
 */
export function rowWindow(firstVisible: number, visibleRows: number, count: number, overscan: number): RowWindow {
  const shown = visibleRows > 0 ? visibleRows : UNMEASURED_ROWS
  const start = Math.max(0, Math.min(firstVisible, count) - overscan)
  return { start, end: Math.min(count, Math.max(firstVisible, 0) + shown + overscan) }
}

/**
 * Tracks which rows of a fixed-height list inside a scrolling element are on screen.
 * `listRef` is the list inside `scrollRef`; the scroller must be its offset parent (position: relative).
 * Re-renders only when the first visible row or the number of visible rows changes.
 */
export function useFixedRowWindow(
  scrollRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan = 8
): RowWindow {
  const [view, setView] = useState({ first: 0, rows: 0 })
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const measure = () => {
      const top = Math.max(0, scroller.scrollTop - (listRef.current?.offsetTop ?? 0))
      const first = Math.floor(top / rowHeight)
      const rows = Math.ceil(scroller.clientHeight / rowHeight)
      setView((current) => (current.first === first && current.rows === rows ? current : { first, rows }))
    }
    measure()
    scroller.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [listRef, rowHeight, scrollRef])
  return rowWindow(view.first, view.rows, count, overscan)
}
