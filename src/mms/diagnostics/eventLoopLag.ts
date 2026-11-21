/**
 * How long the service's event loop was held while something is measured (a turn's timing, its start boundary): one
 * interval timer, running only while at least one watch is open, notes how late each of its ticks fires. A watch keeps
 * the largest delay it saw. With no watch open there is no timer, so an idle service is never woken by it.
 */

/** How often the heartbeat ticks. A delay shorter than this cannot be told from an idle loop's jitter. */
const INTERVAL_MS = 50

interface Watch { maxMs: number }

const watches = new Set<Watch>()
let timer: ReturnType<typeof setInterval> | undefined
let last = 0

function tick(): void {
  const now = performance.now()
  const lag = now - last - INTERVAL_MS
  last = now
  for (const watch of watches) if (lag > watch.maxMs) watch.maxMs = lag
}

export interface EventLoopLagWatch {
  /** Ends the watch and returns the largest delay it saw, in whole milliseconds. */
  stop(): number
}

/** Starts a watch; the heartbeat runs until every watch is stopped. */
export function watchEventLoopLag(): EventLoopLagWatch {
  const watch: Watch = { maxMs: 0 }
  watches.add(watch)
  if (!timer) {
    last = performance.now()
    timer = setInterval(tick, INTERVAL_MS)
    timer.unref?.()
  }
  return {
    stop() {
      if (watches.delete(watch)) {
        // A tick that is overdue as the watch ends (the loop is held right up to its end) counts too.
        const pending = performance.now() - last - INTERVAL_MS
        if (pending > watch.maxMs) watch.maxMs = pending
        if (!watches.size && timer) {
          clearInterval(timer)
          timer = undefined
        }
      }
      return Math.round(watch.maxMs)
    }
  }
}
