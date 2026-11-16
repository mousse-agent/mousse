import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Globe, Plus, X } from '../../lib/icons'
import type { ChatSummary } from '../../../shared/chats'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { useAppStore } from '../../stores/appStore'
import { useChatsStore } from '../../stores/chatsStore'
import { botFaceState, useBotsPolling, useBotsStore } from '../../stores/botsStore'
import { BotFace } from '../bots/face/BotFace'
import { botRowLine } from '../bots/botChatShape'
import { formatMessageTime } from '../../chat/components/agent-elements/utils/message-time'
import { Collapse } from '../ui/Collapse'
import { OpenNetworkChatDialog } from './OpenNetworkChatDialog'
import '../../styles/chats.css'
import '../../styles/bots.css'

export function ChatAvatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const color = [...name].reduce((value, char) => value + char.charCodeAt(0), 0) % 5
  return <span className={`chat-avatar chat-color-${color}${small ? ' small' : ''}${group ? ' group' : ''}`} aria-hidden="true">{group ? '#' : name.slice(0, 1).toUpperCase()}</span>
}
/**
 * A sidebar section's heading. Its title folds the section; each section remembers its choice for the profile, and all
 * start open. While a search runs, every section shows its matches.
 */
function useSectionOpen(key: string, searching: boolean): [boolean, () => void] {
  const collapsed = useAppStore((s) => s.chatsSidebarCollapsed[key] === true)
  return [!collapsed || searching, () => useAppStore.getState().setChatsSidebarSectionCollapsed(key, !collapsed)]
}

function SectionHeading({ title, open, onToggle, children }: { title: string; open: boolean; onToggle(): void; children?: ReactNode }) {
  return <div className="chat-section-heading">
    <h2><button type="button" className="chat-section-toggle" aria-expanded={open} onClick={onToggle}>{title}<ChevronRight size={12} strokeWidth={2} className="chat-section-chevron" aria-hidden /></button></h2>
    {children}
  </div>
}

/** The latest a bot said or was told, else when it was made: the Bots list's order and its time. */
const botActivityAt = (bot: BotSummary) => bot.last?.at ?? bot.createdAt

/**
 * One bot in the Bots list: its face, its name and the time of its latest message, and under them what it does now in
 * coloured words (`botRowLine`). An idle bot's face sleeps. Unread messages show as a count until its chat opens.
 */
function BotRow({ bot, active, happyUntil, onOpen }: { bot: BotSummary; active: boolean; happyUntil: number | undefined; onOpen(): void }) {
  const line = botRowLine(bot)
  const time = bot.last ? formatMessageTime(bot.last.at) : undefined
  const unread = active ? 0 : bot.unread
  return <button type="button" className="bot-row" aria-current={active || undefined} title={bot.stateText && bot.state !== 'idle' ? `${bot.name}: ${bot.stateText}` : bot.name} aria-label={`Message ${bot.name}`} onClick={onOpen}>
    <BotFace look={bot.look} state={botFaceState(bot, happyUntil)} sleep={line.resting} size={36} view="head" />
    <span className="bot-row-text">
      <span className="bot-row-head">
        <span className="bot-row-name">{bot.name}</span>
        {unread > 0 && <span className="bot-row-unread" aria-label={`${unread} unread`}>{unread}</span>}
        {time && <span className="bot-row-time">{time}</span>}
      </span>
      <span className="bot-row-state" data-tone={line.tone}>{line.text}</span>
    </span>
  </button>
}

export function ChatsSidebar() {
  const snapshot = useChatsStore((s) => s.snapshot)
  const activeId = useChatsStore((s) => s.activeChatId)
  const openChat = useChatsStore((s) => s.openChat)
  // A bot being opened shows as chosen from the click on (`openingBotId`).
  const activeBotId = useChatsStore((s) => s.openingBotId ?? s.activeBotId)
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
  const newBot = () => useBotsStore.getState().openNewBot()
  const row = (chat: ChatSummary) => <button type="button" key={chat.id} className={`chat-list-row${chat.id === activeId ? ' active' : ''}`} onClick={() => void openChat(chat.id)}>
    <ChatAvatar name={chat.name} group={chat.kind === 'group'} />
    <span className="chat-list-text"><span className="chat-list-name">{chat.name}</span><span className="chat-list-preview">{chat.presentation === 'network' ? 'Space conversation' : chat.run?.state === 'running' ? 'Working…' : chat.lastMessage?.text || `${chat.participants.filter((p) => p.kind === 'agent').length} agent${chat.kind === 'group' ? 's' : ''}`}</span></span>
    {chat.run?.state === 'running' && <span className="chat-working-dot" aria-label="Working" />}
  </button>
  const groups = snapshot.chats.filter((chat) => chat.kind === 'group' && matches(chat.name))
  // The bot that spoke last comes first.
  const shownBots = bots.filter((bot) => matches(bot.name)).sort((a, b) => botActivityAt(b).localeCompare(botActivityAt(a)))
  const searching = searchOpen && search.trim() !== ''
  const [botsOpen, toggleBots] = useSectionOpen('bots', searching)
  const [groupsOpen, toggleGroups] = useSectionOpen('groups', searching)
  const [recentOpen, toggleRecent] = useSectionOpen('recent', searching)
  // Recent: direct chats, the latest first. Bots are listed once, in the Bots list above, with their faces and unread counts.
  const recent = snapshot.chats.filter((chat) => chat.kind === 'direct' && matches(chat.name))
    .map((chat) => ({ at: chat.lastMessage?.createdAt ?? chat.updatedAt, row: () => row(chat) }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  return <div className="chats-sidebar-content">
    {searchOpen && <div className="chat-search"><input ref={input} aria-label="Search chats" placeholder="Search chats" value={search} onChange={(event) => useChatsStore.setState({ search: event.target.value })} /><button aria-label="Close chat search" onClick={() => useChatsStore.setState({ searchOpen: false, search: '' })}><X size={14} /></button></div>}
    <section aria-label="Bots"><SectionHeading title="Bots" open={botsOpen} onToggle={toggleBots}><button aria-label="New bot" title="New bot" onClick={newBot}><Plus size={15} /></button></SectionHeading>
      <Collapse open={botsOpen} itemCount={shownBots.length}>
        {bots.length
          ? <div className="bot-list">{shownBots.map((bot) => <BotRow key={bot.id} bot={bot} active={bot.id === activeBotId} happyUntil={happy[bot.id]} onOpen={() => void openBot(bot.id)} />)}</div>
          : <p className="chat-empty-hint">No bots yet. Press + to make one.</p>}
      </Collapse>
    </section>
    <section aria-label="Groups"><SectionHeading title="Groups" open={groupsOpen} onToggle={toggleGroups}><span className="chat-section-actions"><button aria-label="Open a Space" title="Open a Space" onClick={() => setNetworkOpen(true)}><Globe size={15} /></button>{!!snapshot.agents.length && <button aria-label="New group" title="New group" onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'group' })}><Plus size={15} /></button>}</span></SectionHeading>
      <Collapse open={groupsOpen} itemCount={groups.length}>{groups.map(row)}{!groups.length && <p className="chat-empty-hint">No groups</p>}</Collapse>
    </section>
    {!!recent.length && <section className="chat-recent-section" aria-label="Recent chats"><SectionHeading title="Recent" open={recentOpen} onToggle={toggleRecent} />
      <Collapse open={recentOpen} itemCount={recent.length}>{recent.map((entry) => entry.row())}</Collapse>
    </section>}
    {networkOpen && <OpenNetworkChatDialog onClose={() => setNetworkOpen(false)} />}
  </div>
}
