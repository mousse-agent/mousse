import { AppError } from '../../shared/errors'

/**
 * How long a turn may go without any word from its runtime (text, thinking, a tool's start, output or end, a retry, a
 * compaction, usage) before it is taken as hung and ends as failed. A turn has no limit on its total time: it runs
 * for days as long as it makes progress. Generous on purpose: past any runtime's own timeout on one tool call.
 */
export const TURN_STALL_MS = 2 * 60 * 60_000
/** How often the check looks. A gap between looks longer than two of them (the computer slept) counts as two. */
export const TURN_STALL_TICK_MS = 60_000

/** The reason a turn's abort carries when its no-progress check ended it. */
export class TurnStalledError extends AppError {
  constructor(readonly stalledMs: number) {
    const minutes = Math.max(1, Math.round(stalledMs / 60_000))
    const span = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`
    super({
      code: 'turn_stalled',
      message: `The turn made no progress for ${span}, so it was stopped. What it did so far is kept; send a message to go on.`,
      errorInfo: { category: 'timeout', retryable: false }
    })
    this.name = 'TurnStalledError'
  }
}

export interface TurnProgressWatch {
  /** The runtime said something: the turn is alive. */
  progress(): void
  stop(): void
}

/**
 * Watches one turn for progress: `onStall` once it has gone `stallMs` without `progress()`. Time while `waiting()` (a
 * person is being asked something: a question or an approval) is never counted, and neither is time the computer
 * slept beyond two looks.
 */
export function watchTurnProgress(options: {
  stallMs?: number
  tickMs?: number
  waiting(): boolean
  onStall(stalledMs: number): void
  now?: () => number
}): TurnProgressWatch {
  const stallMs = options.stallMs ?? TURN_STALL_MS
  const tickMs = options.tickMs ?? TURN_STALL_TICK_MS
  const now = options.now ?? Date.now
  let idle = 0
  let last = now()
  let stopped = false
  const look = (): void => {
    const at = now()
    const gap = Math.max(0, at - last)
    last = at
    let waiting = false
    try {
      waiting = options.waiting()
    } catch {
      waiting = false
    }
    idle = waiting ? 0 : idle + Math.min(gap, tickMs * 2)
    if (idle < stallMs) return
    stop()
    options.onStall(idle)
  }
  const timer = setInterval(look, tickMs)
  timer.unref?.()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
  return {
    progress: () => {
      idle = 0
      last = now()
    },
    stop
  }
}
