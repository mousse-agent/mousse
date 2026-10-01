import { useEffect, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import type { ChatAgent, ChatSummary } from '../../../shared/chats'
import { useAppStore } from '../../stores/appStore'
import { useChatsStore } from '../../stores/chatsStore'
import '../../styles/chats.css'

export function ChatAvatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const color = [...name].reduce((value, char) => value + char.charCodeAt(0), 0) % 5
  return <span className={`chat-avatar chat-color-${color}${small ? ' small' : ''}${group ? ' group' : ''}`} aria-hidden="true">{group ? '#' : name.slice(0, 1).toUpperCase()}</span>
}
export function ChatsSidebar() {
  const snapshot = useChatsStore((s) => s.snapshot)
  const activeId = useChatsStore((s) => s.activeChatId)
  const openChat = useChatsStore((s) => s.openChat)
  const create = useChatsStore((s) => s.create)
  const searchOpen = useChatsStore((s) => s.searchOpen)
  const search = useChatsStore((s) => s.search)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (searchOpen) input.current?.focus() }, [searchOpen])
  const matches = (name: string) => name.toLowerCase().includes(search.toLowerCase())
  const openAgent = (agent: ChatAgent) => {
    const existing = snapshot.chats.find((chat) => chat.kind === 'direct' && chat.participants.some((p) => p.definitionId === agent.id))
    if (existing) void openChat(existing.id)
    else void create({ kind: 'direct', agentIds: [agent.id] })
  }
  const row = (chat: ChatSummary) => <button type="button" key={chat.id} className={`chat-list-row${chat.id === activeId ? ' active' : ''}`} onClick={() => void openChat(chat.id)}>
    <ChatAvatar name={chat.name} group={chat.kind === 'group'} />
    <span className="chat-list-text"><span className="chat-list-name">{chat.name}</span><span className="chat-list-preview">{chat.run?.state === 'running' ? 'Working…' : chat.lastMessage?.text || `${chat.participants.filter((p) => p.kind === 'agent').length} agent${chat.kind === 'group' ? 's' : ''}`}</span></span>
    {chat.run?.state === 'running' && <span className="chat-working-dot" aria-label="Working" />}
  </button>
  const groups = snapshot.chats.filter((chat) => chat.kind === 'group' && matches(chat.name))
  const directs = snapshot.chats.filter((chat) => chat.kind === 'direct' && matches(chat.name))
  return <div className="chats-sidebar-content">
    {searchOpen && <div className="chat-search"><input ref={input} aria-label="Search chats" placeholder="Search chats" value={search} onChange={(event) => useChatsStore.setState({ search: event.target.value })} /><button aria-label="Close chat search" onClick={() => useChatsStore.setState({ searchOpen: false, search: '' })}><X size={14} /></button></div>}
    <section aria-label="Agent roster"><div className="chat-section-heading"><h2>ROSTER</h2><button aria-label="Manage agents" title="Manage agents" onClick={() => { useAppStore.getState().setScheduledOpen(true) }}><Plus size={15} /></button></div>
      <div className="chat-roster">{snapshot.agents.filter((agent) => matches(agent.name)).map((agent) => <button key={agent.id} type="button" title={agent.unavailableReason || `Message @${agent.slug} · ${snapshot.devices.find((d) => d.id === agent.deviceId)?.name || 'This device'}`} aria-label={`Message ${agent.name}`} disabled={!agent.available} onClick={() => openAgent(agent)}><ChatAvatar name={agent.name} /><span>{agent.name}</span></button>)}</div>
      {!snapshot.agents.length && <p className="chat-empty-hint">Create and publish an agent in Automations to start a chat.</p>}
    </section>
    <section aria-label="Groups"><div className="chat-section-heading"><h2>GROUPS</h2><button aria-label="New group" onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'group' })}><Plus size={15} /></button></div>{groups.map(row)}{!groups.length && <p className="chat-empty-hint">No groups yet</p>}</section>
    <section className="chat-recent-section" aria-label="Recent agent chats"><div className="chat-section-heading"><h2>RECENTS</h2></div>{directs.map(row)}{!directs.length && <p className="chat-empty-hint">Message an agent from the roster.</p>}</section>
  </div>
}
