import type { BotChatRow } from './botChatShape'

/**
 * A long bot chat draws only its newest rows: about 60, a few thousand elements, where a chat of 600 rows drew about
 * 19,000 and was drawn whole each time the Chats tab opened. Scrolled to the top of what is drawn, the next rows
 * above join it; back at the end, it is cut to the newest rows again.
 */
export const BOT_CHAT_WINDOW = 60
/** How many rows join the window each time the reader reaches its top. */
export const BOT_CHAT_WINDOW_STEP = 40

/** A row's React key: the message's id, or the quiet line's own. */
export const rowKey = (row: BotChatRow): string => (row.kind === 'system' ? row.id : row.message.id)

/** Whether `row` is the row a `data-message-id` of `id` is on: the message's, or the quiet line standing in for it. */
const rowIs = (row: BotChatRow, id: string) => rowKey(row) === id || (row.kind === 'system' && row.of === id)

/** The index of the row `id` is on; -1 when it is not among `rows`. */
export const rowIndex = (rows: readonly BotChatRow[], id: string): number => rows.findIndex((row) => rowIs(row, id))

/**
 * The first row drawn. `from`: the row the reader's window starts at (held while they read away from the end);
 * without it, or once it is gone (a cleared chat), the newest `BOT_CHAT_WINDOW` rows.
 */
export function windowStart(rows: readonly BotChatRow[], from: string | undefined): number {
  const held = from === undefined ? -1 : rowIndex(rows, from)
  return held >= 0 ? held : Math.max(0, rows.length - BOT_CHAT_WINDOW)
}
