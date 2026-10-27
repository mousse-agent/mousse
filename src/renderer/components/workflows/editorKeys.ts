import { TEXT_FIELD_SELECTOR } from '../../commands/commandContext'

/**
 * What the workflow editor still handles itself. Save, duplicate and delete are registry commands
 * (`workflow.save`, `workflow.duplicate`, `workflow.delete`); undo and redo are the Edit-menu chords
 * and the nudges are Shift+arrows, so none of those can be rebound.
 */
export type WorkflowLocalKey =
  | { type: 'undo' }
  | { type: 'redo' }
  /** Backspace as a second key for `workflow.delete`, whose default is Delete. */
  | { type: 'delete' }
  | { type: 'nudge'; dx: number; dy: number }

export interface WorkflowKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  target: unknown
}

const NUDGE_STEP = 16

function inTextField(target: unknown): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest
  return typeof closest === 'function' && Boolean(closest.call(target, TEXT_FIELD_SELECTOR))
}

/** Undo, redo and Backspace-delete leave text fields alone, where the field's own undo and deletion apply. */
export function workflowLocalKey(
  event: WorkflowKeyEvent,
  state: { hasSelection: boolean; canvasView: boolean }
): WorkflowLocalKey | null {
  const key = event.key.toLowerCase()
  const mod = event.ctrlKey || event.metaKey
  if (mod && (key === 'z' || key === 'y') && !inTextField(event.target)) {
    if (key === 'y') return { type: 'redo' }
    return { type: event.shiftKey ? 'redo' : 'undo' }
  }
  if (event.key === 'Backspace' && state.hasSelection && state.canvasView && !inTextField(event.target)) {
    return { type: 'delete' }
  }
  if (event.shiftKey && state.hasSelection && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
    return {
      type: 'nudge',
      dx: key === 'arrowleft' ? -NUDGE_STEP : key === 'arrowright' ? NUDGE_STEP : 0,
      dy: key === 'arrowup' ? -NUDGE_STEP : key === 'arrowdown' ? NUDGE_STEP : 0
    }
  }
  return null
}
