/**
 * A tag of one of the owner's bots in a message: `[@Name](mousse://bot/<botId>)`. The owner picks the bot from the
 * composer's `@` list, which leaves its chip; the message carries the tag, so the bot it goes to reads exactly which of
 * the owner's bots they mean (by the name `bot_list` and `bot_send` use), and the chat draws it as that bot's face and
 * name, which opens its chat. Browser-safe.
 */
export const BOT_LINK_PREFIX = 'mousse://bot/'

/** What a bot id may hold: letters, digits, `-` and `_`. */
const BOT_ID = /^[A-Za-z0-9_-]{1,200}$/

/** The link to bot `botId`. */
export function botLink(botId: string): string {
  return `${BOT_LINK_PREFIX}${botId}`
}

/** The bot a `mousse://bot/<id>` link names, else null. */
export function parseBotLink(href: string): string | null {
  const value = href.trim()
  if (value.slice(0, BOT_LINK_PREFIX.length).toLowerCase() !== BOT_LINK_PREFIX) return null
  const id = value.slice(BOT_LINK_PREFIX.length).replace(/\/$/, '')
  return BOT_ID.test(id) ? id : null
}

/**
 * A name as a tag's text holds it: one line, with nothing that would end the link's text early. Brackets and
 * backslashes are all that can: parentheses stay, so the name is still the one `bot_send` takes.
 */
export function botTagName(name: string): string {
  return name.replace(/[\[\]\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'bot'
}

/** The tag of bot `botId`, called `name`: `[@Name](mousse://bot/<botId>)`. */
export function botTag(botId: string, name: string): string {
  return `[@${botTagName(name)}](${botLink(botId)})`
}

/** Every bot tag in `text`, in order: where it is, the bot, and the name it was written with. */
export const BOT_TAG = /\[@([^\]\n]{1,60})\]\(mousse:\/\/bot\/([A-Za-z0-9_-]{1,200})\/?\)/g
