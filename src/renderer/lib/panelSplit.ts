/**
 * The split between the conversation and the panel area on its right. The panel area keeps a width in
 * pixels and the conversation takes the rest. Each pane has a minimum width.
 */

/** The panel area's width before the user drags the divider. */
export const DEFAULT_MAIN_AREA_WIDTH = 440
/** Keep in sync with `.sidebar { min-width }` in app.css. */
export const MIN_CONVERSATION_WIDTH = 280
/** The narrowest panel area when the row can fit both panes' minimums. */
const MIN_MAIN_AREA_WIDTH = 160

/** The conversation plus the panel area (`width`), and the panel area's right edge. */
export type ConversationRow = { width: number; right: number }

/** A saved width, or null to use the default. Anything that is not a positive finite number is dropped. */
export function savedMainAreaWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export function mainAreaWidthBounds(row: Pick<ConversationRow, 'width'>): { min: number; max: number } {
  const max = Math.max(0, row.width - MIN_CONVERSATION_WIDTH)
  return { min: Math.min(MIN_MAIN_AREA_WIDTH, max), max }
}

/** The panel area's width while the divider is dragged to `clientX`: from the pointer to the row's right edge. */
export function mainAreaWidthAtPointer(clientX: number, row: ConversationRow): number {
  const { min, max } = mainAreaWidthBounds(row)
  return Math.round(Math.min(max, Math.max(min, row.right - clientX)))
}

/**
 * The panel area's CSS width and minimum. A saved width wider than the window cannot overflow it: the
 * conversation keeps its 280px minimum and the panel area shrinks (flex). If space is tight, the
 * minimum also shrinks. `100%` is the workspace, which includes the threads sidebar and dividers
 * (`besideWidth` pixels).
 */
export function mainAreaStyle(width: number | null, besideWidth: number): { width: string; minWidth: string } {
  const beside = Math.max(0, Math.round(besideWidth))
  return {
    width: `${width ?? DEFAULT_MAIN_AREA_WIDTH}px`,
    minWidth: `min(${MIN_MAIN_AREA_WIDTH}px, max(0px, 100% - ${beside + MIN_CONVERSATION_WIDTH}px))`
  }
}
