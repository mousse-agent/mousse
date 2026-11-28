import { useMemo } from 'react'
import { Reply, X } from '../../lib/icons'
import type { BotChatApplet, BotChatMessage } from '../../../shared/bots/personal/chat'
import type { AppletConversation } from '../applets/appletActions'
import { AppletCard } from '../applets/AppletCard'
import { AppletPanelView } from '../applets/AppletPanelView'
import { useAppStore } from '../../stores/appStore'
import { useBotsStore } from '../../stores/botsStore'

/**
 * Applets in a bot's chat: the thread's own card under the bot's message and the thread's own panel beside the chat,
 * run from the bot's thread in the same sandbox as a thread's. What an applet adds to the conversation (its text, or a
 * request to fix it) goes to the bot's composer, never sent by itself.
 */

const conversations = new Map<string, AppletConversation>()

/**
 * Where a bot's applet is read from: this computer's bot's thread, or, for a bot of another computer (`lives`), that
 * computer through the bot by the message that shows it, with its name and whether it is offline.
 */
export type BotAppletSource = { threadId: string } | { messageId: string; computer: string; offline: boolean }

/**
 * The bot's composer as an applet's conversation: one object per bot and place, so a card renders only when it changes.
 * What an applet of another computer's bot adds goes to that bot's own composer here, which sends it to that bot.
 */
export function botAppletConversation(botId: string, source: BotAppletSource): AppletConversation {
  const key = 'threadId' in source ? `${botId}\0${source.threadId}` : `${botId}\0${source.messageId}\0${source.computer}\0${source.offline}`
  let conversation = conversations.get(key)
  if (!conversation) {
    conversation = {
      // A remote bot's applet has no thread here: its key stays with that bot.
      threadId: 'threadId' in source ? source.threadId : `bot:${botId}`,
      addToDraft: (text) => {
        const store = useBotsStore.getState()
        const draft = store.drafts[botId] ?? ''
        store.setDraft(botId, draft ? `${draft}\n\n${text}` : text)
        window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')?.focus())
        return true
      },
      ...('threadId' in source ? {} : { bot: { botId, messageId: source.messageId, computer: source.computer, offline: source.offline } })
    }
    conversations.set(key, conversation)
  }
  return conversation
}

/** Where a message's applet is read from: its thread here, or the bot's computer (`remote`). Null when it has neither. */
function sourceOf(applet: BotChatApplet, messageId: string | undefined, remote: BotAppletRemote | undefined): BotAppletSource | null {
  if (remote) return messageId ? { messageId, computer: remote.computer, offline: remote.offline } : null
  return applet.threadId ? { threadId: applet.threadId } : null
}

/** A bot of another computer: that computer's name and whether it is offline. */
export interface BotAppletRemote { computer: string; offline: boolean }

/**
 * A reply's applets, each with its name (which opens it beside the chat) above its content, and Reply beside the name.
 * The applet's content is a separate view over the page, so the pointer on it never shows the tools beside the bubble;
 * Reply here stays visible and replies to the whole message.
 */
export function BotMessageApplets({ botId, applets, onOpen, message, onReply, remote }: { botId: string; applets: readonly BotChatApplet[]; onOpen(applet: BotOpenApplet): void; message?: BotChatMessage; onReply?(message: BotChatMessage): void; remote?: BotAppletRemote }) {
  return <div className="bot-message-applets">
    {applets.map((applet) => {
      const source = sourceOf(applet, message?.id, remote)
      if (!source) return null
      return <div key={`${applet.threadId ?? ''}:${applet.reference.appletId}:${applet.reference.revisionId}`} className="bot-message-applet">
        <AppletCard reference={applet.reference} conversation={botAppletConversation(botId, source)} onOpen={() => onOpen({ ...applet, ...(message ? { messageId: message.id } : {}) })} />
        {message && onReply && <button type="button" className="bot-applet-reply" aria-label={`Reply to ${applet.reference.title}`} title="Reply"
          onClick={() => onReply(message)}><Reply size={14} aria-hidden /></button>}
      </div>
    })}
  </div>
}

/** An applet opened beside the chat: the message it is on, which a bot of another computer's applet is read by. */
export type BotOpenApplet = BotChatApplet & { messageId?: string }

/** One applet beside the bot's chat, filling the pane, with the panel's Restart, Source and exports, and Close. */
export function BotAppletPane({ botId, applet, onClose, remote }: { botId: string; applet: BotOpenApplet; onClose(): void; remote?: BotAppletRemote }) {
  const profileId = useAppStore((s) => s.profileId)
  const { reference } = applet
  const source = sourceOf(applet, applet.messageId, remote)
  const conversation = source ? botAppletConversation(botId, source) : null
  const threadId = conversation?.threadId ?? ''
  const tab = useMemo(() => ({ id: `bot-applet:${threadId}:${applet.messageId ?? ''}:${reference.revisionId}`, title: reference.title, markdown: '', applet: { threadId, profileId, reference } }), [threadId, applet.messageId, profileId, reference])
  if (!conversation) return null
  return <aside className="bot-applet-pane" aria-label={`Applet: ${reference.title}`}>
    <AppletPanelView key={tab.id} tab={tab} conversation={conversation}
      tabs={<div className="bot-applet-pane-title">
        <span title={reference.description || undefined}>{reference.title}</span>
        <button type="button" aria-label="Close" title="Close" onClick={onClose}><X size={14} aria-hidden /></button>
      </div>} />
  </aside>
}
