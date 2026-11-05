/** Pixels one Left or Right press moves a pane divider. */
export const RESIZER_KEY_STEP = 16

/** Default widths a double-click on a divider restores. */
export const DEFAULT_THREADS_SIDEBAR_WIDTH = 260
/** The conversation's share of the workspace, in percent. */
export const DEFAULT_SIDEBAR_WIDTH = 30

/**
 * The width a key moves a vertical divider to, or undefined for keys that do not resize.
 * Left narrows and Right widens the pane on the divider's left by one step; Home and End go to
 * its minimum and maximum. The result stays within `min` and `max`.
 */
export function resizerKeyTarget(key: string, width: number, min: number, max: number): number | undefined {
  const clamp = (value: number) => Math.min(max, Math.max(min, value))
  if (key === 'ArrowLeft') return clamp(width - RESIZER_KEY_STEP)
  if (key === 'ArrowRight') return clamp(width + RESIZER_KEY_STEP)
  if (key === 'Home') return min
  if (key === 'End') return max
  return undefined
}
