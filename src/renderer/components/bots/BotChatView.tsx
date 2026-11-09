import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { CircleAlert, Loader2, Paperclip } from '../../lib/icons'
import type { BotChatMessage, BotError, BotSummary } from '../../../shared/bots/personal/chat'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { BotFace } from './face/BotFace'
import { BotChips, BotChipView } from './BotChips'
import { BotAskCard } from './BotAskCard'
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

// Messages render again only when they change: a poll, a live chip or the bot starting work leaves them alone.
const OwnerMessage = memo(function OwnerMessage({ message, pending }: { message: BotChatMessage; pending: boolean }) {
  return <article className={`chat-participant-message from-person bot-you${pending ? ' is-pending' : ''}`} data-message-id={message.id}>
    {message.text && <MarkdownPreview value={message.text} className="bot-you-bubble chat-message-markdown chat-markdown" />}
    {!!message.attachments?.length && <div className="bot-you-files">{message.attachments.map((file, index) => <span key={`${index}:${file.name}`} className="bot-file-pill" title={file.path || undefined}><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>}
    <time dateTime={message.at}>{pending ? 'Sending…' : botMessageTime(message.at)}</time>
  </article>
})

/** A bot message uses only the bot's id, name and look, so a change of its state does not render it again. */
const sameBotMessage = (a: BotMessageProps, b: BotMessageProps) => a.message === b.message && a.onAction === b.onAction && a.browser === b.browser &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name && a.bot.look.colour === b.bot.look.colour && a.bot.look.accessory === b.bot.look.accessory

/** `browser`: the live preview of the bot's browser, on the reply of the last run that used it. */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; browser?: ReactNode }

const BotMessage = memo(function BotMessage({ bot, message, onAction, browser }: BotMessageProps) {
  const store = useBotsStore.getState
  return <article className="chat-participant-message from-agent" data-message-id={message.id}>
    {/* Transcript faces are still: one baked pose per look, shared by every message. */}
    <BotFace look={bot.look} state="idle" size={40} view="head" className="bot-message-face" still />
    <div className="chat-participant-message-body">
      <div className="chat-message-meta"><strong>{bot.name}</strong><time dateTime={message.at}>{botMessageTime(message.at)}</time></div>
      {message.text && <MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" />}
      <BotChips chips={message.chips} />
      {browser}
      {message.ask && <BotAskCard botName={bot.name} ask={message.ask} fromRun={message.kind === 'notice'}
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
  const aboutOpen = useBotsStore((s) => s.aboutOpen)
  // Another bot's error stays with that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === bot.id ? s.error : null))
  const store = useBotsStore.getState
  const transcript = useRef<HTMLDivElement>(null)
  const messages = chat?.messages ?? EMPTY
  const working = bot.state === 'working'
  // Working, but waiting for the internet: no spinner, and the header says so.
  const offline = working && bot.waiting === 'internet'
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
  }, [firstId, messages.length, pending.length, working, live?.chip?.text])
  useEffect(() => { anchor.current = { height: 0, atEnd: true } }, [bot.id])

  const act = useCallback((action: NonNullable<BotError['action']>) => {
    // Sign in opens the card of the owner's provider entry the bot would run on; Set up opens the list.
    if (action.kind === 'sign_in' && action.instanceId) openProvider(action.instanceId)
    else if (action.kind === 'sign_in' || action.kind === 'open_providers') openSettingsSection('providers')
    else void store().resume(bot.id)
  }, [bot.id, store])
  // Up in an empty composer brings back the owner's last message, as in a thread.
  const lastPrompt = () => [...pending, ...messages].reverse().find((message) => message.author === 'owner' && message.text)?.text

  return <>
    <section className="chat-conversation bot-conversation">
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={() => useBotsStore.setState({ aboutOpen: !aboutOpen })}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={40} view="head" />
          <div><h1>{bot.name}</h1><span>{offline ? bot.stateText : bot.description}</span></div>
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
          : <BotMessage key={message.id} bot={bot} message={message} onAction={act} browser={message.id === previewOn ? preview : undefined} />)}
        {pending.map((message) => <OwnerMessage key={message.id} message={message} pending />)}
        {offline
          ? <div className="chat-run-status bot-offline-status" role="status">{bot.stateText}</div>
          : working && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />{bot.name} is working…{live?.chip && <BotChipView chip={{ ...live.chip, live: true }} />}</div>}
        {/* A run still working before its reply: the preview follows it here. */}
        {preview && !previewOn && <div className="bot-browser-live">{preview}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      <div className="chat-input-area bot-input-area">
        <ComposerNoticeProvider>
          <ComposerNoticeSource notice={error ? { tone: 'error', title: error, onDismiss: () => useBotsStore.setState({ error: null, errorBotId: null }) } : null} />
          <ComposerNoticeSlot />
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
