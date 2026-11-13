import { useMemo } from 'react'
import { X } from '../../lib/icons'
import type { BotChatApplet } from '../../../shared/bots/personal/chat'
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

/** The bot's composer as an applet's conversation: one object per bot and thread, so a card renders only when it changes. */
export function botAppletConversation(botId: string, threadId: string): AppletConversation {
  const key = `${botId}\0${threadId}`
  let conversation = conversations.get(key)
  if (!conversation) {
    conversation = {
      threadId,
      addToDraft: (text) => {
        const store = useBotsStore.getState()
        const draft = store.drafts[botId] ?? ''
        store.setDraft(botId, draft ? `${draft}\n\n${text}` : text)
        window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')?.focus())
        return true
      }
    }
    conversations.set(key, conversation)
  }
  return conversation
}

/** A reply's applets, each with its name (which opens it beside the chat) above its content. */
export function BotMessageApplets({ botId, applets, onOpen }: { botId: string; applets: readonly BotChatApplet[]; onOpen(applet: BotChatApplet): void }) {
  return <div className="bot-message-applets">
    {applets.map((applet) => <AppletCard key={`${applet.threadId}:${applet.reference.revisionId}`} reference={applet.reference}
      conversation={botAppletConversation(botId, applet.threadId)} onOpen={() => onOpen(applet)} />)}
  </div>
}

/** One applet beside the bot's chat, filling the pane, with the panel's Restart, Source and exports, and Close. */
export function BotAppletPane({ botId, applet, onClose }: { botId: string; applet: BotChatApplet; onClose(): void }) {
  const profileId = useAppStore((s) => s.profileId)
  const { threadId, reference } = applet
  const tab = useMemo(() => ({ id: `bot-applet:${threadId}:${reference.revisionId}`, title: reference.title, markdown: '', applet: { threadId, profileId, reference } }), [threadId, profileId, reference])
  return <aside className="bot-applet-pane" aria-label={`Applet: ${reference.title}`}>
    <AppletPanelView key={tab.id} tab={tab} conversation={botAppletConversation(botId, threadId)}
      tabs={<div className="bot-applet-pane-title">
        <span title={reference.description || undefined}>{reference.title}</span>
        <button type="button" aria-label="Close" title="Close" onClick={onClose}><X size={14} aria-hidden /></button>
      </div>} />
  </aside>
}
