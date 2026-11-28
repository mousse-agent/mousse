import type { BotSummary } from '../../shared/bots/personal/chat'
import type { BotMarks, BotMarksByRef } from '../../shared/bots/personal/marks'
import { botRowLine } from '../components/bots/botChatShape'

/**
 * The Bots list's order and filter (#2030): this computer's bots and the other computers' in one list, pinned first,
 * then by latest activity; the filter narrows it by computer and by state, leaves out offline bots on request, and
 * brings hidden bots back. Pure: the sidebar and the tests read the same rules.
 */

/** Which bots by state: every one, those that need the owner, those that work now. */
export type BotStateFilter = 'all' | 'needs' | 'working'

export interface BotListFilter {
  /** `all`, `here` (this computer's bots), or a computer by node. */
  computer: string
  state: BotStateFilter
  hideOffline: boolean
  showHidden: boolean
}

export const DEFAULT_BOT_FILTER: BotListFilter = Object.freeze({ computer: 'all', state: 'all', hideOffline: false, showHidden: false })

export const BOT_STATE_LABELS: Record<BotStateFilter, string> = { all: 'All bots', needs: 'Needs me', working: 'Working' }

/** The latest a bot said or was told, else when it was made: the list's order and its time. */
export const botActivityAt = (bot: BotSummary): string => bot.last?.at ?? bot.createdAt

const NO_MARKS: BotMarks = Object.freeze({})
export const marksOf = (marks: BotMarksByRef, botId: string): BotMarks => marks[botId] ?? NO_MARKS

/**
 * Pinned bots first, then the others; in each, the bot that spoke last first. Only a message moves a row: a reply being
 * written never does, and rows with the same time keep their places whichever list brings them first.
 */
export function orderBots(bots: readonly BotSummary[], marks: BotMarksByRef): BotSummary[] {
  const pinned = (bot: BotSummary) => (marksOf(marks, bot.id).pinnedAt ? 0 : 1)
  return [...bots].sort((a, b) => pinned(a) - pinned(b) || botActivityAt(b).localeCompare(botActivityAt(a)) || a.id.localeCompare(b.id))
}

/** Whether the bot's computer can't be reached now. */
export const botAway = (bot: BotSummary): boolean => Boolean(bot.lives?.offline)

/** What the row says the bot does, as the state filter reads it: a bot whose computer is offline says nothing more. */
function stateOf(bot: BotSummary): BotStateFilter {
  if (botAway(bot)) return 'all'
  const tone = botRowLine(bot).tone
  return tone === 'needs' ? 'needs' : tone === 'working' ? 'working' : 'all'
}

/** The other computers the listed bots live on, by name. */
export function botComputers(bots: readonly BotSummary[]): Array<{ node: string; name: string }> {
  const byNode = new Map<string, string>()
  for (const bot of bots) if (bot.lives && !byNode.has(bot.lives.node)) byNode.set(bot.lives.node, bot.lives.name)
  return [...byNode].map(([node, name]) => ({ node, name })).sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node))
}

/**
 * The filter as it applies to these bots: with no other computer's bot listed, the computer and Hide offline narrow
 * nothing (the menu does not offer them then); a computer none of them lives on any more (it left the owner's
 * computers, or this one lost its bots) narrows nothing either.
 */
export function effectiveBotFilter(filter: BotListFilter, bots: readonly BotSummary[]): BotListFilter {
  if (!bots.some((bot) => bot.lives)) return filter.computer === 'all' && !filter.hideOffline ? filter : { ...filter, computer: 'all', hideOffline: false }
  if (filter.computer === 'all' || filter.computer === 'here' || bots.some((bot) => bot.lives?.node === filter.computer)) return filter
  return { ...filter, computer: 'all' }
}

/** Whether the filter narrows the list (or brings hidden bots back): the dot on its button. */
export const botFilterOn = (filter: BotListFilter): boolean =>
  filter.computer !== 'all' || filter.state !== 'all' || filter.hideOffline || filter.showHidden

/** The listed bots that are hidden: "Show hidden (n)". */
export const hiddenBotCount = (bots: readonly BotSummary[], marks: BotMarksByRef): number =>
  bots.filter((bot) => marksOf(marks, bot.id).hidden).length

/** The bots the list shows, in its order: every axis of the filter at once. */
export function shownBots(bots: readonly BotSummary[], marks: BotMarksByRef, given: BotListFilter): BotSummary[] {
  const filter = effectiveBotFilter(given, bots)
  return orderBots(bots, marks).filter((bot) => {
    if (marksOf(marks, bot.id).hidden && !filter.showHidden) return false
    if (filter.computer === 'here' && bot.lives) return false
    if (filter.computer !== 'all' && filter.computer !== 'here' && bot.lives?.node !== filter.computer) return false
    if (filter.hideOffline && botAway(bot)) return false
    if (filter.state !== 'all' && stateOf(bot) !== filter.state) return false
    return true
  })
}
