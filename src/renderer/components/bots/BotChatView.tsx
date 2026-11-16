import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ArrowDown, Brain, ChevronRight, CircleAlert, Loader2, Reply, Shield, X } from '../../lib/icons'
import { withAppletNames, type BotChatApplet, type BotChatMessage, type BotChatQuote, type BotError, type BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_COLOUR_HEX, normalizeBotLook } from '../../../shared/bots/personal/look'
import { plainCards } from '../../../shared/bots/personal/cards'
import { MAX_BOT_CHAT_TEXT } from '../../../shared/bots/personal/methods'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { Markdown } from '../../chat/components/agent-elements/markdown'
import { CopyButton } from '../../chat/components/agent-elements/copy-button'
import { ReadAloudButton } from '../../readAloud/ReadAloudButton'
import { useMotionScale } from '../../lib/motion'
import { BotFace } from './face/BotFace'
import { BotSteps } from './BotSteps'
import { BOT_IMAGES, BotFilePane, BotFilesProvider, BotMarkdown, BotPathChip, fileActions } from './BotFiles'
import { BotAppletPane, BotMessageApplets } from './BotApplets'
import { BotPictureActions, BotReplyMedia } from './BotReplyMedia'
import { BotReactionBadge, BotReactionBar } from './BotReactions'
import { replyImages } from './botReplyImages'
import { BotEmojiButton } from './BotEmoji'
import { BotAskReplies } from './BotAskReplies'
import { BotReminderReplies } from './BotReminderReplies'
import { BotQuestionReplies } from './BotQuestionReplies'
import { BotCards, galleryPaths } from './BotCards'
import { BotActivitySticker, BotPresenceLine } from './BotPresence'
import { askAnswerLine } from '../asks/AskCard'
import { BotMenu } from './BotMenu'
import { BotAboutPanel, RUNS_ON_ID } from './BotAboutPanel'
import { BotMemoryDialog } from './BotMemoryDialog'
import { BotBrowserPane, BotBrowserPreview } from './BotBrowser'
import { useBotBrowser, useBotBrowserStore } from '../../stores/botBrowserStore'
import { ChatComposer, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../ComposerNotice'
import { botGroupTime, placeMessages } from './messageGroups'
import { chatRows, withNotes, type BotChatRow, type OwnerMarks } from './botChatShape'
import { BOT_CHAT_WINDOW_STEP, rowIndex, rowKey, windowStart } from './botChatWindow'
import { botCommandSuggestions } from './botCommands'
import { slotModels, submitBotChat } from './runBotCommand'
import type { BotLocalNote } from '../../stores/botsStore'
import { formatDurationLong, formatWorkedFor } from '../../utils/responseTimeline'
import { WithSentQuotes } from '../QuotePill'
import { ImageGalleryProvider } from '../../chat/components/agent-elements/image-gallery'
import type { LightboxImage } from '../../chat/components/agent-elements/image-lightbox'
import { BotImageFiles, BotOtherFiles, botFileImageUrl, useFailedFileImages } from './BotImages'
import { botChatImages } from './imageSources'
import type { RevealNavigation } from '../../chat/components/agent-elements/find/reveal'
import { useBotChatFind } from './useBotChatFind'
import { FindInThreadBar } from '../../chat/components/agent-elements/find/FindInThreadBar'

const EMPTY: BotChatMessage[] = []
const NO_FILES: AttachedFile[] = []
const NO_VOICE: VoiceMessage[] = []
const NO_SKILLS: never[] = []
const NO_MARKS = new Map<string, OwnerMarks>()
const NO_NOTES: BotLocalNote[] = []
/** The chat's turn waits for the internet (its work, if any, says so in the header's list). */
const OFFLINE_TEXT = 'Waiting for internet'
/** Beside the typing dots until the bot says what it is doing now. */
const WORKING_TEXT = 'Working…'
const ignore = () => {}

/**
 * The one red line of a bot's error, with its one way out (bot-ui §4.9). `settled`: what it said is over (a pause that
 * has ended, or an older line of one that still holds), so it reads quietly, without its button.
 */
export function BotErrorLine({ error, onAction, settled }: { error: BotError; onAction(action: NonNullable<BotError['action']>): void; settled?: boolean }) {
  return <div className={settled ? 'bot-error is-settled' : 'bot-error'} role="status">
    <CircleAlert size={15} aria-hidden /><span>{error.text}</span>
    {error.action && !settled && <button type="button" onClick={() => onAction(error.action!)}>{error.action.label}</button>}
  </div>
}

/**
 * The one chat line whose Resume still works: the newest one of a usage limit, while the bot is paused. Older ones,
 * and every one once the bot runs again (at the reset, or after Resume), are settled.
 */
export function liveResumeLine(messages: readonly BotChatMessage[], bot: Pick<BotSummary, 'state'>): string | undefined {
  if (bot.state !== 'paused') return undefined
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.error?.action?.kind === 'resume') return messages[index]!.id
  return undefined
}

const messageElement = (id: string) => {
  const element = document.querySelector(`.bot-conversation [data-message-id="${CSS.escape(id)}"]`)
  return element instanceof HTMLElement ? element : null
}
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

/** The open chat's way to draw a loaded message above its window (botChatWindow.ts), by bot. */
const revealers = new Map<string, (id: string) => void>()

