import { useEffect, useRef, useState } from 'react'
import { Globe, Plus, X } from '../../lib/icons'
import type { ChatSummary } from '../../../shared/chats'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { useChatsStore } from '../../stores/chatsStore'
import { botFaceState, useBotsPolling, useBotsStore } from '../../stores/botsStore'
import { BotFace } from '../bots/face/BotFace'
import { OpenNetworkChatDialog } from './OpenNetworkChatDialog'
import '../../styles/chats.css'
import '../../styles/bots.css'

export function ChatAvatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const color = [...name].reduce((value, char) => value + char.charCodeAt(0), 0) % 5
  return <span className={`chat-avatar chat-color-${color}${small ? ' small' : ''}${group ? ' group' : ''}`} aria-hidden="true">{group ? '#' : name.slice(0, 1).toUpperCase()}</span>
}
export function ChatsSidebar() {
  const snapshot = useChatsStore((s) => s.snapshot)
  const activeId = useChatsStore((s) => s.activeChatId)
  const openChat = useChatsStore((s) => s.openChat)
  const activeBotId = useChatsStore((s) => s.activeBotId)
  const openBot = useChatsStore((s) => s.openBot)
  const bots = useBotsStore((s) => s.bots)
  const happy = useBotsStore((s) => s.happy)
  const searchOpen = useChatsStore((s) => s.searchOpen)
  const search = useChatsStore((s) => s.search)
  const input = useRef<HTMLInputElement>(null)
  const [networkOpen, setNetworkOpen] = useState(false)
  // The sidebar lists the bots itself: after a restart it shows without the chat pane.
  useBotsPolling()
  useEffect(() => { if (searchOpen) input.current?.focus() }, [searchOpen])
  const matches = (name: string) => name.toLowerCase().includes(search.toLowerCase())
  const newBot = () => useBotsStore.setState({ newBotOpen: true, error: null })
  const row = (chat: ChatSummary) => <button type="button" key={chat.id} className={`chat-list-row${chat.id === activeId ? ' active' : ''}`} onClick={() => void openChat(chat.id)}>
    <ChatAvatar name={chat.name} group={chat.kind === 'group'} />
    <span className="chat-list-text"><span className="chat-list-name">{chat.name}</span><span className="chat-list-preview">{chat.presentation === 'network' ? 'Space conversation' : chat.run?.state === 'running' ? 'Working…' : chat.lastMessage?.text || `${chat.participants.filter((p) => p.kind === 'agent').length} agent${chat.kind === 'group' ? 's' : ''}`}</span></span>
    {chat.run?.state === 'running' && <span className="chat-working-dot" aria-label="Working" />}
  </button>
  // A bot's row says its state in words; its face holds the state's pose (the Bots row above moves).
  const botRow = (bot: BotSummary) => <button type="button" key={`bot:${bot.id}`} className={`chat-list-row${bot.id === activeBotId ? ' active' : ''}`} onClick={() => void openBot(bot.id)}>
    <BotFace look={bot.look} state={botFaceState(bot, happy[bot.id])} size={40} view="head" still />
    <span className="chat-list-text"><span className="chat-list-name">{bot.name}</span><span className="chat-list-preview">{bot.stateText || bot.last?.text || bot.description}</span></span>
    {bot.unread > 0 && <span className="bot-unread" aria-label={`${bot.unread} unread`}>{bot.unread}</span>}
  </button>
  const groups = snapshot.chats.filter((chat) => chat.kind === 'group' && matches(chat.name))
  const shownBots = bots.filter((bot) => matches(bot.name))
  // Recent: bot chats and direct chats together, the latest first.
  const recent = [
    ...snapshot.chats.filter((chat) => chat.kind === 'direct' && matches(chat.name)).map((chat) => ({ at: chat.lastMessage?.createdAt ?? chat.updatedAt, row: () => row(chat) })),
    ...shownBots.map((bot) => ({ at: bot.last?.at ?? bot.createdAt, row: () => botRow(bot) }))
  ].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  return <div className="chats-sidebar-content">
    {searchOpen && <div className="chat-search"><input ref={input} aria-label="Search chats" placeholder="Search chats" value={search} onChange={(event) => useChatsStore.setState({ search: event.target.value })} /><button aria-label="Close chat search" onClick={() => useChatsStore.setState({ searchOpen: false, search: '' })}><X size={14} /></button></div>}
    <section aria-label="Bots"><div className="chat-section-heading"><h2>Bots</h2><button aria-label="New bot" title="New bot" onClick={newBot}><Plus size={15} /></button></div>
      {bots.length
        ? <div className="chat-roster bot-roster">{shownBots.map((bot) => <button key={bot.id} type="button" className={bot.id === activeBotId ? 'bot-roster-active' : ''} title={bot.stateText && bot.state !== 'idle' ? `${bot.name}: ${bot.stateText}` : bot.name} aria-label={`Message ${bot.name}`} onClick={() => void openBot(bot.id)}>
          <BotFace look={bot.look} state={botFaceState(bot, happy[bot.id])} size={48} view="head" /><span>{bot.name}</span>
        </button>)}</div>
        : <p className="chat-empty-hint">No bots yet. Press + to make one.</p>}
    </section>
    <section aria-label="Groups"><div className="chat-section-heading"><h2>Groups</h2><span className="chat-section-actions"><button aria-label="Open a Space" title="Open a Space" onClick={() => setNetworkOpen(true)}><Globe size={15} /></button>{!!snapshot.agents.length && <button aria-label="New group" title="New group" onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'group' })}><Plus size={15} /></button>}</span></div>{groups.map(row)}{!groups.length && <p className="chat-empty-hint">No groups</p>}</section>
    {!!recent.length && <section className="chat-recent-section" aria-label="Recent chats"><div className="chat-section-heading"><h2>Recent</h2></div>{recent.map((entry) => entry.row())}</section>}
    {networkOpen && <OpenNetworkChatDialog onClose={() => setNetworkOpen(false)} />}
  </div>
}
