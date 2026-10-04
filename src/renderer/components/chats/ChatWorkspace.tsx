import { useEffect, useRef, useState } from 'react'
import { AtSign, ArrowUp, Hash, Loader2, Monitor, Square, Users } from '../../lib/icons'
import { useChatsStore } from '../../stores/chatsStore'
import { useAppStore } from '../../stores/appStore'
import { ChatAvatar } from './ChatsSidebar'
import { NewChatDialog } from './NewChatDialog'
import { ComposerQuestionModal } from '../ComposerQuestionModal'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { ChatBrowserAccess } from './ChatBrowserAccess'
import { ChatResourcesPanel } from './ChatResourcesPanel'
import { NetworkTranscript } from './NetworkTranscript'
import { NetworkChatActions } from './NetworkChatActions'
import { NetworkTaskPicker } from './NetworkTaskPicker'
import type { BotId } from '../../../shared/net'
import '../../styles/chats.css'

export function ChatWorkspace() {
  const chat = useChatsStore((s) => s.conversation)
  const activeId = useChatsStore((s) => s.activeChatId)
  const snapshot = useChatsStore((s) => s.snapshot)
  const loading = useChatsStore((s) => s.loading)
  const error = useChatsStore((s) => s.error)
  const newChatOpen = useChatsStore((s) => s.newChatOpen)
  const draft = useChatsStore((s) => s.drafts[activeId || ''] || '')
  const send = useChatsStore((s) => s.send)
  const cancel = useChatsStore((s) => s.cancel)
  const projects = useAppStore((s) => s.projects)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const [mentions, setMentions] = useState<Record<string, BotId[]>>({})
  const running = chat?.run?.state === 'running'
  const network = chat?.network
  const selection = mentions[chat?.id ?? ''] ?? []
  const agents = network ? network.participants.filter(p => p.kind === 'agent' && p.active) : chat?.participants.filter(p => p.kind === 'agent') ?? []
  const project = chat?.kind === 'group' ? projects.find((entry) => entry.id === chat.projectId) : undefined
  const messages = chat?.messages
  useEffect(() => {
    const element = transcript.current
    if (element) element.scrollTop = element.scrollHeight
  }, [activeId, messages?.length, network?.records.length, running])
  const setDraft = (value: string) => { if (activeId) useChatsStore.getState().setDraft(activeId, value) }
  return <main className="chat-workspace" aria-label="Chats workspace">
    <section className="chat-conversation">
      {chat ? <>
        <header className="chat-conversation-header"><ChatAvatar name={chat.name} group={chat.kind === 'group'} /><div><h1>{chat.kind === 'group' && <Hash size={16} />}{chat.name}</h1><span>{chat.kind === 'group' ? `${agents.length} agents` : `@${chat.participants.find((p) => p.kind === 'agent')?.slug || chat.name}`} · {network ? 'Published' : 'This device'}</span></div>{project && <span className="chat-project-chip">{project.name}</span>}<span className="chat-member-stack" title={(network?.participants ?? chat.participants).map((p) => p.name).join(', ')}><Users size={16} />{network?.participants.length ?? chat.participants.length}</span>{network ? <NetworkChatActions chatId={chat.id} network={network} /> : chat.kind === 'group' && <details className="chat-network-publish"><summary>Publish group</summary><p>Share new messages in a Space. Earlier history and resources stay on this device. Each mentioned bot runs in its own workspace.</p><button type="button" disabled={loading || running} onClick={() => void useChatsStore.getState().publish()}>Publish new conversation</button></details>}</header>
        <div className="chat-transcript" ref={transcript} role="log" aria-label={`${chat.name} messages`}>
          {!chat.messages.length && !network && <div className="chat-start-hint"><h2>{chat.kind === 'group' ? `Welcome to #${chat.name}` : `Chat with ${chat.name}`}</h2><p>{chat.kind === 'group' ? 'Mention an agent to direct a task. Agents can mention each other to hand off work.' : 'Send a message to start working together.'}</p></div>}
          {chat.messages.map((message) => {
            const participant = chat.participants.find((entry) => entry.id === message.participantId)
            const device = snapshot.devices.find((entry) => entry.id === participant?.deviceId)
            return <article className={`chat-participant-message ${participant?.kind === 'person' ? 'from-person' : 'from-agent'}`} key={message.id}>
              <ChatAvatar name={participant?.name || 'Agent'} /><div className="chat-participant-message-body"><div className="chat-message-meta"><strong>{participant?.name || 'Agent'}</strong>{participant?.kind === 'agent' && <span className="chat-runtime-badge"><Monitor size={11} />{device?.name || 'This device'}</span>}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" />{message.error && <p className="chat-error" role="status">{message.error}</p>}</div>
            </article>
          })}
          {network && <NetworkTranscript key={chat.id} chatId={chat.id} network={network} />}
          {running && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" />{chat.participants.find((p) => p.id === chat.run?.agentId || p.definitionId === chat.run?.agentId)?.name || 'Agents'} working…</div>}
          {chat.run?.error && <p className="chat-error" role="status">{chat.run.error}</p>}
        </div>
        {error && <p role="alert" className="chat-error chat-composer-error">{error}</p>}
        {network && <NetworkTaskPicker key={chat.id} chatId={chat.id} readonly={network.readonly} />}
        {chat.presentation !== 'network' && !network && <ChatBrowserAccess key={chat.threadId} threadId={chat.threadId} />}
        {chat.pendingQuestions?.[0] && <div className="chat-approval"><ComposerQuestionModal pending={chat.pendingQuestions[0]}
          onSubmit={(answers) => { void window.mousse.orchestrator.answerQuestions(chat.pendingQuestions![0]!.requestId, answers).then(() => useChatsStore.getState().refresh()).catch((error) => useChatsStore.setState({ error: String(error?.message || error) })) }}
          onDismiss={() => { void window.mousse.orchestrator.dismissQuestions(chat.pendingQuestions![0]!.requestId).then(() => useChatsStore.getState().refresh()).catch((error) => useChatsStore.setState({ error: String(error?.message || error) })) }} /></div>}
        <form className="agent-chat-composer" onSubmit={(event) => { event.preventDefault(); if (draft.trim() && !running && !loading && !network?.readonly) void send(draft, network ? selection : undefined) }}>
          <textarea ref={textarea} aria-label="Message agents" placeholder={`Message ${chat.kind === 'group' ? '#' : ''}${chat.name}${network ? ' · select bots with Mention' : ' — @ an agent'}`} value={draft} disabled={loading || network?.readonly} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
          <div className="agent-chat-composer-controls"><details className="chat-mention-menu"><summary><AtSign size={15} />Mention{network && !!selection.length && ` (${selection.length})`}</summary><div>{agents.map((agent) => <button type="button" key={agent.id} aria-pressed={network ? selection.includes(agent.id as BotId) : undefined} onClick={(event) => { if (network) setMentions(previous => ({ ...previous, [chat.id]: selection.includes(agent.id as BotId) ? selection.filter(id => id !== agent.id) : [...selection, agent.id as BotId] })); else setDraft(`${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${agent.slug} `); if (!network) event.currentTarget.closest('details')?.removeAttribute('open'); textarea.current?.focus() }}><ChatAvatar name={agent.name} small />{agent.name}<span>{network ? selection.includes(agent.id as BotId) ? 'Selected' : 'Select' : `@${agent.slug}`}</span></button>)}</div></details><span className="chat-composer-device">{network ? 'Mentioned bots use their own devices' : 'Agents run on this device'}</span>{running ? <button type="button" className="chat-send-button" aria-label="Stop agent run" onClick={() => void cancel()}><Square size={14} /></button> : <button type="submit" className="chat-send-button" disabled={!draft.trim() || loading || network?.readonly} aria-label="Send message"><ArrowUp size={16} /></button>}</div>
        </form>
      </> : <div className="chat-workspace-empty"><h1>{loading ? 'Opening chat…' : 'Work with your agents'}</h1><p>Message an agent from the roster, or bring several agents into a group.</p><button className="chat-primary-button" disabled={loading} onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'direct' })}>New chat</button>{error && <p role="alert" className="chat-error">{error}</p>}</div>}
    </section>
    {chat?.kind === 'group' && chat.presentation !== 'network' && !network && <ChatResourcesPanel key={chat.id} chat={chat} />}
    {newChatOpen && <NewChatDialog />}
  </main>
}
