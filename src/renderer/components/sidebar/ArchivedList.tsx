import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react'
import type { Thread } from '../../../shared/types'

/** A card's height before it has been measured; the average of the measured ones once there are some. */
export const ARCHIVED_ROW_ESTIMATE = 56
/** Rows drawn before the footer has a height to measure (the first frame, a hidden footer, no layout). */
export const ARCHIVED_FIRST_ROWS = 24
/** Rows drawn past each edge of the footer's view, so a scroll shows drawn rows while the next window renders. */
export const ARCHIVED_OVERSCAN = 6

export interface RowRange {
  start: number
  end: number
}

/**
 * The tops of rows laid out one after another, `gap` apart: `tops[i]` is where row `i` starts and `tops[count]` is
 * one gap past the last row's end.
 */
export function rowTops(heights: readonly number[], gap: number): number[] {
  const tops = new Array<number>(heights.length + 1)
  tops[0] = 0
  for (let index = 0; index < heights.length; index++) tops[index + 1] = tops[index] + heights[index] + gap
  return tops
}

/** The first row that ends below `offset` (`tops.length - 1` when none does). */
function rowAt(tops: readonly number[], offset: number): number {
  let low = 0
  let high = tops.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (tops[middle + 1] > offset) high = middle
    else low = middle + 1
  }
  return low
}

/**
 * The rows that cover `[viewTop, viewTop + viewHeight)` of the list, plus `overscan` rows past each edge. A view with
 * no height (nothing laid out yet) draws the first `ARCHIVED_FIRST_ROWS`.
 */
export function rowRange(tops: readonly number[], viewTop: number, viewHeight: number, overscan = ARCHIVED_OVERSCAN): RowRange {
  const count = tops.length - 1
  if (viewHeight <= 0) return { start: 0, end: Math.min(count, ARCHIVED_FIRST_ROWS) }
  const first = rowAt(tops, Math.max(0, viewTop))
  const last = rowAt(tops, viewTop + viewHeight)
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + 1 + overscan) }
}

/** The thread of the row `target` is in. */
function rowIdOf(target: EventTarget | null): string | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>('.threads-sidebar-thread-container')?.querySelector<HTMLElement>('[data-thread-id]')?.dataset.threadId
    : undefined
}

type Part ={ kind: 'row'; index: number } | { kind: 'gap'; from: number; to: number }

/** The drawn rows in order (the window and the kept rows), with a spacer for each run of rows between them. */
export function listParts(count: number, range: RowRange, kept: Iterable<number>): Part[] {
  const drawn = new Set<number>()
  // The window may be from before the list got shorter: it is cut to the rows there are.
  for (let index = range.start; index < Math.min(range.end, count); index++) drawn.add(index)
  for (const index of kept) if (index >= 0 && index < count) drawn.add(index)
  const parts: Part[] = []
  let next = 0
  for (const index of [...drawn].sort((a, b) => a - b)) {
    if (index > next) parts.push({ kind: 'gap', from: next, to: index })
    parts.push({ kind: 'row', index })
    next = index + 1
  }
  if (next < count) parts.push({ kind: 'gap', from: next, to: count })
  return parts
}

export type ArchivedListProps = {
  threads: readonly Thread[]
  renderRow: (thread: Thread) => ReactNode
  /** The footer that scrolls the list. */
  scrollRef: RefObject<HTMLElement | null>
  /** Rows kept drawn wherever they are scrolled to: the one whose menu is open, the one being renamed. */
  keepIds?: readonly string[]
  /** The open thread: its row is scrolled into view when the list opens and when another archived thread opens. */
  revealId?: string
}

/**
 * The Archived list: only the cards in the footer's view (and a few past each edge) are drawn, with a spacer for the
 * rest, so a list of hundreds opens and scrolls as fast as a short one. Heights are measured as cards draw; cards not
 * measured yet count as the average. The row with keyboard focus stays drawn when it scrolls away, so focus is kept.
 * It is mounted only while Archived is open, so a closed list builds nothing.
 */
