import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowUp, CircleAlert, Loader2, Paperclip, Square, X } from '../../lib/icons'
import type { BotChatMessage, BotError, BotSummary } from '../../../shared/bots/personal/chat'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { BotFace } from './face/BotFace'
import { BotChips, BotChipView } from './BotChips'
import { BotAskCard } from './BotAskCard'
import { BotMenu } from './BotMenu'
import { BotAboutPanel } from './BotAboutPanel'

const EMPTY: BotChatMessage[] = []

/** A message's time: the time today, "Yesterday", or the date. */
export function botMessageTime(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The one red line of a bot's error, with its one way out (bot-ui §4.9). */
export function BotErrorLine({ error, onAction }: { error: BotError; onAction(action: NonNullable<BotError['action']>): void }) {
  return <div className="bot-error" role="status">
    <CircleAlert size={15} aria-hidden /><span>{error.text}</span>
    {error.action && <button type="button" onClick={() => onAction(error.action!)}>{error.action.label}</button>}
  </div>
}

function OwnerMessage({ message, pending }: { message: BotChatMessage; pending: boolean }) {
  return <article className={`chat-participant-message from-person bot-you${pending ? ' is-pending' : ''}`} data-message-id={message.id}>
    {message.text && <MarkdownPreview value={message.text} className="bot-you-bubble chat-message-markdown chat-markdown" />}
    {!!message.attachments?.length && <div className="bot-you-files">{message.attachments.map((file) => <span key={file.path} className="bot-file-pill" title={file.path}><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>}
    <time dateTime={message.at}>{pending ? 'Sending…' : botMessageTime(message.at)}</time>
  </article>
}

function BotMessage({ bot, message, onAction }: { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void }) {
  const store = useBotsStore.getState
  return <article className="chat-participant-message from-agent" data-message-id={message.id}>
    {/* Transcript faces are still: one baked pose per look, shared by every message. */}
    <BotFace look={bot.look} state="idle" size={40} view="head" className="bot-message-face" still />
    <div className="chat-participant-message-body">
      <div className="chat-message-meta"><strong>{bot.name}</strong><time dateTime={message.at}>{botMessageTime(message.at)}</time></div>
      {message.text && <MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" />}
      <BotChips chips={message.chips} />
      {message.ask && <BotAskCard botName={bot.name} ask={message.ask} fromRun={message.kind === 'notice'}
        onAnswer={(answer) => store().answer(bot.id, message.ask!.askId, answer)}
        onExport={() => store().exportMemory(bot.id, message.ask!.askId)} />}
      {message.error && <BotErrorLine error={message.error} onAction={onAction} />}
    </div>
  </article>
}

/**
 * A bot's chat (bot-ui §4.4): the header with its face, name, description and one menu; the
 * owner's bubbles and the bot's messages with chips, ask cards and error lines; one status line
 * while it works; and a composer with only text, attach and send or Stop.
 */
export function BotChatView({ bot }: { bot: BotSummary }) {
  const chat = useBotsStore((s) => s.chats[bot.id])
  const pending = useBotsStore((s) => s.pending[bot.id] ?? EMPTY)
  const live = useBotsStore((s) => s.live[bot.id])
  const happy = useBotsStore((s) => s.happy[bot.id])
  const draft = useBotsStore((s) => s.drafts[bot.id] ?? '')
  const attachments = useBotsStore((s) => s.attachments[bot.id])
  const aboutOpen = useBotsStore((s) => s.aboutOpen)
  // Another bot's error stays with that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === bot.id ? s.error : null))
  const store = useBotsStore.getState
  const transcript = useRef<HTMLDivElement>(null)
  const messages = chat?.messages ?? EMPTY
  const working = bot.state === 'working'
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  const files = attachments ?? []
  const canSend = !!draft.trim() || files.length > 0

  // This window shows the bot's chat: its replies only sound while it is on screen.
  useEffect(() => {
    void window.mousse.app.setViewedBot?.(bot.id)?.catch(() => undefined)
    return () => { void window.mousse.app.setViewedBot?.(null)?.catch(() => undefined) }
  }, [bot.id])
  useEffect(() => { if (lastSeq !== undefined) store().markRead(bot.id) }, [bot.id, lastSeq, store])

  // New messages keep the end in view; a page loaded above keeps the reader where they were.
  const anchor = useRef<{ firstId?: string; height: number; atEnd: boolean }>({ height: 0, atEnd: true })
  useLayoutEffect(() => {
    const element = transcript.current
    if (!element) return
    const held = anchor.current
    if (held.firstId && firstId !== held.firstId && !held.atEnd) element.scrollTop += element.scrollHeight - held.height
    else if (held.atEnd) element.scrollTop = element.scrollHeight
    anchor.current = { firstId, height: element.scrollHeight, atEnd: held.atEnd }
  }, [firstId, messages.length, pending.length, working, live?.chip?.text])
  useEffect(() => { anchor.current = { height: 0, atEnd: true } }, [bot.id])

  const act = (action: NonNullable<BotError['action']>) => {
    // Sign in opens the card of the owner's provider entry the bot would run on; Set up opens the list.
    if (action.kind === 'sign_in' && action.instanceId) openProvider(action.instanceId)
    else if (action.kind === 'sign_in' || action.kind === 'open_providers') openSettingsSection('providers')
    else void store().resume(bot.id)
  }
  const attach = async () => {
    const paths = await window.mousse.dialog.pickFiles({ title: `Attach files for ${bot.name}` }).catch(() => [] as string[])
    if (!paths.length) return
    const known = new Set(files.map((file) => file.path))
    const added = paths.filter((path) => !known.has(path)).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path }))
    store().setAttachments(bot.id, [...files, ...added])
  }

  return <>
    <section className="chat-conversation bot-conversation">
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={() => useBotsStore.setState({ aboutOpen: !aboutOpen })}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={40} view="head" />
          <div><h1>{bot.name}</h1><span>{bot.description}</span></div>
        </button>
        <BotMenu bot={bot} />
      </header>
      <div className="chat-transcript" ref={transcript} role="log" aria-label={`${bot.name} messages`} onScroll={(event) => {
        const element = event.currentTarget
        anchor.current.atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        anchor.current.height = element.scrollHeight
        if (element.scrollTop < 60 && chat?.hasMore) void store().loadOlder(bot.id)
      }}>
        {chat?.loadingOlder && <p className="chat-empty-hint bot-loading-older">Loading earlier messages…</p>}
        {messages.map((message) => message.author === 'owner'
          ? <OwnerMessage key={message.id} message={message} pending={false} />
          : <BotMessage key={message.id} bot={bot} message={message} onAction={act} />)}
        {pending.map((message) => <OwnerMessage key={message.id} message={message} pending />)}
        {working && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />{bot.name} is working…{live?.chip && <BotChipView chip={{ ...live.chip, live: true }} />}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      {error && <p role="alert" className="chat-error chat-composer-error">{error}</p>}
      <form className="agent-chat-composer bot-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) void store().send(bot.id) }}>
        {!!files.length && <div className="bot-composer-files">{files.map((file) => <span key={file.path} className="bot-file-pill" title={file.path}>
          <Paperclip size={12} aria-hidden />{file.name}
          <button type="button" aria-label={`Remove ${file.name}`} onClick={() => store().setAttachments(bot.id, files.filter((entry) => entry.path !== file.path))}><X size={11} /></button>
        </span>)}</div>}
        <textarea aria-label={`Message ${bot.name}`} placeholder={`Message ${bot.name}`} value={draft} onChange={(event) => store().setDraft(bot.id, event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
        <div className="agent-chat-composer-controls">
          <button type="button" className="bot-attach" aria-label="Attach" title="Attach" onClick={() => void attach()}><Paperclip size={15} /></button>
          {working && !canSend
            ? <button type="button" className="chat-send-button bot-send-ready" aria-label="Stop" title="Stop" onClick={() => void store().stop(bot.id)}><Square size={13} /></button>
            : <button type="submit" className={`chat-send-button${canSend ? ' bot-send-ready' : ''}`} disabled={!canSend} aria-label="Send" title="Send"><ArrowUp size={16} /></button>}
        </div>
      </form>
    </section>
    {aboutOpen && <BotAboutPanel bot={bot} />}
  </>
}