/** One landing on a message; a newer one (the find bar's next match) makes it stale. As find/reveal.ts passes it. */
type Landing = Pick<RevealNavigation, 'isCurrent'>
const ONLY_LANDING: Landing = { isCurrent: () => true }
/** Frames a message may take to be drawn after it was loaded or the window widened to it. */
const DRAW_FRAMES = 30
/** Space kept above a message scrolled to by `botMessageScroller`. */
const LANDING_MARGIN = 16

/**
 * Draws a message of a bot's open chat and returns its row. A message not loaded yet is loaded first, page by page of
 * older history; one loaded above the rows drawn widens the window to it. Null when the chat no longer has it, or a
 * newer landing took over.
 */
async function drawMessage(botId: string, id: string, landing: Landing = ONLY_LANDING): Promise<HTMLElement | null> {
  let element = messageElement(id)
  if (element) return element
  if (!(await useBotsStore.getState().findMessage(botId, id))) return null
  // The loaded page renders on its own schedule: ask the chat to draw the message until it is drawn (it may not have
  // rendered the page yet when first asked).
  for (let frame = 0; frame < DRAW_FRAMES && !(element = messageElement(id)); frame += 1) {
    if (!landing.isCurrent()) return null
    revealers.get(botId)?.(id)
    await nextFrame()
  }
  return landing.isCurrent() ? element : null
}

/**
 * Brings a message of `botId`'s open chat into view near the transcript's top, drawn first by `drawMessage`; resolves
 * false when it can't. Its shape is find's `scrollToMessage` (`useBotChatFind({ scrollToMessage })`): a chat that
 * draws only its newest rows lands the find bar's matches through it.
 */
export function botMessageScroller(botId: string): (id: string, landing: Landing) => Promise<boolean> {
  return async (id, landing) => {
    const element = await drawMessage(botId, id, landing)
    const lane = element?.closest<HTMLElement>('.chat-transcript')
    if (!element || !lane || !landing.isCurrent()) return false
    lane.scrollTop += element.getBoundingClientRect().top - lane.getBoundingClientRect().top - LANDING_MARGIN
    return true
  }
}

/** Scrolls to a message of the open chat and lights it briefly, drawn first by `drawMessage`; a gone one does nothing. */
async function showMessage(botId: string, id: string): Promise<void> {
  const element = await drawMessage(botId, id)
  if (!element) return
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

/** A message as a reply quote: who wrote it, its applets by name and its first line (as the service quotes it). */
export function quoteOf(message: BotChatMessage): BotChatQuote {
  // Its words without the plain copy of its cards, else its cards as text, as the service quotes it.
  const own = message.plainFrom === undefined ? message.text : message.text.slice(0, message.plainFrom).trimEnd()
  const words = (own || message.error?.text || plainCards(message.cards) || message.attachments?.map((file) => file.name).join(', ') || '').trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  const line = withAppletNames(words, message.applets)
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
function WorkedToggle({ ms, open, onToggle }: { ms?: number; open: boolean; onToggle(): void }) {
  return <button type="button" className="bot-worked" aria-expanded={open} title={ms === undefined ? 'What I did' : `Worked for ${formatDurationLong(ms)}`} onClick={onToggle}>
    {ms === undefined ? 'Steps' : formatWorkedFor(ms)}
    <ChevronRight size={13} className="bot-worked-chevron" data-open={open || undefined} aria-hidden />
  </button>
}

/**
 * `starts`: the first message of its group, with the group's space above it (messageGroups.ts). `time`: shows its time
 * (the last of a run in one minute does). `marks`: what the bot's replies left on it.
 */
interface OwnerMessageProps { botId: string; message: BotChatMessage; pending: boolean; botName: string; quote: boolean; starts: boolean; time: boolean; marks?: OwnerMarks; onReply?(message: BotChatMessage): void }

// Messages render again only when they change: a poll, a live chip or the bot starting work leaves them alone.
const OwnerMessage = memo(function OwnerMessage({ botId, message, pending, botName, quote, starts, time, marks, onReply }: OwnerMessageProps) {
  const quoted = quote && message.replyTo
  return <article className={`chat-participant-message from-person bot-you${starts ? ' is-group-start' : ''}${quoted ? ' is-quoted' : ''}${pending ? ' is-pending' : ''}`} data-message-id={message.id} data-turn-key={message.id}>
    {quoted && <BotReplyQuote botId={botId} quote={message.replyTo!} botName={botName} />}
    <div className="bot-you-line">
      {!pending && onReply && <span className="bot-you-actions">
        {message.text && <CopyButton text={message.text} />}
        <ReplyButton onReply={() => onReply(message)} />
      </span>}
      {/* As in a messaging app: the pictures first, the words under them, then any other files. */}
      <div className="bot-you-content">
        {!!message.attachments?.length && <BotImageFiles files={message.attachments} />}
        {message.text && <div className="bot-you-bubble">
          <div className="bot-find-text" data-find-text data-message-id={message.id} data-part-index="0">
            <WithSentQuotes text={message.text} render={(part) => <Markdown content={part} className="bot-markdown" images={BOT_IMAGES} />} />
          </div>
          {(time || pending) && <BubbleTime message={message} pending={pending} />}
          {marks?.reaction && <span className="bot-reaction" role="img" aria-label={`${botName} reacted ${marks.reaction}`} title={`${botName} reacted`}>{marks.reaction}</span>}
        </div>}
        {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
        {!message.text && (time || pending) && <BubbleTime message={message} pending={pending} />}
      </div>
    </div>
    {marks?.passedOn && <p className="bot-receipt" title={marks.title}>Noted</p>}
  </article>
})

/** A bot message uses only the bot's id, name and look, so a change of its state does not render it again. */
const sameBotMessage = (a: BotMessageProps, b: BotMessageProps) => a.message === b.message && a.asked === b.asked && a.onAction === b.onAction && a.browser === b.browser &&
  a.quote === b.quote && a.starts === b.starts && a.time === b.time && a.onReply === b.onReply && a.onApplet === b.onApplet && a.settled === b.settled &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name

/**
 * `browser`: the live preview of the bot's browser, on the reply of the last run that used it. `quote`: show the
 * message this one answers (it is not the one right above). `starts`: the first of its group, with the group's space
 * above it. `time`: shows its time (the last of a run in one minute does). `asked`: the message it answers, when loaded (how long it took). `onApplet`: opens one of its applets beside
 * the chat.
 */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; settled?: boolean; browser?: ReactNode; quote: boolean; starts: boolean; time: boolean; onReply(message: BotChatMessage): void; asked?: BotChatMessage; onApplet(applet: BotChatApplet): void }

/**
 * A reply's tools hang off its bubble's right edge: beside a wide bubble they move left, inside the transcript. Measured
 * by their contents, which sit where they will show even while the box is still folded (its fold or open can lag the
 * pointer by a frame).
 */
function clampBotTools(element: HTMLElement) {
  const lane = element.closest('.chat-transcript')
  if (!lane || !lane.clientWidth) return
  element.style.removeProperty('--bot-tools-shift')
  const right = Math.max(...Array.from(element.children, (child) => child.getBoundingClientRect().right))
  const over = right - (lane.getBoundingClientRect().left + lane.clientWidth - 8)
  if (over > 0) element.style.setProperty('--bot-tools-shift', `${-Math.ceil(over)}px`)
}

/**
 * Tools left open while the transcript changes width (the pointer still on the reply, the focus in them, the emoji grid
 * open, a reply read aloud) move again, so they never hang past it. Hidden tools take no width and are skipped. They
 * move in the next frame: moving them inside the observer's callback changes the layout it is reporting.
 */
function useReclampOpenTools(transcript: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const lane = transcript.current
    if (!lane || typeof ResizeObserver === 'undefined') return
    let width = lane.clientWidth
    let pending = 0
    const observer = new ResizeObserver(() => {
      if (lane.clientWidth === width || pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        width = lane.clientWidth
        const open = Array.from(lane.querySelectorAll<HTMLElement>('.bot-message-tools')).filter((tools) => tools.getBoundingClientRect().width > 0)
        open.forEach(clampBotTools)
      })
    })
    observer.observe(lane)
    return () => { observer.disconnect(); cancelAnimationFrame(pending) }
  }, [transcript])
}

