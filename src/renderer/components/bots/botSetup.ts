import type { BotSummary } from '../../../shared/bots/personal/chat'

/**
 * Whether the bot can be set up from this window (About, Rename, Change look, Pause or Resume, Make private, Delete, its
 * models and devices), and when not, why in words (the greyed item's tooltip). This computer's bots always can. A bot
 * of another computer can only while that computer is reached and gives this one Full bot access there; at Use it is
 * only used from here.
 */
export function botSetupBlock(bot: Pick<BotSummary, 'lives'>): string | undefined {
  const lives = bot.lives
  if (!lives) return undefined
  if (lives.offline) return `${lives.name} is offline`
  if (lives.level !== 'full') return `Needs Full bot access on ${lives.name}`
  return undefined
}

/** Make private's tooltip: this computer's bot is kept to it; another computer's to that one and this one. */
export function botWallTitle(home?: string): string {
  return home ? `Only ${home} and this computer reach it. Change it in About.` : 'Only this computer reaches it. Change it in About.'
}
