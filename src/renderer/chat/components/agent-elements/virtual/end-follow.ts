/**
 * How the transcript keeps up with a reply in progress, as pure arithmetic: where a just-sent
 * prompt is held, how much empty space under the reply that takes, and how the view moves toward
 * the end once the reply outgrows the screen. The DOM side is `end-follower.ts`.
 *
 * Positions are scroll-space pixels: 0 is the top of the transcript's content.
 */

/**
 * Where a just-sent prompt's turn sits, from the top of the viewport. The same as the list's top
 * padding, so the first prompt of a thread is already there and nothing scrolls for it.
 */
export const PIN_TOP = 24;

/**
 * The empty space under the content that lets a turn starting at `rowTop` sit `PIN_TOP` below the
 * top of the viewport while its reply is shorter than the screen. As the reply grows the space
 * shrinks by as much, so the end of the transcript, and with it the view, stays where it is. 0 once
 * the reply reaches the bottom of the viewport: from there the end is followed.
 */
export function pinnedReserve(input: { rowTop: number; clientHeight: number; contentHeight: number }): number {
  return Math.max(0, Math.ceil(input.rowTop - PIN_TOP + input.clientHeight - input.contentHeight));
}

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
 * How quickly a glide closes on the end at normal Animation speed: the time constant of an
 * exponential ease, so about 95% of the way is covered in three of these (about 250 ms).
 */
export const GLIDE_TAU_MS = 85;
/** The longest frame a glide step accounts for: after a stall it resumes, it does not leap. */
const GLIDE_MAX_FRAME_MS = 50;

/**
 * One frame of a glide from `position` toward `target`: an eased step that covers a share of what
 * is left, so a target that moves (the reply grew again) is simply aimed at anew. `scale` is the
 * Animation speed multiplier; 0 (Off, or the system reducing motion) lands at once. Each step moves
 * at least a pixel and never past the target, so a glide always ends.
 */
export function glideStep(position: number, target: number, frameMs: number, scale: number): number {
  const remaining = target - position;
  if (scale <= 0 || Math.abs(remaining) <= 1) return target;
  const dt = Math.min(Math.max(frameMs, 0), GLIDE_MAX_FRAME_MS);
  const share = 1 - Math.exp(-dt / (GLIDE_TAU_MS * scale));
  const step = Math.max(1, Math.abs(remaining) * share);
  return Math.abs(remaining) <= step ? target : position + Math.sign(remaining) * step;
}

/** How long the space under a finished reply takes to close, at normal Animation speed. */
export const COLLAPSE_MS = 260;

/** The space left `elapsed` ms into closing a space of `from` px (ease out: fast first, settling). */
export function collapsedReserve(from: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return 0;
  const t = Math.max(0, elapsed / duration);
  return Math.round(from * Math.pow(1 - t, 3));
}
