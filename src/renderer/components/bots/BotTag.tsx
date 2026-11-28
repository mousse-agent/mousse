import { Children, isValidElement, type CSSProperties, type ReactNode } from 'react'
import { BOT_COLOUR_HEX, normalizeBotLook } from '../../../shared/bots/personal/look'
import { useBotsStore } from '../../stores/botsStore'
import { useChatsStore } from '../../stores/chatsStore'
import { BotFace } from './face/BotFace'
import '../../styles/botTag.css'

/** A link's words as plain text, without the tag's `@`. */
function tagText(children: ReactNode): string {
  const flat = (node: ReactNode): string => Children.toArray(node).map((child) => (typeof child === 'string' || typeof child === 'number'
    ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? flat(child.props.children) : '')).join('')
  return flat(children).trim().replace(/^@/, '')
}

/**
 * One of the owner's bots tagged in a message (`[@Coxy](mousse://bot/<id>)`, `shared/botLink.ts`): its face and its
 * name as the owner's bots are called now, tinted its colour; a press opens its chat. A bot that is gone keeps the
 * name the tag was written with, as quiet text.
 */
export function BotTag({ botId, children }: { botId: string; children?: ReactNode }) {
  const bot = useBotsStore((s) => s.bots.find((entry) => entry.id === botId))
  const name = bot?.name ?? (tagText(children) || 'bot')
  if (!bot) return <span className="bot-tag is-gone">@{name}</span>
  return <button type="button" className="bot-tag" title={`Open ${name}'s chat`} onClick={() => void useChatsStore.getState().openBot(botId)}
    style={{ '--tag-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
    <span className="bot-tag-face" aria-hidden><BotFace look={bot.look} state="idle" size={16} view="head" still /></span>
    <span className="bot-tag-name">{name}</span>
  </button>
}
