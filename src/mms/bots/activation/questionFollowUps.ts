/**
 * When a question's nudge may happen (issue #1123): a bot's nudges, all its questions together, at most one an hour and
 * three in any 24 hours (one beyond that moves to the next free time). Pure: the engine passes the time and the bot's
 * nudges so far.
 */
import { MAX_NUDGES_PER_DAY, NUDGE_SPACING_MS } from '../../../shared/bots/personal/questions'

const DAY_MS = 24 * 60 * 60_000

/**
 * The first time from `at` a bot may post a nudge: an hour after its last one, once fewer than three fall in the 24 hours
 * before. `nudges`: when the bot's earlier nudges were posted. One posted "later" than `at` (the clock was set back
 * since) counts as just posted, in both budgets: a clock change never frees a slot.
 */
export function nudgeSlot(at: number, nudges: readonly number[]): number {
  let slot = at
  // Each rule can only move it later, so this settles in a few rounds.
  for (let round = 0; round < 8; round += 1) {
    const before = slot
    const close = nudges.filter((time) => time > slot - NUDGE_SPACING_MS)
    if (close.length) slot = Math.max(...close) + NUDGE_SPACING_MS
    const day = nudges.filter((time) => time > slot - DAY_MS).sort((a, b) => a - b)
    if (day.length >= MAX_NUDGES_PER_DAY) slot = day[day.length - MAX_NUDGES_PER_DAY]! + DAY_MS
    if (slot === before) break
  }
  return slot
}

/** A held action follows up on the question path, without inventing a question row. */
export interface ActionNudgeFollowUp {
  id: string
  actionId: string
  botId: string
  activationId: string
  messageId: string
  count: number
  at: number
}
export function actionNudgeId(messageId: string): string | undefined {
  return /^bm_(action_[a-zA-Z0-9-]+)_n[12]$/.exec(messageId)?.[1]
}
