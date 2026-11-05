/** Geometry for the sidebar's list: whether rows sit below the fold, and how far to scroll to show a project. */

type Scroller = { scrollHeight: number; scrollTop: number; clientHeight: number }
type Edges = { top: number; bottom: number }

/** Rows sit below the visible part of the scroll container. */
export function hasMoreBelow(scroller: Scroller): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1
}

/**
 * How far to scroll so a just-opened project's rows come into view. It scrolls only as far as needed, and never
 * so far that the project's own row leaves the top. Positive scrolls down.
 */
export function revealDelta(view: Edges, target: Edges): number {
  if (target.top < view.top) return target.top - view.top
  if (target.bottom <= view.bottom) return 0
  return Math.min(target.bottom - view.bottom, target.top - view.top)
}