export function ArchivedList({ threads, renderRow, scrollRef, keepIds, revealId }: ArchivedListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  // Measured border-box heights by thread, and the element each drawn row is.
  const heights = useRef(new Map<string, number>())
  const observed = useRef(new Map<Element, string>())
  const [measured, setMeasured] = useState(0)
  const [gap, setGap] = useState(0)
  const [range, setRange] = useState<RowRange>({ start: 0, end: Math.min(threads.length, ARCHIVED_FIRST_ROWS) })
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const tops = useMemo(() => {
    const known = [...heights.current.values()]
    const estimate = known.length ? known.reduce((sum, height) => sum + height, 0) / known.length : ARCHIVED_ROW_ESTIMATE
    return rowTops(threads.map((thread) => heights.current.get(thread.id) ?? estimate), gap)
    // `measured` counts changes to `heights`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, gap, measured])
  const topsRef = useRef(tops)
  topsRef.current = tops

  /** Where the list starts in the footer's scrolled content. */
  const listOffset = useCallback((scroller: HTMLElement, list: HTMLElement) =>
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop, [])

  const sync = useCallback(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    if (!scroller || !list) return
    const next = rowRange(topsRef.current, scroller.scrollTop - listOffset(scroller, list), scroller.clientHeight)
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next))
    // Read as the window moves too: a page without focus (a window in the background) sends no focus events.
    const active = document.activeElement
    setFocusedId(active && list.contains(active) ? rowIdOf(active) ?? null : null)
  }, [listOffset, scrollRef])

  // Heights of the rows drawn in a commit are read before the frame is painted; later changes (a title that wraps, a
  // row that opens or closes as it is archived) come from the observer.
  const record = useCallback((element: Element, height: number) => {
    const id = observed.current.get(element)
    if (!id || height <= 0 || Math.abs((heights.current.get(id) ?? -1) - height) < 0.5) return false
    heights.current.set(id, height)
    return true
  }, [])
  const observer = useMemo(() => (typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) changed = record(entry.target, entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height) || changed
      if (changed) setMeasured((count) => count + 1)
    })
    : null), [record])
  useLayoutEffect(() => () => {
    observer?.disconnect()
    observed.current.clear()
  }, [observer])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const rowGap = Number.parseFloat(getComputedStyle(list).rowGap)
    setGap(Number.isFinite(rowGap) ? rowGap : 0)
  }, [])

  // After every commit, as any commit may draw new rows. It updates only for a row not read before, so it settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const drawn = new Map<Element, string>()
    for (const child of list.children) {
      const id = child.querySelector<HTMLElement>('[data-thread-id]')?.dataset.threadId
      if (id) drawn.set(child, id)
    }
    let changed = false
    for (const element of observed.current.keys()) {
      if (drawn.has(element)) continue
      observer?.unobserve(element)
      observed.current.delete(element)
    }
    // Only rows drawn just now are read here (one layout for the lot); the observer follows them from then on.
    for (const [element, id] of drawn) {
      if (observed.current.has(element)) continue
      observed.current.set(element, id)
      observer?.observe(element)
      changed = record(element, element.getBoundingClientRect().height) || changed
    }
    if (changed) setMeasured((count) => count + 1)
  })

  // The window follows the footer's scroll and size, and the list's measured heights.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', sync, { passive: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null
    resize?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', sync)
      resize?.disconnect()
    }
  }, [scrollRef, sync])
  useLayoutEffect(sync, [sync, tops])

  // The open thread's row: on screen when the list opens, and when another archived thread opens. It waits while
  // Archived opens (its rows are capped and cannot scroll then), scrolls to the row's estimated place so it is drawn,
  // then puts the drawn row's own box in the middle of the view if any of it is cut off.
  const revealIndex = revealId ? threads.findIndex((thread) => thread.id === revealId) : -1
  const revealed = useRef<string | null>(null)
  const pending = useRef<{ id: string; index: number } | null>(null)
  pending.current = revealId && revealIndex >= 0 && revealed.current !== revealId ? { id: revealId, index: revealIndex } : null
  const reveal = useCallback(() => {
    const target = pending.current
    const scroller = scrollRef.current
    const list = listRef.current
    if (!target || !scroller || !list || scroller.clientHeight <= 0 || list.closest('.ui-collapse[data-motion]')) return
    const view = scroller.getBoundingClientRect()
    const row = heights.current.has(target.id)
      ? [...list.querySelectorAll<HTMLElement>('[data-thread-id]')].find((item) => item.dataset.threadId === target.id)
      : undefined
    if (row) {
      const box = (row.closest('.threads-sidebar-thread-container') ?? row).getBoundingClientRect()
      if (box.top < view.top || box.bottom > view.bottom) scroller.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2)
      revealed.current = target.id
      pending.current = null
    } else {
      const tops = topsRef.current
      const middle = listOffset(scroller, list) + (tops[target.index] + tops[target.index + 1] - gap) / 2
      scroller.scrollTop = middle - scroller.clientHeight / 2
    }
    sync()
  }, [gap, listOffset, scrollRef, sync])
  // Again once a drawn row is measured (tops), when the footer changes size, and when Archived finishes opening.
  useLayoutEffect(reveal, [reveal, revealId, revealIndex, tops])
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const collapse = listRef.current?.closest('.ui-collapse')
    const resize = scroller && typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null
    if (scroller) resize?.observe(scroller)
    const motion = collapse && typeof MutationObserver === 'function' ? new MutationObserver(reveal) : null
    if (collapse) motion?.observe(collapse, { attributes: true, attributeFilter: ['data-motion'] })
    return () => {
      resize?.disconnect()
      motion?.disconnect()
    }
  }, [reveal, scrollRef])

  const indexOf = useMemo(() => new Map(threads.map((thread, index) => [thread.id, index])), [threads])
  const kept = [...(keepIds ?? []), ...(focusedId ? [focusedId] : [])].map((id) => indexOf.get(id) ?? -1)
  const parts = listParts(threads.length, range, kept)

  const onFocus = (event: FocusEvent<HTMLDivElement>) => setFocusedId(rowIdOf(event.target) ?? null)
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!listRef.current?.contains(event.relatedTarget as Node | null)) setFocusedId(null)
  }

  return (
    <div ref={listRef} className="threads-sidebar-tree threads-sidebar-thread-feed threads-sidebar-archived-list" onFocus={onFocus} onBlur={onBlur}>
      {parts.map((part) => part.kind === 'row'
        ? renderRow(threads[part.index])
        : <div key={`gap:${part.from}`} className="threads-sidebar-archived-spacer" aria-hidden="true" style={{ height: Math.max(0, tops[part.to] - tops[part.from] - gap) }} />)}
    </div>
  )
}
