import { useEffect, useRef } from 'react'
import { AtSign, ArrowUp, Hash, Loader2, Monitor, Square, Users } from 'lucide-react'
import { useChatsStore } from '../../stores/chatsStore'
import { useAppStore } from '../../stores/appStore'
import { ChatAvatar } from './ChatsSidebar'
import { NewChatDialog } from './NewChatDialog'
import { ComposerQuestionModal } from '../ComposerQuestionModal'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { ChatBrowserAccess } from './ChatBrowserAccess'
import { ChatResourcesPanel } from './ChatResourcesPanel'
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
  const running = chat?.run?.state === 'running'
  const project = chat?.kind === 'group' ? projects.find((entry) => entry.id === chat.projectId) : undefined
  const messages = chat?.messages
  useEffect(() => {
    const element = transcript.current
    if (element) element.scrollTop = element.scrollHeight
  }, [activeId, messages?.length, running])
  const setDraft = (value: string) => { if (activeId) useChatsStore.getState().setDraft(activeId, value) }
  return <main className="chat-workspace" aria-label="Chats workspace">
    <section className="chat-conversation">
      {chat ? <>
        <header className="chat-conversation-header"><ChatAvatar name={chat.name} group={chat.kind === 'group'} /><div><h1>{chat.kind === 'group' && <Hash size={17} />}{chat.name}</h1><span>{chat.kind === 'group' ? `${chat.participants.filter((p) => p.kind === 'agent').length} agents` : `@${chat.participants.find((p) => p.kind === 'agent')?.slug || chat.name}`} · This device</span></div>{project && <span className="chat-project-chip">{project.name}</span>}<span className="chat-member-stack" title={chat.participants.map((p) => p.name).join(', ')}><Users size={16} />{chat.participants.length}</span></header>
        <div className="chat-transcript" ref={transcript} role="log" aria-label={`${chat.name} messages`}>
          {!chat.messages.length && <div className="chat-start-hint"><h2>{chat.kind === 'group' ? `Welcome to #${chat.name}` : `Chat with ${chat.name}`}</h2><p>{chat.kind === 'group' ? 'Mention an agent to direct a task. Agents can mention each other to hand off work.' : 'Send a message to start working together.'}</p></div>}
          {chat.messages.map((message) => {
            const participant = chat.participants.find((entry) => entry.id === message.participantId)
            const device = snapshot.devices.find((entry) => entry.id === participant?.deviceId)
            return <article className={`chat-participant-message ${participant?.kind === 'person' ? 'from-person' : 'from-agent'}`} key={message.id}>
              <ChatAvatar name={participant?.name || 'Agent'} /><div className="chat-participant-message-body"><div className="chat-message-meta"><strong>{participant?.name || 'Agent'}</strong>{participant?.kind === 'agent' && <span className="chat-runtime-badge"><Monitor size={11} />{device?.name || 'This device'}</span>}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" />{message.error && <p className="chat-error" role="status">{message.error}</p>}</div>
            </article>
          })}
          {running && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" />{chat.participants.find((p) => p.id === chat.run?.agentId || p.definitionId === chat.run?.agentId)?.name || 'Agents'} working…</div>}
          {chat.run?.error && <p className="chat-error" role="status">{chat.run.error}</p>}
        </div>
        {error && <p role="alert" className="chat-error chat-composer-error">{error}</p>}
        {chat.presentation !== 'network' && <ChatBrowserAccess key={chat.threadId} threadId={chat.threadId} />}
        {chat.pendingQuestions?.[0] && <div className="chat-approval"><ComposerQuestionModal pending={chat.pendingQuestions[0]}
          onSubmit={(answers) => { void window.mousse.orchestrator.answerQuestions(chat.pendingQuestions![0]!.requestId, answers).then(() => useChatsStore.getState().refresh()).catch((error) => useChatsStore.setState({ error: String(error?.message || error) })) }}
          onDismiss={() => { void window.mousse.orchestrator.dismissQuestions(chat.pendingQuestions![0]!.requestId).then(() => useChatsStore.getState().refresh()).catch((error) => useChatsStore.setState({ error: String(error?.message || error) })) }} /></div>}
        <form className="agent-chat-composer" onSubmit={(event) => { event.preventDefault(); if (draft.trim() && !running && !loading) void send(draft) }}>
          <textarea ref={textarea} aria-label="Message agents" placeholder={`Message ${chat.kind === 'group' ? '#' : ''}${chat.name} — @ an agent`} value={draft} disabled={loading} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
          <div className="agent-chat-composer-controls"><details className="chat-mention-menu"><summary><AtSign size={15} />Mention</summary><div>{chat.participants.filter((p) => p.kind === 'agent').map((agent) => <button type="button" key={agent.id} onClick={(event) => { setDraft(`${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${agent.slug} `); event.currentTarget.closest('details')?.removeAttribute('open'); textarea.current?.focus() }}><ChatAvatar name={agent.name} small />{agent.name}<span>@{agent.slug}</span></button>)}</div></details><span className="chat-composer-device">Agents run on this device</span>{running ? <button type="button" className="chat-send-button" aria-label="Stop agent run" onClick={() => void cancel()}><Square size={14} /></button> : <button type="submit" className="chat-send-button" disabled={!draft.trim() || loading} aria-label="Send message"><ArrowUp size={18} /></button>}</div>
        </form>
      </> : <div className="chat-workspace-empty"><span className="chat-workspace-empty-icon" aria-hidden="true"><Users size={28} /></span><h1>{loading ? 'Opening chat…' : 'Work with your agents'}</h1><p>Message an agent from the roster, or bring several agents into a group.</p><button className="chat-primary-button" disabled={loading} onClick={() => useChatsStore.setState({ newChatOpen: true, newChatKind: 'direct' })}>New chat</button>{error && <p role="alert" className="chat-error">{error}</p>}</div>}
    </section>
    {chat?.kind === 'group' && chat.presentation !== 'network' && <ChatResourcesPanel key={chat.id} chat={chat} />}
    {newChatOpen && <NewChatDialog />}
  </main>
}
