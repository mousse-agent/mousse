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
