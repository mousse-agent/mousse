/**
 * An error in a window's page that main writes to `<home>/logs/renderer-errors.log`: a component that threw while
 * drawing, an error React reported, or an uncaught error or rejected promise in the page. So a window that went blank
 * leaves a trace.
 */

export const RENDERER_ERROR_CHANNEL = 'diagnostics:rendererError'

/**
 * - `render`: a component threw and the window shows its error line in place of the app.
 * - `caught`: a component threw and a boundary inside the app handled it (a chunk that failed to load, say).
 * - `uncaught`: React found no boundary for it and stopped drawing the window.
 * - `recoverable`: React recovered on its own (a hydration or concurrent-render retry).
 * - `error` / `rejection`: an uncaught error or an unhandled promise rejection outside React.
 */
export type RendererErrorKind = 'render' | 'caught' | 'uncaught' | 'recoverable' | 'error' | 'rejection'

export const RENDERER_ERROR_KINDS: readonly RendererErrorKind[] = ['render', 'caught', 'uncaught', 'recoverable', 'error', 'rejection']

export interface RendererErrorReport {
  kind: RendererErrorKind
  /** The error's class (`TypeError`), or the type of what was thrown when it is not an Error. */
  name: string
  message: string
  stack?: string
  /** The components React was drawing, innermost first. */
  componentStack?: string
  /** For a window error: the script and position it came from. */
  source?: string
  /** What the window showed: its main view, and whether Settings was open. */
  view?: string
  /** Earlier copies of this same error the window did not send, to keep a loop from flooding the log. */
  repeats?: number
}
