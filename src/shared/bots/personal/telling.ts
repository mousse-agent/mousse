/**
 * A message past the bot's read mark that asked to be told now or soon and still wants the owner, as the bots feed
 * carries it to another device (`BotFeedTelling.attention`): enough to tell it there and to take it back.
 */
export interface BotAttention {
  id: string
  seq: number
  tell: 'now' | 'soon'
}

/** Optional, negotiated independently of the bot chat API. */
export const BOT_TELLING_CAPABILITY = 'bots.telling.v1'
export interface BotTelling {
  /** Stable across updates of one banner. */
  id: string
  rows: Array<{ botId: string; messageId: string; seq: number; tell: 'now' | 'soon' | 'later' }>
  title: string
  body: string
  kind: 'question' | 'completed'
  sound: boolean
}
