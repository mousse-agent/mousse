export interface XtermDimensions {
  cols: number
  rows: number
}

interface TerminalLayoutHost {
  readonly isConnected: boolean
  getBoundingClientRect(): Pick<DOMRect, 'width' | 'height'>
  getClientRects(): { readonly length: number }
}

interface TerminalViewport {
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly viewportY: number
    }
  }
  scrollToBottom(): void
}

interface TerminalFitAddon {
  fit(): void
  proposeDimensions(): XtermDimensions | undefined
}

/**
 * `FitAddon` clamps a zero-sized parent to 2x1. Those dimensions are valid to
 * xterm, but resizing a terminal to them while a keep-mounted pane is hidden
 * causes an unnecessary reflow and can trim a busy terminal's scrollback.
 */
export function hasUsableTerminalLayout(host: TerminalLayoutHost): boolean {
  if (!host.isConnected || host.getClientRects().length === 0) return false
  const { width, height } = host.getBoundingClientRect()
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
}

export function isUsableTerminalDimensions(
  dimensions: XtermDimensions | undefined
): dimensions is XtermDimensions {
  return !!dimensions
    && Number.isInteger(dimensions.cols)
    && Number.isInteger(dimensions.rows)
    && dimensions.cols >= 2
    && dimensions.rows >= 1
}

/**
 * Fits only terminals that currently participate in layout. xterm already
 * keeps a user-scrolled viewport stable through reflow, so only reaffirm the
 * follow-at-bottom state; never force a scrolled-up user back to the bottom.
 *
 * Returns the dimensions that can safely be forwarded to the backing PTY.
 */
export function fitVisibleTerminal(
  host: TerminalLayoutHost,
  terminal: TerminalViewport,
  fitAddon: TerminalFitAddon
): XtermDimensions | undefined {
  if (!hasUsableTerminalLayout(host)) return undefined

  const dimensions = fitAddon.proposeDimensions()
  if (!isUsableTerminalDimensions(dimensions)) return undefined

  const wasAtBottom = terminal.buffer.active.viewportY === terminal.buffer.active.baseY
  fitAddon.fit()

  if (wasAtBottom) terminal.scrollToBottom()
  return dimensions
}

export function dimensionsChanged(
  previous: XtermDimensions | undefined,
  next: XtermDimensions
): boolean {
  return !previous || previous.cols !== next.cols || previous.rows !== next.rows
}
