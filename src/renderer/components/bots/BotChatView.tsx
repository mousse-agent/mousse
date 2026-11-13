import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowDown, CircleAlert, Loader2, Reply, Shield, X } from '../../lib/icons'
import type { BotChatMessage, BotChatQuote, BotChip, BotError, BotSummary, BotWorkItem } from '../../../shared/bots/personal/chat'
import { BOT_COLOUR_HEX, normalizeBotLook } from '../../../shared/bots/personal/look'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { BotFace } from './face/BotFace'
import { BotChips, BotChipView } from './BotChips'
import { BotAsk } from '../asks/AskCard'
import { BotMenu } from './BotMenu'
import { BotAboutPanel, RUNS_ON_ID } from './BotAboutPanel'
import { BotBrowserPane, BotBrowserPreview } from './BotBrowser'
import { useBotBrowser, useBotBrowserStore } from '../../stores/botBrowserStore'
import { ChatComposer, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../ComposerNotice'
import { botFullTime, botGroupTime, botMessageLabel, placeMessages } from './messageGroups'
import { ImageGalleryProvider } from '../../chat/components/agent-elements/image-gallery'
import { BotImageFiles, BotMarkdownImage, BotOtherFiles, botFileImageUrl } from './BotImages'
import { botChatImages } from './imageSources'

const EMPTY: BotChatMessage[] = []
const NO_FILES: AttachedFile[] = []
const NO_VOICE: VoiceMessage[] = []
const NO_SKILLS: never[] = []
const NO_WORK: BotWorkItem[] = []
/** The chat's turn waits for the internet (its work, if any, says so on its own line). */
const OFFLINE_TEXT = 'Waiting for internet'
const ignore = () => {}

/** The one red line of a bot's error, with its one way out (bot-ui §4.9). */
export function BotErrorLine({ error, onAction }: { error: BotError; onAction(action: NonNullable<BotError['action']>): void }) {
  return <div className="bot-error" role="status">
    <CircleAlert size={15} aria-hidden /><span>{error.text}</span>
    {error.action && <button type="button" onClick={() => onAction(error.action!)}>{error.action.label}</button>}
  </div>
}

const messageElement = (id: string) => {
  const element = document.querySelector(`.bot-conversation [data-message-id="${CSS.escape(id)}"]`)
  return element instanceof HTMLElement ? element : null
}
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

/**
 * Scrolls to a message of the open chat and lights it briefly. A message not loaded yet is loaded first, page by
 * page of older history; one the chat no longer has does nothing.
 */
async function showMessage(botId: string, id: string): Promise<void> {
  let element = messageElement(id)
  if (!element) {
    if (!(await useBotsStore.getState().findMessage(botId, id))) return
    // The loaded page renders on its own schedule: wait a few frames for the message to be drawn.
    for (let frame = 0; frame < 10 && !(element = messageElement(id)); frame += 1) await nextFrame()
    if (!element) return
  }
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.remove('is-shown')
  void element.offsetWidth
  element.classList.add('is-shown')
  window.setTimeout(() => element.classList.remove('is-shown'), 1400)
}

/** Whose message a quote is, in its label: the owner's or the bot's. */
const quoteOwner = (quote: BotChatQuote, botName: string) => (quote.author === 'owner' ? 'your message' : `${botName}'s message`)
/** A quote's one line: the message's first line, "Files" for files alone, or that it was removed. */
const quoteLine = (quote: BotChatQuote) => (quote.gone ? 'This message was removed.' : quote.text || 'Files')

/**
 * A quote's mark and line, shared by the quote in the transcript and the one above the composer. The owner's
 * messages are told by the accent tint and the bot's by its own colour (styles/bots.css); only the bot's carry a name.
 */
function QuoteLine({ quote, botName }: { quote: BotChatQuote; botName: string }) {
  return <>
    <Reply size={14} className="bot-quote-mark" aria-hidden />
    {quote.author === 'bot' && <strong>{botName}</strong>}
    <span>{quoteLine(quote)}</span>
  </>
}

/** The quote above a message that answers an earlier one, not the one right above it: who wrote it and its first line. */
export function BotReplyQuote({ botId, quote, botName }: { botId: string; quote: BotChatQuote; botName: string }) {
  return <button type="button" className="bot-quote bot-reply-quote" data-author={quote.author} disabled={quote.gone} onClick={() => void showMessage(botId, quote.id)} aria-label={`Replying to ${quoteOwner(quote, botName)}: ${quoteLine(quote)}`}>
    <QuoteLine quote={quote} botName={botName} />
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

/** Something waiting on the owner, pinned above the composer: the message it is on (absent when not loaded) and its line. */
export interface BotPinned { kind: 'ask' | 'error'; id?: string; text: string }

/**
 * What stays pinned above the composer while the owner scrolls: the newest open ask, and the bot's current error
 * (its summary's, which Resume or a good run clears). Each points at its full message: the ask's own, and the newest
 * message with that error (or any error).
 */
export function pinnedOf(messages: readonly BotChatMessage[], bot: Pick<BotSummary, 'name' | 'error'>): BotPinned[] {
  const pinned: BotPinned[] = []
  const ask = messages.filter((message) => message.ask?.status === 'open').at(-1)
  if (ask) pinned.push({ kind: 'ask', id: ask.id, text: `${bot.name} wants to ${ask.ask!.title}` })
  if (bot.error) {
    const errors = messages.filter((message) => message.error)
    const shown = errors.filter((message) => message.error!.text === bot.error!.text).at(-1) ?? errors.at(-1)
    pinned.push({ kind: 'error', ...(shown ? { id: shown.id } : {}), text: bot.error.text })
  }
  return pinned
}

function PinnedLine({ botId, item }: { botId: string; item: BotPinned }) {
  const Icon = item.kind === 'ask' ? Shield : CircleAlert
  return <button type="button" className="bot-pinned" data-kind={item.kind} disabled={!item.id} title={item.id ? 'Show message' : undefined} onClick={() => { if (item.id) void showMessage(botId, item.id) }}>
    <Icon size={14} aria-hidden /><span>{item.text}</span>
  </button>
}

function ReplyButton({ onReply }: { onReply(): void }) {
  return <button type="button" className="bot-reply-button" aria-label="Reply" title="Reply" onClick={onReply}><Reply size={14} aria-hidden /></button>
}

/** `starts`: the first message of its group, with the group's space above it (messageGroups.ts). */
interface OwnerMessageProps { botId: string; message: BotChatMessage; pending: boolean; botName: string; quote: boolean; starts: boolean; onReply?(message: BotChatMessage): void }

// Messages render again only when they change: a poll, a live chip or the bot starting work leaves them alone.
// The group's time is drawn beside them (GroupTime), so a message that stops being a group's last does not render again.
const OwnerMessage = memo(function OwnerMessage({ botId, message, pending, botName, quote, starts, onReply }: OwnerMessageProps) {
  const quoted = quote && message.replyTo
  return <article className={`chat-participant-message from-person bot-you${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${pending ? ' is-pending' : ''}`} data-message-id={message.id} title={pending ? undefined : botFullTime(message.at)}>
    {quoted && <BotReplyQuote botId={botId} quote={message.replyTo!} botName={botName} />}
    <div className="bot-you-line">
      {!pending && onReply && <ReplyButton onReply={() => onReply(message)} />}
      {/* As in a messaging app: the pictures first, the words under them, then any other files. */}
      <div className="bot-you-content">
        {!!message.attachments?.length && <BotImageFiles files={message.attachments} />}
        {message.text && <MarkdownPreview value={message.text} className="bot-you-bubble chat-message-markdown chat-markdown" renderImage={BotMarkdownImage} />}
        {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
      </div>
    </div>
  </article>
})

/** One small time under a group's last message, on its sender's side; "Sending…" while that message is on its way. */
function GroupTime({ message, pending }: { message: BotChatMessage; pending: boolean }) {
  return <div className="bot-group-time" data-author={message.author}>
    {pending ? <span>Sending…</span> : <time dateTime={message.at} title={botFullTime(message.at)}>{botGroupTime(message.at)}</time>}
  </div>
}

/** A bot message uses only the bot's id, name and look, so a change of its state does not render it again. */
const sameBotMessage = (a: BotMessageProps, b: BotMessageProps) => a.message === b.message && a.onAction === b.onAction && a.browser === b.browser &&
  a.quote === b.quote && a.starts === b.starts && a.onReply === b.onReply &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name && a.bot.look.colour === b.bot.look.colour && a.bot.look.accessory === b.bot.look.accessory

/**
 * `browser`: the live preview of the bot's browser, on the reply of the last run that used it. `quote`: show the
 * message this one answers (it is not the one right above). `starts`: the first of its group, with the face and name;
 * the rest of the group leave the face's place empty, with Reply in it on hover.
 */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; browser?: ReactNode; quote: boolean; starts: boolean; onReply(message: BotChatMessage): void }

const BotMessage = memo(function BotMessage({ bot, message, onAction, browser, quote, starts, onReply }: BotMessageProps) {
  const store = useBotsStore.getState
  const quoted = quote && message.replyTo
  const label = botMessageLabel(message)
  return <article className={`chat-participant-message from-agent${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}`} data-message-id={message.id} title={botFullTime(message.at)}>
    {/* Transcript faces are still: one baked pose per look, shared by every message. */}
    {starts
      ? <BotFace look={bot.look} state="idle" size={36} view="head" className="bot-message-face" still />
      : <div className="bot-message-gutter"><ReplyButton onReply={() => onReply(message)} /></div>}
    <div className="chat-participant-message-body">
      {starts && <div className="chat-message-meta"><strong>{bot.name}</strong>{label && <span className="bot-message-label">{label}</span>}<ReplyButton onReply={() => onReply(message)} /></div>}
      {!starts && label && <span className="bot-message-label is-own-line">{label}</span>}
      {quoted && <BotReplyQuote botId={bot.id} quote={message.replyTo!} botName={bot.name} />}
      {message.text && <MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" renderImage={BotMarkdownImage} />}
      {!!message.attachments?.length && <div className="bot-message-files"><BotImageFiles files={message.attachments} /><BotOtherFiles files={message.attachments} /></div>}
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
 * A bot's chat (bot-ui §4.4): the header with its face, name (what it does is in About) and one menu; the
 * owner's bubbles and the bot's messages with chips, ask cards and error lines; one status line
 * while it works; and the thread composer without a thread's run settings: text, attach (also by
 * dropping or pasting), dictation, and send or Stop.
 */
export function BotChatView({ bot }: { bot: BotSummary }) {
  const chat = useBotsStore((s) => s.chats[bot.id])
  const load = useBotsStore((s) => s.chatLoad[bot.id])
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
  // The sent messages and those on their way, in one run of groups: who starts and ends each, and the day lines.
  const shown = useMemo(() => (pending.length ? [...messages, ...pending] : messages), [messages, pending])
  const places = useMemo(() => placeMessages(shown), [shown])
  // The bot's own browser: the reply of the run whose tab it shows has a live preview, and Expand opens the split view.
  // Each watches the browser's pictures only while it is on screen.
  const browser = useBotBrowser(bot.id)
  const paneOpen = useBotBrowserStore((s) => s.pane === bot.id)
  const browserRun = browser?.activationId ?? browser?.activations.at(-1)
  const previewOn = browserRun ? messages.filter((message) => message.author === 'bot' && message.activationId === browserRun).at(-1)?.id : undefined
  const preview = browser && browserRun ? <BotBrowserPreview bot={bot} view={browser} /> : null

  // This window shows the bot's chat: its replies only sound while it is on screen.
  useEffect(() => {
    void window.mousse.app.setViewedBot?.(bot.id)?.catch(() => undefined)
    return () => { void window.mousse.app.setViewedBot?.(null)?.catch(() => undefined) }
  }, [bot.id])
  useEffect(() => { if (lastSeq !== undefined) store().markRead(bot.id) }, [bot.id, lastSeq, store])

  // New messages keep the end in view; a page loaded above keeps the reader where they were.
  // Scrolled up, a new message from the bot leaves the reader where they are and offers New message instead.
  const anchor = useRef<{ firstId?: string; lastSeq?: number; height: number; atEnd: boolean }>({ height: 0, atEnd: true })
  const [unseen, setUnseen] = useState(false)
  useLayoutEffect(() => {
    const element = transcript.current
    if (!element) return
    const held = anchor.current
    if (held.firstId && firstId !== held.firstId && !held.atEnd) element.scrollTop += element.scrollHeight - held.height
    else if (held.atEnd) element.scrollTop = element.scrollHeight
    if (!held.atEnd && held.lastSeq !== undefined && lastSeq !== undefined && lastSeq > held.lastSeq && messages.at(-1)?.author === 'bot') setUnseen(true)
    anchor.current = { firstId, lastSeq, height: element.scrollHeight, atEnd: held.atEnd }
  }, [firstId, lastSeq, messages, pending.length, working, live?.chip?.text, replying?.id, work.length])
  useEffect(() => { anchor.current = { lastSeq: anchor.current.lastSeq, height: 0, atEnd: true }; setUnseen(false) }, [bot.id])
  const toEnd = () => {
    const element = transcript.current
    if (element?.scrollTo) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else if (element) element.scrollTop = element.scrollHeight
    anchor.current.atEnd = true
    setUnseen(false)
  }
  // A pinned line hides while its full message is on screen, so it never shows twice.
  const pinned = useMemo(() => pinnedOf(messages, bot), [messages, bot])
  const [onScreen, setOnScreen] = useState('')
  const measure = useCallback(() => {
    const element = transcript.current
    if (!element) return
    const view = element.getBoundingClientRect()
    const shown = pinned.filter((item) => {
      const box = item.id ? element.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)?.getBoundingClientRect() : undefined
      return box && box.bottom > view.top + 24 && box.top < view.bottom - 24
    }).map((item) => item.kind).join(' ')
    setOnScreen(shown)
  }, [pinned])
  useLayoutEffect(measure, [measure, messages.length, pending.length])
  const pinnedOff = pinned.filter((item) => !onScreen.split(' ').includes(item.kind))

  const act = useCallback((action: NonNullable<BotError['action']>) => {
    // Sign in opens the card of the owner's provider entry the bot would run on; Set up opens the list.
    if (action.kind === 'sign_in' && action.instanceId) openProvider(action.instanceId)
    else if (action.kind === 'sign_in' || action.kind === 'open_providers') openSettingsSection('providers')
    // A picked model that can't run (#673): About opens at Runs on.
    else if (action.kind === 'pick_model') {
      useBotsStore.setState({ aboutOpen: true })
      window.requestAnimationFrame(() => document.getElementById(RUNS_ON_ID)?.scrollIntoView({ block: 'center' }))
    } else void store().resume(bot.id)
  }, [bot.id, store])
  // Reply on a message: its quote goes above the composer, which takes the focus.
  const reply = useCallback((message: BotChatMessage) => {
    store().setReplyingTo(bot.id, quoteOf(message))
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea')?.focus())
  }, [bot.id, store])
  // Up in an empty composer brings back the owner's last message, as in a thread.
  const lastPrompt = () => [...pending, ...messages].reverse().find((message) => message.author === 'owner' && message.text)?.text
  // The preview steps through every picture of this chat that has loaded, read only when one opens.
  const chatImages = () => botChatImages(shown, botFileImageUrl)

  return <ImageGalleryProvider images={chatImages}>
    {/* The bot's colour tints the quotes of its messages. */}
    <section className="chat-conversation bot-conversation" style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={() => useBotsStore.setState({ aboutOpen: !aboutOpen })}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={32} view="head" />
          <div><h1>{bot.name}</h1></div>
        </button>
        <BotMenu bot={bot} />
      </header>
      <div className="chat-transcript" ref={transcript} role="log" aria-label={`${bot.name} messages`} onScroll={(event) => {
        const element = event.currentTarget
        anchor.current.atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        anchor.current.height = element.scrollHeight
        if (anchor.current.atEnd) setUnseen(false)
        measure()
        if (element.scrollTop < 60 && chat?.hasMore) void store().loadOlder(bot.id)
      }}>
        {!chat && load === 'loading' && <div className="bot-load-state" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />Loading messages…</div>}
        {!chat && load === 'failed' && <div className="bot-load-state is-failed" role="status">
          <span>Couldn’t load messages.</span>
          <button type="button" onClick={() => void store().loadChat(bot.id)}>Retry</button>
        </div>}
        {chat?.loadingOlder && <p className="chat-empty-hint bot-loading-older">Loading earlier messages…</p>}
        {shown.map((message, index) => {
          const place = places[index]!
          const sending = index >= messages.length
          // A reply shows what it answers unless that is the message right above it.
          const quote = Boolean(message.replyTo) && (sending || messages[index - 1]?.id !== message.replyTo!.id)
          return <Fragment key={message.id}>
            {place.day && <div className="bot-day" role="separator" aria-label={place.day}><span>{place.day}</span></div>}
            {message.author === 'owner'
              ? <OwnerMessage botId={bot.id} message={message} pending={sending} botName={bot.name} quote={quote} starts={place.starts} onReply={sending ? undefined : reply} />
              : <BotMessage bot={bot} message={message} onAction={act} browser={message.id === previewOn ? preview : undefined} quote={quote} starts={place.starts} onReply={reply} />}
            {place.ends && <GroupTime message={message} pending={sending} />}
          </Fragment>
        })}
        {offline
          ? <div className="chat-run-status bot-offline-status" role="status">{OFFLINE_TEXT}</div>
          : working && <div className="chat-run-status" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />{bot.name} is working…{chatChip && <BotChipView chip={{ ...chatChip, live: true }} />}</div>}
        {/* A run still working before its reply: the preview follows it here. */}
        {preview && !previewOn && <div className="bot-browser-live">{preview}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      <div className="chat-input-area bot-input-area">
        {unseen && <button type="button" className="bot-jump" onClick={toEnd}><ArrowDown size={14} aria-hidden />New message</button>}
        {!!pinnedOff.length && <div className="bot-pins" role="status" aria-label="Waiting on you">{pinnedOff.map((item) => <PinnedLine key={item.kind} botId={bot.id} item={item} />)}</div>}
        <ComposerNoticeProvider>
          <ComposerNoticeSource notice={error ? { tone: 'error', title: error, onDismiss: () => useBotsStore.setState({ error: null, errorBotId: null }) } : null} />
          <ComposerNoticeSlot />
          {!!work.length && <ul className="bot-work" aria-label={`${bot.name}'s work`}>{work.map((item) => <WorkLine key={item.id} botId={bot.id} item={item} />)}</ul>}
          {replying && <div className="bot-quote bot-replying" data-author={replying.author} role="status" aria-label={`Replying to ${quoteOwner(replying, bot.name)}: ${quoteLine(replying)}`}>
            <QuoteLine quote={replying} botName={bot.name} />
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
  </ImageGalleryProvider>
}
