/**
 * How the transcript keeps up with a reply in progress, as pure arithmetic: how an empty space
 * under the content holds the end while something near it is replaced, and how it closes. The DOM side is `end-follower.ts`.
 *
 * Positions are scroll-space pixels: 0 is the top of the transcript's content.
 */

/**
 * The part of an empty space under the content (`reserve`) that the current view still stands on.
 * Removing the rest changes nothing on screen: it is below the viewport, or the content fits the
 * viewport and nothing is scrolled. Never more than `reserve`, so the space only ever shrinks.
 */
export function heldReserve(input: {
  reserve: number;
  scrollTop: number;
  clientHeight: number;
  contentHeight: number;
}): number {
  const { reserve, scrollTop, clientHeight, contentHeight } = input;
  if (reserve <= 0) return 0;
  // Without the space the view could still scroll this far: nothing would move.
  if (scrollTop <= Math.max(0, contentHeight - clientHeight)) return 0;
  return Math.min(reserve, Math.ceil(scrollTop + clientHeight - contentHeight));
}

/**
 * The empty space under the content that keeps the transcript `total` px tall, so the end, and the
 * view standing on it, do not move when something near the end leaves before what replaces it
 * arrives (a queued message sent into the reply, the next queued turn starting). 0 once the content
 * has grown back to `total`.
 */
export function heldTotalReserve(input: { total: number; contentHeight: number }): number {
  return Math.max(0, Math.ceil(input.total - input.contentHeight));
}

/**
 * How long the end is held after a turn ends with messages still queued, waiting for the next turn
 * to start. Past this the space closes as after any turn.
 */
export const QUEUED_TURN_HOLD_MS = 1500;

/** How long the space under a finished reply takes to close, at normal Animation speed. */
export const COLLAPSE_MS = 260;

/** The space left `elapsed` ms into closing a space of `from` px (ease out: fast first, settling). */
export function collapsedReserve(from: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return 0;
  const t = Math.max(0, elapsed / duration);
  return Math.round(from * Math.pow(1 - t, 3));
}
