import type { QuickAction } from '../../lib/quickActions'

/** How long the done check stays, and how long an error stays, after a run. */
export const DONE_FEEDBACK_MS = 1600
export const ERROR_FEEDBACK_MS = 8000

export type RunFeedback = { id: string; phase: 'running' | 'done' } | { id: string; phase: 'error'; message: string }

export interface RunController {
  /** Run an action for a profile and report its progress; a newer run or `cancel` silences this one. */
  run: (action: QuickAction, profileId: string) => Promise<void>
  /** Drop the pending result and timer. Call when the owner goes away or the profile changes. */
  cancel: () => void
}

interface RunControllerOptions {
  execute: (action: QuickAction, profileId: string) => Promise<unknown>
  onFeedback: (feedback: RunFeedback | null) => void
}

/**
 * Feedback for running actions. Each run gets a generation: once `cancel` or a newer
 * `run` has moved it on, a slow action finishing late reports nothing, so it cannot
 * overwrite the feedback of whatever the section shows now.
 */
export function createRunController({ execute, onFeedback }: RunControllerOptions): RunController {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const cancel = () => {
    generation += 1
    clearTimer()
  }

  const run = async (action: QuickAction, profileId: string) => {
    cancel()
    const mine = generation
    onFeedback({ id: action.id, phase: 'running' })
    let next: RunFeedback
    try {
      await execute(action, profileId)
      next = { id: action.id, phase: 'done' }
    } catch (error) {
      next = { id: action.id, phase: 'error', message: error instanceof Error ? error.message : 'Action failed.' }
    }
    if (mine !== generation) return
    onFeedback(next)
    timer = setTimeout(() => onFeedback(null), next.phase === 'error' ? ERROR_FEEDBACK_MS : DONE_FEEDBACK_MS)
  }

  return { run, cancel }
}