/**
 * A bot's message as a messenger shows it in a one-to-one chat: a bubble on the left, with no face or name (the header
 * says who it is), the time in its corner. A report reads as any reply that quotes the request; a list of keys and
 * values reads as a small card; the files it names are chips, its pictures a picture message above its words (the
 * ones a tool handed it among them). Every chip of its work folds behind "Worked for", none dropped. Read aloud, Copy and
 * Reply show beside it on hover; its applets sit under it; an open ask is quick replies under it.
 */
const BotMessage = memo(function BotMessage({ bot, message: row, onAction, settled, browser, quote, starts, time, onReply, asked, onApplet }: BotMessageProps) {
  const store = useBotsStore.getState
  // A question's answers are buttons under it, so its words stop where their plain copy starts; a service whose
  // questions can't be answered here keeps that copy, and the owner answers with Reply.
  const canSnooze = useBotsStore((s) => !s.snoozeMissing)
  const canAnswer = useBotsStore((s) => !s.questionsMissing)
  const question = canAnswer ? row.question : undefined
  // Its cards are drawn under its words, so those stop at their plain copy too; the pictures a gallery shows are its
  // files as well (for other devices), which the gallery shows instead of the picture strip above the words.
  const cards = row.cards?.length ? row.cards : undefined
  const message = useMemo(() => {
    if ((!question && !cards) || row.plainFrom === undefined) return row
    const inGallery = galleryPaths(cards)
    const attachments = row.attachments?.filter((file) => !inGallery.has(file.path))
    return { ...row, text: row.text.slice(0, row.plainFrom).trimEnd(), ...(row.attachments ? { attachments } : {}) }
  }, [question, cards, row])
  const quoted = quote && message.replyTo
  const [stepsOpen, setStepsOpen] = useState(false)
  const steps = message.chips
  // This turn saved something to memory (its "remembered" chip): a tag under the bubble opens it in Memory.
  const saved = steps.find((chip) => chip.icon === 'memory' && chip.text.startsWith('remembered'))
  const openAsk = message.ask?.status === 'open' ? message.ask : undefined
  // Its pictures show above its words, as a messenger's image message; the words keep the rest.
  const media = useMemo(() => replyImages(message), [message])
  // A picture that can't be read is no picture: it shows as its file's chip only (in the words, or under them).
  const failed = useFailedFileImages(media.images.flatMap((image) => (image.path ? [image.path] : [])))
  const shownImages = failed.size ? media.images.filter((image) => !image.path || !failed.has(image.path)) : media.images
  const lostChips = failed.size ? media.images.filter((image) => image.path && failed.has(image.path) && !image.chip) : []
  const pictures = shownImages.length > 0
  // The steps behind one quiet line: "Worked for 32s" when it is known how long it took, else "Steps", never dropped.
  const ms = workedMs(message, asked)
  // The owner's reaction: one per message, set, replaced or removed here; the bot is told on its next chat turn.
  const react = (emoji: string | null) => void store().react(bot.id, message.id, emoji)
  // After a pick the bar goes, and stays gone while the pointer stays on the message; the focus goes to the bubble.
  const [reacted, setReacted] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const picked = () => {
    setReacted(true)
    bubble.current?.focus({ preventScroll: true })
  }
  // A service without reactions (an older one) shows no bar.
  const canReact = useBotsStore((s) => !s.reactionsMissing)
  // While a picture's menu is open, the tools beside the bubble step aside for it.
  const [menuOpen, setMenuOpen] = useState(false)
  // The tools hang off the bubble's right edge: beside a wide bubble they move left, inside the transcript.
  const tools = useRef<HTMLSpanElement>(null)
  const clampTools = () => { if (tools.current) clampBotTools(tools.current) }
  return <article className={`chat-participant-message from-agent bot-message${starts ? ' is-group-start' : ''}${reacted ? ' is-react-quiet' : ''}${message.reaction ? ' has-reaction' : ''}${menuOpen ? ' is-menu-open' : ''}`} data-message-id={message.id} data-turn-key={message.id}
    onMouseEnter={clampTools} onFocus={clampTools} onMouseLeave={reacted ? () => setReacted(false) : undefined}>
    <div className="bot-message-line">
      <div ref={bubble} tabIndex={-1} className={`bot-bubble${pictures ? ' has-media' : ''}${pictures && !media.text && !lostChips.length && !cards ? ' is-media-only' : ''}`}>
        {quoted && <BotReplyQuote botId={bot.id} quote={message.replyTo!} botName={bot.name} />}
        <BotReplyMedia images={shownImages} onMenuOpen={setMenuOpen} />
        {message.actionSentAt ? <p className="bot-question-settled" role="note">Sent · <time dateTime={message.actionSentAt}>{botGroupTime(message.actionSentAt)}</time></p> : media.text && <div className="bot-find-text" data-find-text data-message-id={message.id} data-part-index="0"><BotMarkdown text={media.text} className="bot-markdown" /></div>}
        {cards && <BotCards cards={cards} botId={bot.id} />}
        {lostChips.length > 0 && <p className="bot-picture-chips">{lostChips.map((image) => <BotPathChip key={image.key} path={image.path!} />)}</p>}
        {openAsk && <p className="bot-bubble-ask"><Shield size={14} aria-hidden /><span>Wants to <strong>{openAsk.title}</strong></span></p>}
        {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
        {message.error && <BotErrorLine error={message.error} onAction={onAction} settled={settled} />}
        {stepsOpen && <BotSteps chips={steps} />}
        {(steps.length > 0 || time) && <div className="bot-bubble-foot">
          {steps.length > 0 && <WorkedToggle ms={ms} open={stepsOpen} onToggle={() => setStepsOpen((open) => !open)} />}
          {time && <BubbleTime message={message} />}
        </div>}
        {message.reaction && <BotReactionBadge emoji={message.reaction} onRemove={() => react(null)} />}
      </div>
      {/* As beside a thread's reply: read it aloud, copy it as written, reply to it. Anchored to the bubble's lower
          right edge and taking no width of its own, so the bubble is as wide with them as without. */}
      <span ref={tools} className="bot-message-tools">
        {canReact && <BotReactionBar current={message.reaction} onReact={react} onPicked={picked} onFocus={() => setReacted(false)} />}
        <span className="bot-message-actions">
          {message.text && <ReadAloudButton speechKey={`bot:${message.id}`} markdown={message.text} />}
          {/* Copy takes its cards too, as text. */}
          {(cards ? row.text : message.text) && <CopyButton text={cards ? row.text : message.text} />}
          <ReplyButton onReply={() => onReply(message)} />
        </span>
      </span>
    </div>
    {saved && <button type="button" className="bot-memory-tag" title="Open it in Memory" onClick={() => store().openMemory(bot.id, saved.title?.startsWith('Put away:\n') ? saved.highlight?.replace(/ · put away \d+$/, '') : saved.highlight)}>
      <Brain size={12} aria-hidden />Saved to memory
    </button>}
    {!!message.applets?.length && <BotMessageApplets botId={bot.id} applets={message.applets} onOpen={onApplet} message={message} onReply={onReply} />}
    {openAsk && <BotAskReplies ask={openAsk}
      onAnswer={async (answer) => {
        await store().answer(bot.id, openAsk.askId, answer)
        // The service refused it ("Allow this on the computer."): Allow stays off, with why.
        const after = useBotsStore.getState()
        return after.errorBotId === bot.id && after.error ? after.error : undefined
      }}
      onExport={() => store().exportMemory(bot.id, openAsk.askId)} />}
    {canSnooze && message.reminder && <BotReminderReplies reminder={message.reminder}
      onSnooze={(choice) => store().snoozeReminder(bot.id, message.id, choice)} />}
    {question && <BotQuestionReplies question={question}
      onAnswer={(choice) => store().answerQuestion(bot.id, question.questionId, choice)}
      onOther={() => onReply(row)} />}
    {browser}
  </article>
}, sameBotMessage)

/** A quiet centred line between messages: work the bot started, an ask answered, a `/` command's result. */
function SystemLine({ row }: { row: Extract<BotChatRow, { kind: 'system' }> }) {
  // A line standing in for a message (a tapped answer) carries its id, so a quote of that message scrolls to it.
  const className = `bot-system-line${row.note ? ' is-note' : ''}${row.note === 'error' ? ' is-error' : ''}`
  return <p className={className} role={row.note === 'error' ? 'alert' : 'note'} {...(row.title ? { title: row.title } : {})} {...(row.of ? { 'data-message-id': row.of } : {})}><span>{row.text}</span></p>
}

/**
 * While the chat's turn runs: the bot's next message, typing, as a messaging app shows it: three dots in a small bubble
 * in the bot's column, the only thing in the chat that moves, and beside them what the bot said it is doing now (its
 * latest line before a step), in full, or "Working…" until it says. Waiting for the internet, it says so instead, still.
 */
function BotTyping({ bot, starts, offline, status }: { bot: BotSummary; starts: boolean; offline: boolean; status?: string }) {
  const doing = status || WORKING_TEXT
  return <article className={`chat-participant-message from-agent bot-message bot-typing${starts ? ' is-group-start' : ''}`} role="status" aria-label={offline ? OFFLINE_TEXT : `${bot.name}: ${doing}`}>
    <div className="bot-message-line">
      {offline
        ? <p className="bot-bubble bot-status-line">{OFFLINE_TEXT}</p>
        : <TypingDots status={doing} />}
    </div>
  </article>
}

/** One rise and fall of the dots, and of the status's shimmer. */
const TYPING_CYCLE_MS = 1200
/** Each dot starts this long after the one before it. */
const TYPING_DOT_STEP_MS = 150
/** One dot's rise and fade; it peaks 30% into its cycle. */
const TYPING_DOT: Keyframe[] = [
  { offset: 0, opacity: 0.35, transform: 'none', easing: 'ease-in-out' },
  { offset: 0.3, opacity: 0.9, transform: 'translateY(-2px)', easing: 'ease-in-out' },
  { offset: 0.6, opacity: 0.35, transform: 'none', easing: 'ease-in-out' },
  { offset: 1, opacity: 0.35, transform: 'none' },
]

/**
 * The status's shimmer: a bright copy of the words, seen through a soft band (`.bot-typing-glint`, as wide as the words,
 * its mask bright in its middle), crosses them once a cycle: the band moves from one width left of them to one width
 * right, and the copy inside it the other way, so its letters stay on the words'. Its middle reaches the words' first
 * letter a quarter into its cycle and their end three quarters in. Both are transforms, run by the compositor.
 */
const TYPING_GLINT: Keyframe[] = [
  { offset: 0, transform: 'translateX(-100%)', easing: 'linear' },
  { offset: 1, transform: 'translateX(100%)' }
]
const TYPING_GLINT_COPY: Keyframe[] = [
  { offset: 0, transform: 'translateX(100%)', easing: 'linear' },
  { offset: 1, transform: 'translateX(-100%)' }
]
/**
 * When the shimmer starts, so the band reaches the words as the wave would: the last dot peaks 30% into its cycle, and
 * the words begin about one dot step after it (the gap after the dots). The band's middle reaches them a quarter into
 * its own cycle.
 */
const TYPING_SHIMMER_DELAY_MS = 2 * TYPING_DOT_STEP_MS + 0.3 * TYPING_CYCLE_MS + TYPING_DOT_STEP_MS - 0.25 * TYPING_CYCLE_MS

/**
 * The typing dots move smoothly, every frame, on the compositor (opacity and transform only). They are Web Animations
 * rather than a CSS loop for the reason Turning gives (lib/turning.tsx): a repeating CSS animation wakes the main thread
 * at every iteration because React listens for `animationiteration`. The status's shimmer is transforms too. With
 * Animation speed Off or reduced motion all of it stays still, and the words are plain.
 */
function TypingDots({ status }: { status: string }) {
  const dotsRef = useRef<HTMLSpanElement>(null)
  const glintRef = useRef<HTMLSpanElement>(null)
  const still = useMotionScale() === 0
  useLayoutEffect(() => {
    if (still) return
    const dots = Array.from(dotsRef.current?.children ?? [])
    const animations = dots.flatMap((dot, at) => typeof dot.animate === 'function'
      ? [dot.animate(TYPING_DOT, { duration: TYPING_CYCLE_MS, delay: at * TYPING_DOT_STEP_MS, iterations: Infinity })]
      : [])
    return () => animations.forEach((animation) => animation.cancel())
  }, [still])
  useLayoutEffect(() => {
    const glint = glintRef.current
    const copy = glint?.firstElementChild
    if (still || !glint || !copy || typeof glint.animate !== 'function') return
    const timing: KeyframeAnimationOptions = { duration: TYPING_CYCLE_MS, delay: TYPING_SHIMMER_DELAY_MS, iterations: Infinity, fill: 'backwards' }
    const shimmer = [glint.animate(TYPING_GLINT, timing), copy.animate(TYPING_GLINT_COPY, timing)]
    // On the dots' clock, so the wave that crosses them runs on into the words. Dots started in this same frame have no
    // start time yet: all of them then start together.
    const lead = dotsRef.current?.firstElementChild?.getAnimations?.()[0]
    if (lead?.startTime !== null && lead?.startTime !== undefined) for (const animation of shimmer) animation.startTime = lead.startTime
    return () => shimmer.forEach((animation) => animation.cancel())
  }, [still])
  return <span className={`bot-bubble bot-typing-bubble${still ? ' is-still' : ''}`}>
    <span ref={dotsRef} className="bot-typing-dots" aria-hidden><i /><i /><i /></span>
    <span className="bot-typing-status">
      {status}
      {!still && <span ref={glintRef} className="bot-typing-glint" aria-hidden><span>{status}</span></span>}
    </span>
  </span>
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
  const memoryOpen = useBotsStore((s) => (s.memoryOpen?.botId === bot.id ? s.memoryOpen : null))
  // Another bot's error stays with that bot's chat.
  const error = useBotsStore((s) => (s.errorBotId === bot.id ? s.error : null))
  const store = useBotsStore.getState
  const transcript = useRef<HTMLDivElement>(null)
  useReclampOpenTools(transcript)
  const messages = chat?.messages ?? EMPTY
  // The chat's own turn: its typing bubble and Stop. Work beside it is in the header's list, and the chat stays free.
  // A service from before work (no `chat`, `work` or `threads` in its summary) says only that the bot works: that is
  // the chat's. A bot that only manages threads it started is not typing.
  const legacy = bot.chat === undefined && bot.work === undefined && bot.threads === undefined
  const working = Boolean(bot.chat) || (legacy && bot.state === 'working')
  // The chat's turn waits for the internet: no dots, and it says so.
  const offline = bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet'
  const typing = working && !offline
  // What the chat's turn said it is doing now; a service from before work: what the bot's working activation said.
  const status = useBotsStore((s) => {
    const activationId = bot.chat?.activationId ?? (legacy ? s.live[bot.id]?.activationId : undefined)
    return activationId ? s.statuses[activationId] : undefined
  })
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  const files = attachments ?? NO_FILES
  // The rows: messages, and quiet lines for work started and asks answered; what replies left on the owner's messages.
  // The lines of the owner's `/` commands go among them by time; they are this window's only, never the bot's.
  const notes = useBotsStore((s) => s.notes[bot.id] ?? NO_NOTES)
  const { rows, marks } = useMemo(() => {
    const shaped = chatRows(messages, bot.name, (message) => (message.ask ? askAnswerLine(message.ask, message.kind === 'notice') : undefined))
    return { rows: withNotes(shaped.rows, notes), marks: shaped.marks }
  }, [messages, bot.name, notes])
  // The sent rows and the messages on their way, in one run of groups (a quiet line ends a group), with the day lines.
  const shown = useMemo<BotChatRow[]>(() => (pending.length ? [...rows, ...pending.map((message) => ({ kind: 'message' as const, message }))] : rows), [rows, pending])
  const places = useMemo(() => placeMessages(shown.map((row, index) => (row.kind === 'message' ? { author: row.message.author, at: row.message.at, sending: index >= rows.length } : { author: 'system', at: row.at }))), [shown, rows.length])
  // Only the newest rows are drawn (botChatWindow.ts). `from`: the first row drawn while the reader is away from the
  // end; without it, the newest rows. `revealOlder`: a page asked for at the window's top shows once it arrives.
  const [from, setFrom] = useState<string | undefined>(undefined)
  const start = windowStart(shown, from)
  const firstShown = shown[start] ? rowKey(shown[start]!) : undefined
  const revealOlder = useRef(false)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const fromRef = useRef(from)
  fromRef.current = from
  useLayoutEffect(() => {
    if (!revealOlder.current || !firstId) return
    revealOlder.current = false
    if (shown[0]) setFrom(rowKey(shown[0]))
  }, [firstId, shown])
  // A quote's message above the window is drawn, with every row after it.
  useEffect(() => {
    revealers.set(bot.id, (id) => {
      const rows = shownRef.current
      const index = rowIndex(rows, id)
      if (index >= 0 && index < windowStart(rows, fromRef.current)) setFrom(rowKey(rows[index]!))
    })
    return () => { revealers.delete(bot.id) }
  }, [bot.id])
  // The message each reply answers, for how long its work took.
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  // A file a chip opened, in the Files pane beside the chat. Opening one closes About and the browser's split view.
  const [file, setFile] = useState<string | null>(null)
  // An applet opened beside the chat, from its name.
  const [appletOpen, setAppletOpen] = useState<BotChatApplet | null>(null)
  useEffect(() => { setAppletOpen(null) }, [bot.id])
  const openApplet = useCallback((applet: BotChatApplet) => {
    setAppletOpen(applet)
    setFile(null)
  }, [])
  // An action on a file that the computer refused ("Can't find notes.md…") is said above the composer.
  const fileFailed = useCallback((text: string) => useBotsStore.setState({ error: text, errorBotId: bot.id }), [bot.id])
  // A chip's click: a file shows in the pane, a folder opens in the file manager, one that is gone is said.
  const openFile = useCallback((path: string) => fileActions.open(path, (shown) => {
    setFile(shown)
    useBotsStore.setState({ aboutOpen: false })
    useBotBrowserStore.getState().closePane()
  }, fileFailed), [fileFailed])
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
  useEffect(() => {
    const readVisible = (): void => {
      if (lastSeq !== undefined && document.visibilityState === 'visible' && document.hasFocus()) store().markRead(bot.id)
    }
    readVisible()
    window.addEventListener('focus', readVisible)
    document.addEventListener('visibilitychange', readVisible)
    return () => {
      window.removeEventListener('focus', readVisible)
      document.removeEventListener('visibilitychange', readVisible)
    }
  }, [bot.id, lastSeq, store])

  // New messages keep the end in view; a page loaded above keeps the reader where they were. A message the owner sends
  // from here always goes to the end, as in a messenger.
  // Scrolled up, a new message from the bot leaves the reader where they are; Go to latest shows while scrolled up, and
  // says New message once one has come in. `heading`: on the way to the end after Go to latest, so the smooth scroll's
  // own steps don't bring the button back. `top`: where the last scroll left it.
  const anchor = useRef<{ firstId?: string; lastSeq?: number; height: number; atEnd: boolean; sent: number; heading?: boolean; top?: number }>({ height: 0, atEnd: true, sent: 0 })
  const [unseen, setUnseen] = useState(false)
  const [away, setAway] = useState(false)
  useLayoutEffect(() => {
    const element = transcript.current
    if (!element) return
    const held = anchor.current
    const sent = pending.length > held.sent
    if (sent) {
      held.atEnd = true
      setAway(false)
      setUnseen(false)
    }
    if (held.firstId && firstShown !== held.firstId && !held.atEnd) element.scrollTop += element.scrollHeight - held.height
    else if (held.atEnd) element.scrollTop = element.scrollHeight
    if (!held.atEnd && held.lastSeq !== undefined && lastSeq !== undefined && lastSeq > held.lastSeq && messages.at(-1)?.author === 'bot') setUnseen(true)
    anchor.current = { firstId: firstShown, lastSeq, height: element.scrollHeight, atEnd: held.atEnd, sent: pending.length, heading: held.heading, top: held.top }
  }, [firstShown, lastSeq, messages, pending.length, working, offline, replying?.id])
  useEffect(() => {
    anchor.current = { lastSeq: anchor.current.lastSeq, height: 0, atEnd: true, sent: anchor.current.sent }
    setUnseen(false)
    setAway(false)
  }, [bot.id])
  const toEnd = () => {
    const element = transcript.current
    if (element?.scrollTo) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else if (element) element.scrollTop = element.scrollHeight
    anchor.current.atEnd = true
    anchor.current.heading = true
    setUnseen(false)
    setAway(false)
  }
  // A pinned line hides while its full message is on screen, so it never shows twice.
  const pinned = useMemo(() => pinnedOf(messages, bot), [messages, bot])
  const resumeOn = useMemo(() => liveResumeLine(messages, bot), [messages, bot])
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
  // Find in chat: a match shown stops the chat following its end, as a scroll up does.
  const scrollToFound = useMemo(() => botMessageScroller(bot.id), [bot.id])
  const find = useBotChatFind({
    botId: bot.id,
    rows: shown,
    transcript,
    hasMore: Boolean(chat?.hasMore),
    // The chat draws only its newest rows: a match further back is drawn first, then scrolled to.
    scrollToMessage: scrollToFound,
    onNavigate: () => {
      anchor.current.atEnd = false
      anchor.current.heading = false
    }
  })

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
  const pictureActions = useCallback((image: LightboxImage) => <BotPictureActions image={image} />, [])
  // `/` commands: the list follows what is typed; after `/model` it offers the bot's slots and models, read once.
  const modelInfo = useBotsStore((s) => s.modelInfo[bot.id])
  const wantsModels = /^\/model\s/i.test(draft)
  useEffect(() => { if (wantsModels && !modelInfo) void store().loadModelInfo(bot.id) }, [wantsModels, modelInfo, bot.id, store])
  const commandSuggestions = useCallback((input: string) => botCommandSuggestions(input, {
    ...(modelInfo?.custom ? { custom: modelInfo.custom } : {}),
    slotModels: slotModels(modelInfo),
    ...(modelInfo?.providers ? { providers: modelInfo.providers } : {}),
    ...(modelInfo?.imageProviders ? { imageProviders: modelInfo.imageProviders } : {})
  }), [modelInfo])

  return <BotFilesProvider botId={bot.id} open={openFile} failed={fileFailed}><ImageGalleryProvider images={chatImages} actions={pictureActions}>
    {/* The bot's colour tints the quotes of its messages. */}
    <section className={`chat-conversation bot-conversation${typing ? ' is-typing' : ''}`} data-applet-conversation style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
      <header className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={toggleAbout}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={32} view="head" />
          <BotActivitySticker bot={bot} typing={typing} offline={offline} />
        </button>
        <div className="bot-header-who">
          <button type="button" className="bot-header-name" tabIndex={-1} aria-hidden onClick={toggleAbout}><h1>{bot.name}</h1></button>
          <BotPresenceLine bot={bot} typing={typing} offline={offline} />
        </div>
        {/* From the menu, whose item goes as it closes: Escape then gives the focus to the composer. */}
        <BotMenu bot={bot} {...(find.openFind ? { onFind: () => { composerField()?.focus({ preventScroll: true }); find.openFind!() } } : {})} />
      </header>
      {find.barProps && <div className="bot-find-anchor"><FindInThreadBar {...find.barProps} /></div>}
      <div className="chat-transcript" data-applet-scroller data-quote-source ref={transcript} role="log" aria-label={`${bot.name} messages`} onScroll={(event) => {
        const element = event.currentTarget
        const down = element.scrollTop >= (anchor.current.top ?? 0)
        anchor.current.atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        anchor.current.height = element.scrollHeight
        // Reaching the end, or any scroll back up (the reader took over), ends the way to the end.
        if (anchor.current.atEnd || element.scrollTop < (anchor.current.top ?? 0)) anchor.current.heading = false
        anchor.current.top = element.scrollTop
        if (anchor.current.atEnd) setUnseen(false)
        if (!anchor.current.heading) setAway(!anchor.current.atEnd)
        measure()
        // Back at the end, only the newest rows are drawn again; away from it, the rows drawn hold still. A scroll up
        // that starts at the end (to a quote or a find match above) keeps the rows it is heading for.
        if (anchor.current.atEnd && down) setFrom(undefined)
        else if (from === undefined && firstShown !== undefined) setFrom(firstShown)
        // At the top of the rows drawn: the next loaded rows above join them, else the next page is asked for.
        if (element.scrollTop < 60) {
          if (start > 0) setFrom(rowKey(shown[Math.max(0, start - BOT_CHAT_WINDOW_STEP)]!))
          else if (chat?.hasMore) {
            revealOlder.current = true
            void store().loadOlder(bot.id)
          }
        }
      }}>
        {!chat && load === 'loading' && <div className="bot-load-state" role="status"><Loader2 size={14} className="chat-spin" aria-hidden />Loading messages…</div>}
        {!chat && load === 'failed' && <div className="bot-load-state is-failed" role="status">
          <span>Couldn’t load messages.</span>
          <button type="button" onClick={() => void store().loadChat(bot.id)}>Retry</button>
        </div>}
        {chat?.loadingOlder && <p className="chat-empty-hint bot-loading-older">Loading earlier messages…</p>}
        {shown.slice(start).map((row, drawn) => {
          const index = start + drawn
          const place = places[index]!
          const day = place.day && <div className="bot-day" role="separator" aria-label={place.day}><span>{place.day}</span></div>
          if (row.kind === 'system') return <Fragment key={row.id}>{day}<SystemLine row={row} /></Fragment>
          const message = row.message
          const sending = index >= rows.length
          // A reply shows what it answers unless that is the message right above it.
          const above = shown[index - 1]
          const quote = Boolean(message.replyTo) && (sending || !((above?.kind === 'message' && above.message.id === message.replyTo!.id) || (above?.kind === 'system' && above.of === message.replyTo!.id)))
          return <Fragment key={message.id}>
            {day}
            {message.author === 'owner'
              ? <OwnerMessage botId={bot.id} message={message} pending={sending} botName={bot.name} quote={quote} starts={place.starts} time={place.time} marks={(marks ?? NO_MARKS).get(message.id)} onReply={sending ? undefined : reply} />
              : <BotMessage bot={bot} message={message} onAction={act} settled={message.error?.action?.kind === 'resume' && message.id !== resumeOn} browser={message.id === previewOn ? preview : undefined} quote={quote} starts={place.starts} time={place.time} onReply={reply} onApplet={openApplet}
                asked={message.replyTo ? byId.get(message.replyTo.id) : undefined} />}
          </Fragment>
        })}
        {(working || offline) && <BotTyping bot={bot} starts={typingStarts} offline={offline} status={status} />}
        {/* A run still working before its reply: the preview follows it here. */}
        {preview && !previewOn && <div className="bot-browser-live">{preview}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused'}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      <div className="chat-input-area bot-input-area" data-applet-composer>
        {(unseen || away) && <button type="button" className="bot-jump" onClick={toEnd}><ArrowDown size={14} aria-hidden />{unseen ? 'New message' : 'Go to latest'}</button>}
        {!!pinnedOff.length && <div className="bot-pins" role="status" aria-label="Waiting on you">{pinnedOff.map((item) => <PinnedLine key={item.kind} botId={bot.id} item={item} />)}</div>}
        <ComposerNoticeProvider>
          <ComposerNoticeSource notice={error ? { tone: 'error', title: error, onDismiss: () => useBotsStore.setState({ error: null, errorBotId: null }) } : null} />
          <ComposerNoticeSlot />
          {replying && <div className="bot-quote bot-replying" data-author={replying.author} role="status" aria-label={`Replying to ${quoteOwner(replying, bot.name)}: ${quoteLine(replying)}`}>
            <QuoteLine quote={replying} botName={bot.name} />
            <button type="button" aria-label="Don't reply to this message" title="Cancel reply" onClick={() => store().setReplyingTo(bot.id, null)}><X size={14} aria-hidden /></button>
          </div>}
          {/* A bot picks its own model: no model picker, context ring, permission mode or skills. Its `/` commands are
              the owner's, run by Mousse and never sent (runBotCommand.ts). */}
          <ChatComposer
            key={bot.id}
            input={draft}
            onInputChange={(value) => store().setDraft(bot.id, value)}
            attachedFiles={files}
            onAttachedFilesChange={(next) => store().setAttachments(bot.id, next)}
            messageLimit={MAX_BOT_CHAT_TEXT}
            voiceMessages={NO_VOICE}
            onVoiceMessagesChange={ignore}
            enabledSkills={NO_SKILLS}
            disableSkillsPicker
            slashCommands={false}
            commandSuggestions={commandSuggestions}
            placeholder={`Message ${bot.name}`}
            stoppable={working}
            dictateWhileStoppable
            extraActions={<BotEmojiButton field={composerField} value={draft} onChange={(value) => store().setDraft(bot.id, value)} />}
            onSend={() => { void submitBotChat(bot.id) }}
            onStop={() => void store().stop(bot.id)}
            lastPrompt={lastPrompt}
          />
        </ComposerNoticeProvider>
      </div>
    </section>
    {file && <BotFilePane botId={bot.id} path={file} onClose={() => setFile(null)} />}
    {paneOpen && browser && <BotBrowserPane bot={bot} view={browser} />}
    {appletOpen && <BotAppletPane botId={bot.id} applet={appletOpen} onClose={() => setAppletOpen(null)} />}
    {aboutOpen && <BotAboutPanel bot={bot} />}
    {memoryOpen && <BotMemoryDialog bot={bot} {...(memoryOpen.focus ? { focus: memoryOpen.focus } : {})} />}
  </ImageGalleryProvider></BotFilesProvider>
}
