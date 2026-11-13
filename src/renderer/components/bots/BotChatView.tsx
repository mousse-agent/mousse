import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowDown, ChevronRight, CircleAlert, Loader2, Reply, Shield, X } from '../../lib/icons'
import type { BotChatMessage, BotChatQuote, BotError, BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_COLOUR_HEX, normalizeBotLook } from '../../../shared/bots/personal/look'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { BotFace } from './face/BotFace'
import { BotSteps } from './BotSteps'
import { BotFilePane, BotFilesProvider, BotMarkdown, BotPathChip } from './BotFiles'
import { BotPictureActions, BotReplyMedia } from './BotReplyMedia'
import { replyImages } from './botReplyImages'
import { BotEmojiButton } from './BotEmoji'
import { BotAskReplies } from './BotAskReplies'
import { BotActivitySticker, BotPresenceLine } from './BotPresence'
import { askAnswerLine } from '../asks/AskCard'
import { BotMenu } from './BotMenu'
import { BotAboutPanel, RUNS_ON_ID } from './BotAboutPanel'
import { BotBrowserPane, BotBrowserPreview } from './BotBrowser'
import { useBotBrowser, useBotBrowserStore } from '../../stores/botBrowserStore'
import { ChatComposer, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../ComposerNotice'
import { botGroupTime, placeMessages } from './messageGroups'
import { chatRows, stepChips, type BotChatRow, type OwnerMarks } from './botChatShape'
import { formatDurationLong, formatWorkedFor } from '../../utils/responseTimeline'
import { ImageGalleryProvider } from '../../chat/components/agent-elements/image-gallery'
import type { LightboxImage } from '../../chat/components/agent-elements/image-lightbox'
import { BotImageFiles, BotMarkdownImage, BotOtherFiles, botFileImageUrl, useFailedFileImages } from './BotImages'
import { botChatImages } from './imageSources'

const EMPTY: BotChatMessage[] = []
const NO_FILES: AttachedFile[] = []
const NO_VOICE: VoiceMessage[] = []
const NO_SKILLS: never[] = []
const NO_MARKS = new Map<string, OwnerMarks>()
/** The chat's turn waits for the internet (its work, if any, says so in the header's list). */
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

/** The quote at the top of a message that answers an earlier one, not the one right above it: who wrote it and its first line. */
export function BotReplyQuote({ botId, quote, botName }: { botId: string; quote: BotChatQuote; botName: string }) {
  return <button type="button" className="bot-quote bot-reply-quote" data-author={quote.author} disabled={quote.gone} onClick={() => void showMessage(botId, quote.id)} aria-label={`Replying to ${quoteOwner(quote, botName)}: ${quoteLine(quote)}`}>
    <QuoteLine quote={quote} botName={botName} />
  </button>
}

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

/** Reply, beside a bubble on hover. */
function ReplyButton({ onReply }: { onReply(): void }) {
  return <button type="button" className="bot-reply-button" aria-label="Reply" title="Reply" onClick={onReply}><Reply size={14} aria-hidden /></button>
}

/** The time in a bubble's corner; "Sending…" while the message is on its way. */
function BubbleTime({ message, pending = false }: { message: BotChatMessage; pending?: boolean }) {
  return pending ? <span className="bot-bubble-time">Sending…</span> : <time className="bot-bubble-time" dateTime={message.at}>{botGroupTime(message.at)}</time>
}

/**
 * How long a bot's reply took: from the message it answers to the reply, when that message is loaded; undefined
 * otherwise.
 */
export function workedMs(message: Pick<BotChatMessage, 'at'>, asked: Pick<BotChatMessage, 'at'> | undefined): number | undefined {
  if (!asked) return undefined
  const ms = Date.parse(message.at) - Date.parse(asked.at)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** "Worked for 32s ›", as under a thread's prompt: the steps of the reply's work fold behind it. */
function WorkedToggle({ ms, open, onToggle }: { ms: number; open: boolean; onToggle(): void }) {
  return <button type="button" className="bot-worked" aria-expanded={open} title={`Worked for ${formatDurationLong(ms)}`} onClick={onToggle}>
    {formatWorkedFor(ms)}
    <ChevronRight size={13} className="bot-worked-chevron" data-open={open || undefined} aria-hidden />
  </button>
}

/** `starts`: the first message of its group, with the group's space above it (messageGroups.ts). `marks`: what the bot's replies left on it. */
interface OwnerMessageProps { botId: string; message: BotChatMessage; pending: boolean; botName: string; quote: boolean; starts: boolean; marks?: OwnerMarks; onReply?(message: BotChatMessage): void }

// Messages render again only when they change: a poll, a live chip or the bot starting work leaves them alone.
const OwnerMessage = memo(function OwnerMessage({ botId, message, pending, botName, quote, starts, marks, onReply }: OwnerMessageProps) {
  const quoted = quote && message.replyTo
  return <article className={`chat-participant-message from-person bot-you${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${pending ? ' is-pending' : ''}`} data-message-id={message.id}>
    {quoted && <BotReplyQuote botId={botId} quote={message.replyTo!} botName={botName} />}
    <div className="bot-you-line">
      {!pending && onReply && <ReplyButton onReply={() => onReply(message)} />}
      {/* As in a messaging app: the pictures first, the words under them, then any other files. */}
      <div className="bot-you-content">
        {!!message.attachments?.length && <BotImageFiles files={message.attachments} />}
        {message.text && <div className="bot-you-bubble">
          <MarkdownPreview value={message.text} className="chat-message-markdown chat-markdown" renderImage={BotMarkdownImage} />
          <BubbleTime message={message} pending={pending} />
          {marks?.reaction && <span className="bot-reaction" role="img" aria-label={`${botName} reacted ${marks.reaction}`} title={marks.title}>{marks.reaction}</span>}
        </div>}
        {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
        {!message.text && <BubbleTime message={message} pending={pending} />}
      </div>
    </div>
    {marks?.passedOn && <p className="bot-receipt" title={marks.title}>Passed on</p>}
  </article>
})

/** A bot message uses only the bot's id, name and look, so a change of its state does not render it again. */
const sameBotMessage = (a: BotMessageProps, b: BotMessageProps) => a.message === b.message && a.asked === b.asked && a.onAction === b.onAction && a.browser === b.browser &&
  a.quote === b.quote && a.starts === b.starts && a.onReply === b.onReply &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name

/**
 * `browser`: the live preview of the bot's browser, on the reply of the last run that used it. `quote`: show the
 * message this one answers (it is not the one right above). `starts`: the first of its group, with the group's space
 * above it. `asked`: the message it answers, when loaded (how long it took).
 */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; browser?: ReactNode; quote: boolean; starts: boolean; onReply(message: BotChatMessage): void; asked?: BotChatMessage }

/**
 * A bot's message as a messenger shows it in a one-to-one chat: a bubble on the left, with no face or name (the header
 * says who it is), the time in its corner. A report reads as any reply that quotes the request; a list of keys and
 * values reads as a small card; the files it names are chips. What its work did folds behind "Worked for". An open ask
 * is quick replies under the bubble.
 */
const BotMessage = memo(function BotMessage({ bot, message, onAction, browser, quote, starts, onReply, asked }: BotMessageProps) {
  const store = useBotsStore.getState
  const quoted = quote && message.replyTo
  const [stepsOpen, setStepsOpen] = useState(false)
  const steps = stepChips(message.chips)
  const openAsk = message.ask?.status === 'open' ? message.ask : undefined
  // Its pictures show above its words, as a messenger's image message; the words keep the rest.
  const media = useMemo(() => replyImages(message), [message])
  // A picture that can't be read is no picture: it shows as its file's chip only (in the words, or under them).
  const failed = useFailedFileImages(media.images.flatMap((image) => (image.path ? [image.path] : [])))
  const shownImages = failed.size ? media.images.filter((image) => !image.path || !failed.has(image.path)) : media.images
  const lostChips = failed.size ? media.images.filter((image) => image.path && failed.has(image.path) && !image.chip) : []
  const pictures = shownImages.length > 0
  // The time and the steps behind it: "Worked for 32s" only when it is known how long it took; no line without it.
  const ms = workedMs(message, asked)
  return <article className={`chat-participant-message from-agent bot-message${starts ? ' is-group-start' : ''}`} data-message-id={message.id}>
    <div className="bot-message-line">
      <div className={`bot-bubble${pictures ? ' has-media' : ''}${pictures && !media.text && !lostChips.length ? ' is-media-only' : ''}`}>
        {quoted && <BotReplyQuote botId={bot.id} quote={message.replyTo!} botName={bot.name} />}
        <BotReplyMedia images={shownImages} />
        {media.text && <BotMarkdown text={media.text} className="bot-markdown" />}
        {lostChips.length > 0 && <p className="bot-picture-chips">{lostChips.map((image) => <BotPathChip key={image.key} path={image.path!} />)}</p>}
        {openAsk && <p className="bot-bubble-ask"><Shield size={14} aria-hidden /><span>Wants to <strong>{openAsk.title}</strong></span></p>}
        {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
        {message.error && <BotErrorLine error={message.error} onAction={onAction} />}
        {stepsOpen && <BotSteps chips={steps} />}
        <div className="bot-bubble-foot">
          {steps.length > 0 && ms !== undefined && <WorkedToggle ms={ms} open={stepsOpen} onToggle={() => setStepsOpen((open) => !open)} />}
          <BubbleTime message={message} />
        </div>
      </div>
      <ReplyButton onReply={() => onReply(message)} />
    </div>
    {openAsk && <BotAskReplies ask={openAsk}
      onAnswer={(answer) => store().answer(bot.id, openAsk.askId, answer)}
      onExport={() => store().exportMemory(bot.id, openAsk.askId)} />}
    {browser}
  </article>
}, sameBotMessage)

/** A quiet centred line between messages: work the bot started, an ask answered. */
function SystemLine({ row }: { row: Extract<BotChatRow, { kind: 'system' }> }) {
  return <p className="bot-system-line" role="note" {...(row.title ? { title: row.title } : {})}><span>{row.text}</span></p>
}

/**
 * While the chat's turn runs: the bot's next message, typing, as a messaging app shows it: three dots in a small bubble
 * in the bot's column, the only thing in the chat that moves. Waiting for the internet, it says so instead, still.
 */
function BotTyping({ bot, starts, offline }: { bot: BotSummary; starts: boolean; offline: boolean }) {
  return <article className={`chat-participant-message from-agent bot-message bot-typing${starts ? ' is-group-start' : ''}`} role="status" aria-label={offline ? OFFLINE_TEXT : `${bot.name} is typing`}>
    <div className="bot-message-line">
      {offline
        ? <p className="bot-bubble bot-status-line">{OFFLINE_TEXT}</p>
        : <span className="bot-bubble bot-typing-bubble" aria-hidden><i /><i /><i /></span>}
    </div>
  </article>
}

/**
 * A bot's chat (bot-ui §4.4), as a one-to-one messenger: the header with its face, its name and its presence ("typing…",
 * "busy with 2 things", which opens its work, "free"); the owner's bubbles on the right and the bot's on the left, each
 * with its time; quiet lines for work it started and asks answered; a typing bubble while its chat turn runs; the files
 * it names, opened in the Files pane; and the thread composer without a thread's run settings: text, emoji, attach
 * (also by dropping or pasting), dictation (also while it works), and send or Stop.
 */
export function BotChatView({ bot }: { bot: BotSummary }) {
  const chat = useBotsStore((s) => s.chats[bot.id])
  const load = useBotsStore((s) => s.chatLoad[bot.id])
  const pending = useBotsStore((s) => s.pending[bot.id] ?? EMPTY)
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
  // The chat's own turn: its typing bubble and Stop. Work beside it is in the header's list, and the chat stays free.
  // A service from before work (no `chat` or `work` in its summary) says only that the bot works: that is the chat's.
  const legacy = bot.chat === undefined && bot.work === undefined
  const working = Boolean(bot.chat) || (legacy && bot.state === 'working')
  // The chat's turn waits for the internet: no dots, and it says so.
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const typing = working && !offline
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  const files = attachments ?? NO_FILES
  // The rows: messages, and quiet lines for work started and asks answered; what replies left on the owner's messages.
  const { rows, marks } = useMemo(() => chatRows(messages, bot.name, (message) => (message.ask ? askAnswerLine(message.ask, message.kind === 'notice') : undefined)), [messages, bot.name])
  // The sent rows and the messages on their way, in one run of groups (a quiet line ends a group), with the day lines.
  const shown = useMemo<BotChatRow[]>(() => (pending.length ? [...rows, ...pending.map((message) => ({ kind: 'message' as const, message }))] : rows), [rows, pending])
  const places = useMemo(() => placeMessages(shown.map((row) => (row.kind === 'message' ? row.message : { author: 'system', at: row.at }))), [shown])
  // The message each reply answers, for how long its work took.
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  // A file a chip opened, in the Files pane beside the chat. Opening one closes About and the browser's split view.
  const [file, setFile] = useState<string | null>(null)
  const openFile = useCallback((path: string) => {
    setFile(path)
    useBotsStore.setState({ aboutOpen: false })
    useBotBrowserStore.getState().closePane()
  }, [])
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
  }, [firstId, lastSeq, messages, pending.length, working, offline, replying?.id])
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
  const chatImages = () => botChatImages([...messages, ...pending], botFileImageUrl)
  const composerField = useCallback(() => document.querySelector<HTMLTextAreaElement>('.bot-input-area textarea'), [])
  // The typing bubble is the bot's next message: it joins the group of the bot's message right above it.
  const last = shown.at(-1)
  const typingStarts = !(last?.kind === 'message' && last.message.author === 'bot')
  const toggleAbout = () => useBotsStore.setState({ aboutOpen: !aboutOpen })
  // An action on a file that the computer refused ("That file does not exist.") is said above the composer.
  const fileFailed = useCallback((text: string) => useBotsStore.setState({ error: text, errorBotId: bot.id }), [bot.id])
  const pictureActions = useCallback((image: LightboxImage) => <BotPictureActions image={image} />, [])

  return <BotFilesProvider botId={bot.id} open={openFile} failed={fileFailed}><ImageGalleryProvider images={chatImages} actions={pictureActions}>
    {/* The bot's colour tints the quotes of its messages. */}
    <section className={`chat-conversation bot-conversation${typing ? ' is-typing' : ''}`} style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={toggleAbout}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={32} view="head" />
          <BotActivitySticker bot={bot} typing={typing} offline={offline} />
        </button>
        <div className="bot-header-who">
          <button type="button" className="bot-header-name" tabIndex={-1} aria-hidden onClick={toggleAbout}><h1>{bot.name}</h1></button>
          <BotPresenceLine bot={bot} typing={typing} offline={offline} />
        </div>
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
        {shown.map((row, index) => {
          const place = places[index]!
          const day = place.day && <div className="bot-day" role="separator" aria-label={place.day}><span>{place.day}</span></div>
          if (row.kind === 'system') return <Fragment key={row.id}>{day}<SystemLine row={row} /></Fragment>
          const message = row.message
          const sending = index >= rows.length
          // A reply shows what it answers unless that is the message right above it.
          const above = shown[index - 1]
          const quote = Boolean(message.replyTo) && (sending || !(above?.kind === 'message' && above.message.id === message.replyTo!.id))
          return <Fragment key={message.id}>
            {day}
            {message.author === 'owner'
              ? <OwnerMessage botId={bot.id} message={message} pending={sending} botName={bot.name} quote={quote} starts={place.starts} marks={(marks ?? NO_MARKS).get(message.id)} onReply={sending ? undefined : reply} />
              : <BotMessage bot={bot} message={message} onAction={act} browser={message.id === previewOn ? preview : undefined} quote={quote} starts={place.starts} onReply={reply}
                asked={message.replyTo ? byId.get(message.replyTo.id) : undefined} />}
          </Fragment>
        })}
        {(working || offline) && <BotTyping bot={bot} starts={typingStarts} offline={offline} />}
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
            dictateWhileStoppable
            extraActions={<BotEmojiButton field={composerField} value={draft} onChange={(value) => store().setDraft(bot.id, value)} />}
            onSend={() => void store().send(bot.id)}
            onStop={() => void store().stop(bot.id)}
            lastPrompt={lastPrompt}
          />
        </ComposerNoticeProvider>
      </div>
    </section>
    {file && <BotFilePane botId={bot.id} path={file} onClose={() => setFile(null)} />}
    {paneOpen && browser && <BotBrowserPane bot={bot} view={browser} />}
    {aboutOpen && <BotAboutPanel bot={bot} />}
  </ImageGalleryProvider></BotFilesProvider>
}
