/**
 * The split between the conversation and the panel area on its right. The panel area keeps a width in
 * pixels and the conversation takes the rest. The divider's bounds are the conversation's long-standing
 * ones: at least 280px wide (`.sidebar { min-width }` in app.css) and at most 60% of the workspace.
 */

/** The panel area's width before the user drags the divider. */
export const DEFAULT_MAIN_AREA_WIDTH = 440
/** Keep in sync with `.sidebar { min-width }` in app.css. */
export const MIN_CONVERSATION_WIDTH = 280
/** The conversation's largest share of the workspace (the row plus the threads sidebar beside it). */
export const MAX_CONVERSATION_SHARE = 0.6

/** The conversation plus the panel area (`width`), the panel area's right edge, and the whole workspace. */
export type ConversationRow = { width: number; right: number; workspaceWidth: number }

/** A saved width, or null to use the default. Anything that is not a positive finite number is dropped. */
export function savedMainAreaWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** The panel area's bounds: whatever leaves the conversation between its minimum and its maximum share. */
export function mainAreaWidthBounds(row: Pick<ConversationRow, 'width' | 'workspaceWidth'>): { min: number; max: number } {
  const conversationMax = row.workspaceWidth * MAX_CONVERSATION_SHARE
  const conversationMin = Math.min(MIN_CONVERSATION_WIDTH, conversationMax)
  return { min: Math.max(0, row.width - conversationMax), max: Math.max(0, row.width - conversationMin) }
}

/** The panel area's width while the divider is dragged to `clientX`: from the pointer to the row's right edge. */
export function mainAreaWidthAtPointer(clientX: number, row: ConversationRow): number {
  const { min, max } = mainAreaWidthBounds(row)
  return Math.round(Math.min(max, Math.max(min, row.right - clientX)))
}

/**
 * The panel area's CSS width and minimum. A saved width wider than the window cannot overflow it: the
 * conversation keeps its 280px minimum and the panel area shrinks (flex). The minimum stops the
 * conversation going past its 60% share. `100%` is the workspace, which also holds the threads
 * sidebar and the dividers (`besideWidth` pixels).
 */
export function mainAreaStyle(width: number | null, besideWidth: number): { width: string; minWidth: string } {
  const beside = Math.max(0, Math.round(besideWidth))
  return {
    width: `${width ?? DEFAULT_MAIN_AREA_WIDTH}px`,
    minWidth: `max(0px, 100% - ${beside}px - ${MAX_CONVERSATION_SHARE * 100}%)`
  }
}
