import type { QuickAction } from '../../lib/quickActions'

/** How long the done check stays, and how long an error stays, after a run. */
export const DONE_FEEDBACK_MS = 1600
export const ERROR_FEEDBACK_MS = 8000

export type RunFeedback = { id: string; phase: 'running' | 'done' } | { id: string; phase: 'error'; message: string }

export interface RunController {
  /**
   * Run an action for a profile and report its progress. Does nothing while a run is
   * still in flight; `cancel` silences a run that has already started.
   */
  run: (action: QuickAction, profileId: string) => Promise<void>
  /** True from the start of a run until the action itself settles, even after `cancel`. */
  isRunning: () => boolean
  /** Drop the pending result and timer, and report no feedback. Call when the profile changes. */
  cancel: () => void
}

interface RunControllerOptions {
  execute: (action: QuickAction, profileId: string) => Promise<unknown>
  onFeedback: (feedback: RunFeedback | null) => void
}

/**
 * Feedback for running actions, one controller per profile. Each run gets a generation:
 * once `cancel` has moved it on, a slow action finishing late reports nothing. A run in
 * flight blocks the next one, so an action cannot start twice while it is still polling.
 */
export function createRunController({ execute, onFeedback }: RunControllerOptions): RunController {
  let generation = 0
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const cancel = () => {
    generation += 1
    clearTimer()
    onFeedback(null)
  }

  const run = async (action: QuickAction, profileId: string) => {
    if (inFlight) return
    inFlight = true
    generation += 1
    clearTimer()
    const mine = generation
    onFeedback({ id: action.id, phase: 'running' })
    let next: RunFeedback
    try {
      await execute(action, profileId)
      next = { id: action.id, phase: 'done' }
    } catch (error) {
      next = { id: action.id, phase: 'error', message: error instanceof Error ? error.message : 'Action failed.' }
    } finally {
      inFlight = false
    }
    if (mine !== generation) return
    onFeedback(next)
    timer = setTimeout(() => onFeedback(null), next.phase === 'error' ? ERROR_FEEDBACK_MS : DONE_FEEDBACK_MS)
  }

  return { run, cancel, isRunning: () => inFlight }
}

/** Marks the control that keeps the section's place in the tab order, for focus to return to. */
export const ACTIONS_FOCUS_ANCHOR = 'data-side-card-actions-anchor'

/**
 * Put focus back in the Actions section once the editor closes, if it has landed nowhere.
 * Deleting an action removes the control that opened the editor, and opening the app panel
 * can unmount the whole card, so the dialog's own restore finds nothing to focus.
 */
export function refocusActionsSection(doc: Document): void {
  const active = doc.activeElement
  if (active && active !== doc.body && active.isConnected) return
  doc.querySelector<HTMLElement>(`[${ACTIONS_FOCUS_ANCHOR}]`)?.focus({ preventScroll: true })
}
