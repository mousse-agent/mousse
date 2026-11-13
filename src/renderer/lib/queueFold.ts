/**
 * How much of a long queue shows at the end of the transcript.
 *
 * The queue sits under the reply being read, and while the thread follows the end it sits on the
 * bottom of the view. It may take up to a third of the transcript's visible height: the reply above
 * keeps two thirds, and a third still holds a long queued message (a long prompt shows folded to
 * about 200 px) or a few short ones on a laptop-sized window. Past that the queue is cut back to
 * the whole messages that fit from the top, with a "Show all N queued" line under them.
 */
export const QUEUE_FOLD_SHARE = 1 / 3

/** The most height the queue's messages take before it folds, for a transcript whose visible part is `visibleHeight`. */
export function queueFoldLimit(visibleHeight: number): number {
  return Math.max(0, visibleHeight) * QUEUE_FOLD_SHARE
}

/**
 * How many queued messages show, from the top, given each one's height (bubble and line).
 *
 * All of them while together they fit in `limit`. Otherwise as many whole messages as fit, and
 * always at least one: a message is never cut in half. The "Show all" line under a folded queue is
 * not counted, so a message added to a queue that fit never hides one that was showing. A limit
 * that is not known yet (0) folds nothing.
 */
export function queueFoldCount(heights: readonly number[], limit: number): number {
  // Half a pixel of slack, so subpixel layout does not fold a queue that just fits.
  const room = limit + 0.5
  if (!(limit > 0) || heights.length === 0) return heights.length
  let used = 0
  let count = 0
  for (const height of heights) {
    if (used + height > room) break
    used += height
    count += 1
  }
  return Math.max(1, Math.min(count, heights.length))
}
