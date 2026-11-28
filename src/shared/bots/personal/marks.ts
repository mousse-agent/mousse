/**
 * What this computer marks on a bot in its Bots list, for this computer's own bots and the other computers' alike:
 * pinned (kept at the top), hidden (off the list until Show hidden), muted (no notifications here) and marked unread (a
 * dot until its chat is opened here). Kept on the computer that set them (`bot-marks.json` in the profile), keyed by bot
 * ref: a plain id is this computer's bot, `<node>:<botId>` another computer's. They never reach the bot's computer, and
 * never change how far the owner has read there (`bots.chat.markRead`).
 */
export interface BotMarks {
  /** When it was pinned. */
  pinnedAt?: string
  hidden?: true
  muted?: true
  unread?: true
}

export type BotMark = 'pinned' | 'hidden' | 'muted' | 'unread'
export const BOT_MARK_KINDS: readonly BotMark[] = ['pinned', 'hidden', 'muted', 'unread']

/** Marks by bot ref; a bot with none has no entry. */
export type BotMarksByRef = Record<string, BotMarks>

/**
 * The marks methods, served by the window's own computer alone and never offered to another device. An older service
 * lacks them: its window keeps no marks.
 */
export const BOT_MARK_METHODS = ['bots.marks.list', 'bots.marks.set'] as const
export type BotMarkMethod = (typeof BOT_MARK_METHODS)[number]
export interface BotMarksApi {
  'bots.marks.list': { params: Record<string, never>; result: { marks: BotMarksByRef } }
  /** Sets or clears one mark on one bot; every bot's marks as they are now. */
  'bots.marks.set': { params: { botId: string; mark: BotMark; on: boolean }; result: { marks: BotMarksByRef } }
}

/** The marks of one bot with `mark` set or cleared; `at` is the pin's time. */
export function withMark(marks: BotMarks | undefined, mark: BotMark, on: boolean, at: string): BotMarks {
  const next: BotMarks = { ...marks }
  if (mark === 'pinned') {
    if (on) next.pinnedAt = marks?.pinnedAt ?? at
    else delete next.pinnedAt
  } else if (on) next[mark] = true
  else delete next[mark]
  return next
}

/** Whether a bot's marks say nothing, so it needs no entry. */
export const noMarks = (marks: BotMarks): boolean => !marks.pinnedAt && !marks.hidden && !marks.muted && !marks.unread
