import { showToast } from '../components/ui/Toast'
import { isSessionClosing, readableError } from './errorText'

/** The toast line for a failed action: "Could not archive · <the error's first line>". */
export function failureLine(verb: string, error: unknown): string {
  return `Could not ${verb} · ${readableError(error, 'Something went wrong')}`
}

/**
 * Runs an action the person started and shows its failure as a toast, never only in the console.
 * `retry` adds a Retry button; pass it only when running the action again is safe (pin, archive,
 * rename). Resolves to whether the action went through. A window that is closing shows nothing.
 */
export async function runWithToast(verb: string, run: () => Promise<unknown>, options: { retry?: boolean } = {}): Promise<boolean> {
  try {
    await run()
    return true
  } catch (error) {
    if (isSessionClosing(error)) return false
    showToast({
      message: failureLine(verb, error),
      tone: 'error',
      ...(options.retry ? { action: { label: 'Retry', run: () => void runWithToast(verb, run, options) } } : {})
    })
    return false
  }
}

/** Shows a toast for something done, with Undo. A failed undo shows its own toast with Retry. */
export function showUndoToast(message: string, undoVerb: string, undo: () => Promise<unknown>): void {
  showToast({ message, action: { label: 'Undo', run: () => void runWithToast(undoVerb, undo, { retry: true }) } })
}
