import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, Loader2, Paperclip, Reply, X } from '../../lib/icons'
import type { BotChatMessage, BotChatQuote, BotChip, BotError, BotSummary, BotWorkItem } from '../../../shared/bots/personal/chat'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { BotFace } from './face/BotFace'
import { BotChips, BotChipView } from './BotChips'
import { BotAsk } from '../asks/AskCard'
import { BotMenu } from './BotMenu'
import { BotAboutPanel } from './BotAboutPanel'
import { BotBrowserPane, BotBrowserPreview } from './BotBrowser'
import { useBotBrowser, useBotBrowserStore } from '../../stores/botBrowserStore'
import { ChatComposer, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../ComposerNotice'

const EMPTY: BotChatMessage[] = []
const NO_FILES: AttachedFile[] = []
const NO_VOICE: VoiceMessage[] = []
const NO_SKILLS: never[] = []
const NO_WORK: BotWorkItem[] = []
/** The chat's turn waits for the internet (its work, if any, says so on its own line). */
const OFFLINE_TEXT = 'Waiting for internet'
const ignore = () => {}

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

/** Scrolls to a message of the open chat and lights it briefly; nothing when it is not loaded. */
function showMessage(id: string): void {
  const element = document.querySelector(`.bot-conversation [data-message-id="${CSS.escape(id)}"]`)
  if (!(element instanceof HTMLElement)) return
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.remove('is-shown')
  void element.offsetWidth
  element.classList.add('is-shown')
  window.setTimeout(() => element.classList.remove('is-shown'), 1400)
}

/** The quote above a message that answers an earlier one, not the one right above it: who wrote it and its first line. */
export function BotReplyQuote({ quote, botName }: { quote: BotChatQuote; botName: string }) {
  return <button type="button" className="bot-reply-quote" disabled={quote.gone} onClick={() => showMessage(quote.id)} aria-label={`Replying to ${quote.author === 'owner' ? 'your message' : `${botName}'s message`}: ${quote.text}`}>
    <strong>{quote.author === 'owner' ? 'You' : botName}</strong>
    <span>{quote.gone ? 'This message was removed.' : quote.text || 'Files'}</span>
  </button>
}

/** How long work has run, in plain words: "just now", "4 min", "1 h 20 min". */
export function workElapsed(startedAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(startedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** What a piece of work is doing now, in a few words. */
function workDoing(item: BotWorkItem, chip: BotChip | undefined): string {
  if (item.status === 'queued') return 'waiting its turn'
  if (item.status === 'waiting_for_internet') return 'waiting for internet'
  if (item.status === 'paused') return 'held'
  return chip ? `${chip.text}${chip.highlight ? ` ${chip.highlight}` : ''}` : 'working'
}

/** One piece of work above the composer: its title, what it is doing, for how long, and Stop. The time moves twice a minute. */
const WorkLine = memo(function WorkLine({ botId, item }: { botId: string; item: BotWorkItem }) {
  const chip = useBotsStore((s) => s.activity[item.id])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const running = item.status === 'running'
  return <li className={`bot-work-line${running ? ' is-running' : ''}`}>
    {running ? <Loader2 size={13} className="chat-spin" aria-hidden /> : <span className="bot-work-dot" aria-hidden />}
    <span className="bot-work-title">{item.title}</span>
    <span className="bot-work-doing">{workDoing(item, chip)} · {workElapsed(item.startedAt, now)}</span>
    <button type="button" aria-label={`Stop ${item.title}`} title="Stop" onClick={() => void useBotsStore.getState().stopWork(botId, item.id)}><X size={13} aria-hidden /></button>
  </li>
})

/** A message as a reply quote: who wrote it and its first line. */
export function quoteOf(message: BotChatMessage): BotChatQuote {
  const line = (message.text || message.error?.text || message.attachments?.map((file) => file.name).join(', ') || '').trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return { id: message.id, author: message.author, text: line.length > 160 ? `${line.slice(0, 159)}…` : line }
}

function ReplyButton({ onReply }: { onReply(): void }) {
  return <button type="button" className="bot-reply-button" aria-label="Reply" title="Reply" onClick={onReply}><Reply size={14} aria-hidden /></button>
}

interface OwnerMessageProps { message: BotChatMessage; pending: boolean; botName: string; quote: boolean; onReply?(message: BotChatMessage): void }

// Messages render again only when they change: a poll, a live chip or the bot starting work leaves them alone.
const OwnerMessage = memo(function OwnerMessage({ message, pending, botName, quote, onReply }: OwnerMessageProps) {
  return <article className={`chat-participant-message from-person bot-you${pending ? ' is-pending' : ''}`} data-message-id={message.id}>
    {quote && message.replyTo && <BotReplyQuote quote={message.replyTo} botName={botName} />}
    {message.text && <MarkdownPreview value={message.text} className="bot-you-bubble chat-message-markdown chat-markdown" />}
    {!!message.attachments?.length && <div className="bot-you-files">{message.attachments.map((file, index) => <span key={`${index}:${file.name}`} className="bot-file-pill" title={file.path || undefined}><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>}
    <div className="bot-you-meta">
      {!pending && onReply && <ReplyButton onReply={() => onReply(message)} />}
      <time dateTime={message.at}>{pending ? 'Sending…' : botMessageTime(message.at)}</time>
    </div>
  </article>
})

/** A bot message uses only the bot's id, name and look, so a change of its state does not render it again. */
const sameBotMessage = (a: BotMessageProps, b: BotMessageProps) => a.message === b.message && a.onAction === b.onAction && a.browser === b.browser &&
  a.quote === b.quote && a.onReply === b.onReply &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name && a.bot.look.colour === b.bot.look.colour && a.bot.look.accessory === b.bot.look.accessory

/**
 * `browser`: the live preview of the bot's browser, on the reply of the last run that used it. `quote`: show the
 * message this one answers (it is not the one right above).
 */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; browser?: ReactNode; quote: boolean; onReply(message: BotChatMessage): void }

const BotMessage = memo(function BotMessage({ bot, message, onAction, browser, quote, onReply }: BotMessageProps) {
  const store = useBotsStore.getState
  return <article className="chat-participant-message from-agent" data-message-id={message.id}>
    {/* Transcript faces are still: one baked pose per look, shared by every message. */}
    <BotFace look={bot.look} state="idle" size={40} view="head" className="bot-message-face" still />
    <div className="chat-participant-message-body">
      <div className="chat-message-meta"><strong>{bot.name}</strong><time dateTime={message.at}>{botMessageTime(message.at)}</time><ReplyButton onReply={() => onReply(message)} /></div>
      {quote && message.replyTo && <BotReplyQuote quote={message.replyTo} botName={bot.name} />}
      {message.text && <MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" />}
      <BotChips chips={message.chips} />
      {browser}
      {message.ask && <BotAsk botName={bot.name} ask={message.ask} fromRun={message.kind === 'notice'}
        onAnswer={(answer) => store().answer(bot.id, message.ask!.askId, answer)}
        onExport={() => store().exportMemory(bot.id, message.ask!.askId)} />}
      {message.error && <BotErrorLine error={message.error} onAction={onAction} />}
    </div>
  </article>
}, sameBotMessage)

/**
 * A bot's chat (bot-ui §4.4): the header with its face, name, description and one menu; the
 * owner's bubbles and the bot's messages with chips, ask cards and error lines; one status line
 * while it works; and the thread composer without a thread's run settings: text, attach (also by
 * dropping or pasting), dictation, and send or Stop.
 */
export function BotChatView({ bot }: { bot: BotSummary }) {
  const chat = useBotsStore((s) => s.chats[bot.id])
  const pending = useBotsStore((s) => s.pending[bot.id] ?? EMPTY)
  const live = useBotsStore((s) => s.live[bot.id])
  const happy = useBotsStore((s) => s.happy[bot.id])
  const draft = useBotsStore((s) => s.drafts[bot.id] ?? '')
  const attachments = useBotsStore((s) => s.attachments[bot.id])
  const replying = useBotsStore((s) => s.replyingTo[bot.id])
  const aboutOpen = useBotsStore((s) => s.aboutOpen)
  // Another bot's error stays with that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === bot.id ? s.error : null))
  const store = useBotsStore.getState
  const transcript = useRef<HTMLDivElement>(null)
  const messages = chat?.messages ?? EMPTY
  // The chat's own turn: its status line and Stop. Work beside it has its line above the composer, and the chat stays free.
  // A service from before work (no `chat` or `work` in its summary) says only that the bot works: that is the chat's.
  const legacy = bot.chat === undefined && bot.work === undefined
  const working = Boolean(bot.chat) || (legacy && bot.state === 'working')
  const chatChip = useBotsStore((s) => (bot.chat ? s.activity[bot.chat.activationId] : undefined)) ?? (legacy || live?.activationId === bot.chat?.activationId ? live?.chip : undefined)
  const work = bot.work ?? NO_WORK
  // The chat's turn waits for the internet: no spinner, and the header says so (work that waits says so on its line).
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  const files = attachments ?? NO_FILES
  // The bot's own browser: its last run's reply shows a live preview, and Expand opens the split view.
  const browser = useBotBrowser(bot.id, true)
  const paneOpen = useBotBrowserStore((s) => s.paneBotId === bot.id)
  const browserRun = browser?.activations.at(-1)
  const previewOn = browserRun ? messages.filter((message) => message.author === 'bot' && message.activationId === browserRun).at(-1)?.id : undefined
  const preview = browser && browserRun ? <BotBrowserPreview bot={bot} view={browser} /> : null

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
  }, [firstId, messages.length, pending.length, working, live?.chip?.text, replying?.id, work.length])
  useEffect(() => { anchor.current = { height: 0, atEnd: true } }, [bot.id])

  const act = useCallback((action: NonNullable<BotError['action']>) => {
    // Sign in opens the card of the owner's provider entry the bot would run on; Set up opens the list.
    if (action.kind === 'sign_in' && action.instanceId) openProvider(action.instanceId)
    else if (action.kind === 'sign_in' || action.kind === 'open_providers') openSettingsSection('providers')
    else void store().resume(bot.id)
  }, [bot.id, store])
  // Reply on a message: its quote goes above the composer, which takes the focus.
  const reply = useCallback((message: BotChatMessage) => {
    store().setReplyingTo(bot.id, quoteOf(message))
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')?.focus())
  }, [bot.id, store])
  // Up in an empty composer brings back the owner's last message, as in a thread.
  const lastPrompt = () => [...pending, ...messages].reverse().find((message) => message.author === 'owner' && message.text)?.text

  return <>
    <section className="chat-conversation bot-conversation">
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={() => useBotsStore.setState({ aboutOpen: !aboutOpen })}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={40} view="head" />
          <div><h1>{bot.name}</h1><span>{offline ? OFFLINE_TEXT : bot.description}</span></div>
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
        {messages.map((message, index) => {
          // A reply shows what it answers unless that is the message right above it.
          const quote = Boolean(message.replyTo) && messages[index - 1]?.id !== message.replyTo!.id
          return message.author === 'owner'
            ? <OwnerMessage key={message.id} message={message} pending={false} botName={bot.name} quote={quote} onReply={reply} />
            : <BotMessage key={message.id} bot={bot} message={message} onAction={act} browser={message.id === previewOn ? preview : undefined} quote={quote} onReply={reply} />
        })}
        {pending.map((message) => <OwnerMessage key={message.id} message={message} pending botName={bot.name} quote={Boolean(message.replyTo)} />)}
        {offline
          ? <div className="chat-run-status bot-offline-status" role="status">{OFFLINE_TEXT}</div>
          : working && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />{bot.name} is working…{chatChip && <BotChipView chip={{ ...chatChip, live: true }} />}</div>}
        {/* A run still working before its reply: the preview follows it here. */}
        {preview && !previewOn && <div className="bot-browser-live">{preview}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      <div className="chat-input-area bot-input-area">
        <ComposerNoticeProvider>
          <ComposerNoticeSource notice={error ? { tone: 'error', title: error, onDismiss: () => useBotsStore.setState({ error: null, errorBotId: null }) } : null} />
          <ComposerNoticeSlot />
          {!!work.length && <ul className="bot-work" aria-label={`${bot.name}'s work`}>{work.map((item) => <WorkLine key={item.id} botId={bot.id} item={item} />)}</ul>}
          {replying && <div className="bot-replying" role="status">
            <Reply size={14} aria-hidden />
            <div><strong>Replying to {replying.author === 'owner' ? 'yourself' : bot.name}</strong><span>{replying.text || 'Files'}</span></div>
            <button type="button" aria-label="Don't reply to this message" title="Cancel reply" onClick={() => store().setReplyingTo(bot.id, null)}><X size={14} aria-hidden /></button>
          </div>}
          {/* A bot picks its own model: no model picker, context ring, permission mode, commands or skills. */}
          <ChatComposer
            key={bot.id}
            input={draft}
            onInputChange={(value) => store().setDraft(bot.id, value)}
            attachedFiles={files}
            onAttachedFilesChange={(next) => store().setAttachments(bot.id, next)}
            voiceMessages={NO_VOICE}
            onVoiceMessagesChange={ignore}
            enabledSkills={NO_SKILLS}
            disableSkillsPicker
            slashCommands={false}
            placeholder={`Message ${bot.name}`}
            stoppable={working}
            onSend={() => void store().send(bot.id)}
            onStop={() => void store().stop(bot.id)}
            lastPrompt={lastPrompt}
          />
        </ComposerNoticeProvider>
      </div>
    </section>
    {paneOpen && browser && <BotBrowserPane bot={bot} view={browser} />}
    {aboutOpen && <BotAboutPanel bot={bot} />}
  </>
}
