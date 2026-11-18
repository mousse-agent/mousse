import type { CSSProperties } from 'react'
import { ChevronLeft } from '../../lib/icons'
import { closeBotThread } from '../../lib/botThread'
import { BOT_COLOUR_HEX, normalizeBotLook } from '../../../shared/bots/personal/look'
import { useAppStore } from '../../stores/appStore'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { launchedLook } from './botChatShape'
import { BotActivitySticker } from './BotPresence'
import { BotFace } from './face/BotFace'
import '../../styles/chats.css'
import '../../styles/bots.css'

/**
 * Above a bot's thread opened in the bot's chat pane: back to the bot's chat, the bot's face, "alpha / thread title", and
 * under it the thread's project and where it stands ("mousse · working"). The bot's name also leads back.
 */
export function BotThreadHeader({ botId, threadId }: { botId: string; threadId: string }) {
  const bot = useBotsStore((s) => s.bots.find((entry) => entry.id === botId))
  const happy = useBotsStore((s) => s.happy[botId])
  const listed = useAppStore((s) => s.threads.find((entry) => entry.id === threadId)?.name)
  if (!bot) return null
  const launched = bot.threads?.find((entry) => entry.threadId === threadId)
  const title = listed?.trim() || launched?.title || 'Untitled thread'
  const meta = [launched?.project, launched ? launchedLook(launched.status).label : undefined].filter(Boolean).join(' · ')
  const typing = Boolean(bot.chat) && !bot.chat?.offline
  return <header className="chat-conversation-header bot-thread-header" style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
    <button type="button" className="icon-btn bot-thread-back" aria-label={`Back to ${bot.name}'s chat`} title={`Back to ${bot.name}`} onClick={closeBotThread}>
      <ChevronLeft size={16} aria-hidden />
    </button>
    <span className="bot-header-about">
      <BotFace look={bot.look} state={botFaceState(bot, happy)} size={32} view="head" />
      <BotActivitySticker bot={bot} typing={typing} offline={Boolean(bot.chat?.offline)} />
    </span>
    <div className="bot-header-who">
      <h1 className="bot-thread-crumbs">
        <button type="button" className="bot-thread-crumb-bot" tabIndex={-1} onClick={closeBotThread}>{bot.name}</button>
        <span className="bot-thread-crumb-sep" aria-hidden>/</span>
        <span className="bot-thread-crumb-title" title={title}>{title}</span>
      </h1>
      {meta && <span className="bot-presence">{meta}</span>}
    </div>
  </header>
}
