import { usePastedBotSecret } from './usePastedBotSecret'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ArrowDown, Brain, ChevronRight, CircleAlert, Loader2, PanelRightClose, PanelRightOpen, Reply, Shield, X } from '../../lib/icons'
import { withAppletNames, type BotChatApplet, type BotChatMessage, type BotChatQuote, type BotError, type BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_COLOUR_HEX, DEFAULT_BOT_LOOK, normalizeBotLook } from '../../../shared/bots/personal/look'
import { botMessageFrom, type BotMessageFrom } from '../../../shared/bots/personal/botMessages'
import { plainCards } from '../../../shared/bots/personal/cards'
import { MAX_BOT_CHAT_TEXT } from '../../../shared/bots/personal/methods'
import { useAppStore } from '../../stores/appStore'
import { botFaceState, useBotsStore } from '../../stores/botsStore'
import { openProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { Markdown } from '../../chat/components/agent-elements/markdown'
import { CopyButton } from '../../chat/components/agent-elements/copy-button'
import { ReadAloudButton } from '../../readAloud/ReadAloudButton'
import { useMotionScale } from '../../lib/motion'
import { watchOffscreen } from '../../lib/offscreenMotion'
import { BotFace } from './face/BotFace'
import { BotSteps } from './BotSteps'
import { BOT_IMAGES, BotFilesProvider, BotMarkdown, BotPathChip, fileActions } from './BotFiles'
import { BotAppletPane, BotMessageApplets } from './BotApplets'
import { BotPictureActions, BotReplyMedia } from './BotReplyMedia'
import { BotReactionBadge, BotReactionBar } from './BotReactions'
import { replyImages } from './botReplyImages'
import { BotEmojiButton } from './BotEmoji'
import { BotActionCard } from './BotActionCard'
import { BotAskReplies } from './BotAskReplies'
import { BotReminderReplies } from './BotReminderReplies'
import { BotQuestionReplies } from './BotQuestionReplies'
import { BotSecretRequests } from './BotSecretRequests'
import { ComputerUseSetupCard } from '../ComputerUseSetupCard'
import { BotCards, galleryPaths } from './BotCards'
import { BotActivitySticker, BotPresenceLine } from './BotPresence'
import { askAnswerLine } from '../asks/AskCard'
import { BotMenu } from './BotMenu'
import { BotTasksButton } from './BotTasksButton'
import { BotModelButton } from './BotModelButton'
import { botRetryOf } from './botRetry'
import { ReportButton } from '../bugReports/ReportButton'
import { BotSidePanel, botFilesFolder, useBotSidePanel } from './BotSidePanel'
import { BotMemoryDialog } from './BotMemoryDialog'
import { BotBrowserPreview } from './BotBrowser'
import { useBotBrowser } from '../../stores/botBrowserStore'
import { ChatComposer, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import type { ChatReference } from '../../../shared/chatReferences'
import { botThreadReferenceRefusal } from '../../lib/threadReference'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../ComposerNotice'
import { botGroupTime, placeMessages } from './messageGroups'
import { botDoingLine, chatRows, resumedWork, resumedWorkLine, withNotes, type BotChatRow, type OwnerMarks } from './botChatShape'
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
import { useBotCutReplies, useBotLiveReply, useHasBotLiveReply } from '../../stores/botLiveReplies'
import { useFlowingText } from '../../chat/components/agent-elements/reply-flow'
import { FindInThreadBar } from '../../chat/components/agent-elements/find/FindInThreadBar'

const EMPTY: BotChatMessage[] = []
const NO_FILES: AttachedFile[] = []
const NO_VOICE: VoiceMessage[] = []
const NO_REFERENCES: ChatReference[] = []

/**
 * A pill in a bot's composer (a dropped thread): one of the owner's threads the bot may read, never a private
 * thread or a subagent. It is sent as the thread's link.
 */
function addBotReference(botId: string, reference: ChatReference): void {
  if (reference.kind !== 'thread' || !reference.threadId) throw new Error('A bot chat takes threads, not other references.')
  const refused = botThreadReferenceRefusal(reference.threadId)
  if (refused) throw new Error(refused)
  useBotsStore.getState().addReference(botId, reference)
}
const NO_SKILLS: never[] = []
const NO_MARKS = new Map<string, OwnerMarks>()
const NO_NOTES: BotLocalNote[] = []
/** The chat's turn waits for the internet (its work, if any, says so in the header's list). */
const OFFLINE_TEXT = 'Waiting for internet'
/**
 * How long Mousse's words beside the typing dots stay before the next ones take their place, so a burst of quick
 * calls never flickers there: the newest waits its turn, and the ones between are never shown.
 */
export const DOING_HOLD_MS = 1000
const ignore = () => {}

/**
 * The one red line of a bot's error, with its one way out (bot-ui §4.9). `settled`: what it said is over (a pause that
 * has ended, or an older line of one that still holds), so it reads quietly, without its button. `onRetry`: a failed chat
 * turn's Retry (`botRetryOf`), on the line itself. A line that is not a usage pause has the app's Report button too
 * (Settings → General → Report button), with its words.
 */
export function BotErrorLine({ error, onAction, settled, onRetry }: { error: BotError; onAction(action: NonNullable<BotError['action']>): void; settled?: boolean; onRetry?: () => void }) {
  return <div className={settled ? 'bot-error is-settled' : 'bot-error'} role="status">
    <CircleAlert size={15} aria-hidden /><span>{error.text}</span>
    {error.action && !settled && <button type="button" onClick={() => onAction(error.action!)}>{error.action.label}</button>}
    {onRetry && !settled && <button type="button" onClick={onRetry}>Retry</button>}
    {!settled && error.action?.kind !== 'resume' && <ReportButton error={{ title: 'Bot error', message: error.text, surface: 'bot chat' }} />}
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
export function pinnedOf(messages: readonly BotChatMessage[], bot: Pick<BotSummary, 'name' | 'error' | 'state'>): BotPinned[] {
  const pinned: BotPinned[] = []
  const ask = messages.filter((message) => message.ask?.status === 'open').at(-1)
  if (ask) pinned.push({ kind: 'ask', id: ask.id, text: `${bot.name} wants to ${ask.ask!.title}` })
  // A usage pause that holds is already said on the paused line above the composer.
  if (bot.error && !(bot.state === 'paused' && bot.error.action?.kind === 'resume')) {
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
  return pending ? <span className="bot-bubble-time">Sending…</span> : <time className="bot-bubble-time" dateTime={message.action?.askedAt ?? message.at}>{message.action?.status === 'open' && 'Asked · '}{botGroupTime(message.action?.askedAt ?? message.at)}</time>
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
        {message.text && <div data-mousse="user-message" className="bot-you-bubble">
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
  a.quote === b.quote && a.starts === b.starts && a.time === b.time && a.onReply === b.onReply && a.onApplet === b.onApplet && a.settled === b.settled && a.onRetry === b.onRetry &&
  a.bot.id === b.bot.id && a.bot.name === b.bot.name && a.live === b.live && a.follow === b.follow

/**
 * `browser`: the live preview of the bot's browser, on the reply of the last run that used it. `quote`: show the
 * message this one answers (it is not the one right above). `starts`: the first of its group, with the group's space
 * above it. `time`: shows its time (the last of a run in one minute does). `asked`: the message it answers, when loaded (how long it took). `onApplet`: opens one of its applets beside
 * the chat. `live`: the chat's turn, not posted yet: its typing dots, then its reply as it is written (`BotTurnBody`); its
 * message, once posted, is drawn in this same bubble (`useReplyKeys`). `follow`: keeps the chat's end in view as the
 * bubble grows.
 */
interface BotMessageProps { bot: BotSummary; message: BotChatMessage; onAction(action: NonNullable<BotError['action']>): void; settled?: boolean; browser?: ReactNode; quote: boolean; starts: boolean; time: boolean; onReply(message: BotChatMessage): void; asked?: BotChatMessage; onApplet(applet: BotChatApplet): void; live?: BotLive; follow?: () => void; onRetry?: () => void }

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

/** Who wrote a message, for its groups: the owner, the bot, or another of the owner's bots that sent it a message. */
function senderOf(message: BotChatMessage): string {
  const from = message.author === 'bot' ? botMessageFrom(message) : undefined
  return from ? `bot:${from.botId ?? from.name}` : message.author
}

/** Another bot's name on its message: as it is called now, or as it was when it sent the message once it is gone. */
const senderName = (from: BotMessageFrom, sender: BotSummary | undefined) => sender?.name ?? from.name

/**
 * A bot's message as a messenger shows it in a one-to-one chat: a bubble on the left, with no face or name (the header
 * says who it is), the time in its corner. A report reads as any reply that quotes the request; a list of keys and
 * values reads as a small card; the files it names are chips, its pictures a picture message above its words (the
 * ones a tool handed it among them). Every chip of its work folds behind "Worked for", none dropped. Read aloud, Copy and
 * Reply show beside it on hover; its applets sit under it; an open ask is quick replies under it. A message another of
 * the owner's bots sent it reads as in a group chat: that bot's face beside the bubble, its name on top, its colour.
 */
const BotMessage = memo(function BotMessage({ bot, message: row, onAction, settled, browser, quote, starts, time, onReply, asked, onApplet, live, follow, onRetry }: BotMessageProps) {
  const store = useBotsStore.getState
  // A bubble that was the chat's live turn eases to each new size: a line that wraps, then its posted message's foot.
  const wasLive = useRef(false)
  if (live) wasLive.current = true
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
  // Another of the owner's bots sent it: drawn as that bot's own bubble, its face beside it and its name on top.
  const from = useMemo(() => botMessageFrom(row), [row])
  // The sender as the owner's bots list has it now (its look, its name), by its id; an older row names it only.
  const sender = useBotsStore((s) => (from ? s.bots.find((other) => (from.botId ? other.id === from.botId : other.name === from.name)) : undefined))
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
  const resize = useEasedHeight(bubble, wasLive.current, follow)
  const article = useRef<HTMLElement>(null)
  useGrowIn(article, Boolean(live), follow)
  // After every change of a bubble that was live (its posted message replacing its live words among them).
  useLayoutEffect(() => { if (wasLive.current) resize() })
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
  // Another bot's message shows its words alone: who sent it is its name and face, not a header.
  const words = from ? from.message : media.text
  const line = <div className="bot-message-line">
    <div ref={bubble} tabIndex={-1} data-mousse="assistant-message" className={`bot-bubble${pictures ? ' has-media' : ''}${pictures && !words && !lostChips.length && !cards ? ' is-media-only' : ''}`}>
      {from && <span className="bot-from-name">{senderName(from, sender)}</span>}
      {quoted && <BotReplyQuote botId={bot.id} quote={message.replyTo!} botName={bot.name} />}
      <BotReplyMedia images={shownImages} onMenuOpen={setMenuOpen} />
      {live ? <BotTurnBody botId={bot.id} botName={bot.name} live={live} onSize={resize} follow={follow} /> : message.action ? <BotActionCard card={message.action} botId={bot.id} botName={bot.name} messageId={message.id} /> : message.actionSentAt ? <p className="bot-question-settled" role="note" data-find-text data-message-id={message.id} data-part-index="0">Sent · <time dateTime={message.actionSentAt}>{botGroupTime(message.actionSentAt)}</time></p> : words && <div className="bot-find-text" data-find-text data-message-id={message.id} data-part-index="0"><BotMarkdown text={words} className="bot-markdown" /></div>}
      {cards && <BotCards cards={cards} botId={bot.id} />}
      {lostChips.length > 0 && <p className="bot-picture-chips">{lostChips.map((image) => <BotPathChip key={image.key} path={image.path!} />)}</p>}
      {openAsk && <p className="bot-bubble-ask"><Shield size={14} aria-hidden /><span>Wants to <strong>{openAsk.title}</strong></span></p>}
      {!!message.attachments?.length && <BotOtherFiles files={message.attachments} />}
      {message.error && <BotErrorLine error={message.error} onAction={onAction} settled={settled} onRetry={onRetry} />}
      {stepsOpen && <BotSteps chips={steps} />}
      {(steps.length > 0 || time && (!message.action || message.action.status === 'open')) && <div className="bot-bubble-foot">
        {steps.length > 0 && <WorkedToggle ms={ms} open={stepsOpen} onToggle={() => setStepsOpen((open) => !open)} />}
        {time && (!message.action || message.action.status === 'open') && <BubbleTime message={message} />}
      </div>}
      {message.reaction && <BotReactionBadge emoji={message.reaction} onRemove={() => react(null)} />}
    </div>
    {/* As beside a thread's reply: read it aloud, copy it as written, reply to it. Anchored to the bubble's lower
        right edge and taking no width of its own, so the bubble is as wide with them as without. */}
    {!live && <span ref={tools} className="bot-message-tools">
      {canReact && <BotReactionBar current={message.reaction} onReact={react} onPicked={picked} onFocus={() => setReacted(false)} />}
      <span className="bot-message-actions">
        {(from ? from.message : message.text) && <ReadAloudButton speechKey={`bot:${message.id}`} markdown={from ? from.message : message.text} />}
        {/* Copy takes its cards too, as text. */}
        {(from ? from.message : cards ? row.text : message.text) && <CopyButton text={from ? from.message : cards ? row.text : message.text} />}
        <ReplyButton onReply={() => onReply(message)} />
      </span>
    </span>}
  </div>
  return <article ref={article} className={`chat-participant-message from-agent bot-message${from ? ' is-from-bot' : ''}${starts ? ' is-group-start' : ''}${reacted ? ' is-react-quiet' : ''}${message.reaction ? ' has-reaction' : ''}${menuOpen ? ' is-menu-open' : ''}${live ? ' bot-turn' : wasLive.current ? ' was-live' : ''}`} {...(live ? {} : { 'data-message-id': message.id, 'data-turn-key': message.id })}
    style={from ? { '--from-colour': BOT_COLOUR_HEX[normalizeBotLook(sender?.look).colour] } as CSSProperties : undefined}
    onMouseEnter={clampTools} onFocus={clampTools} onMouseLeave={reacted ? () => setReacted(false) : undefined}>
    {/* As in a group chat: the sender's face at the foot of its bubble. */}
    {from ? <div className="bot-from-row"><BotFace look={sender?.look ?? DEFAULT_BOT_LOOK} state="idle" size={28} view="head" still className="bot-from-face" />{line}</div> : line}
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

/** What a bubble shows while it is the chat's live turn: whether it waits for the internet, and what it is doing now. */
interface BotLive { offline: boolean; doing: string }

/**
 * How quickly a live bubble takes a new height (a wrapped line, its posted message's foot), before the speed scale: the
 * time constant of a critically damped spring. A new height while it moves carries on from its speed, so the bubble
 * never stops and starts again, and a 23 px line moves it under 2 px a frame.
 */
export const BOT_GROW_TAU_MS = 80

/** The same for the chat's turn growing into place (about 55 px with the space above it): under 2 px a frame. */
export const BOT_GROW_IN_TAU_MS = 180

/** A height moving toward its target, in px and px/ms, as of `last` (a frame's time). */
interface Spring { x: number; v: number; last: number }

/**
 * Moves `spring` toward `target` up to `now`, in steps of at most 4 ms so it stays stable. A frame drawn late counts as
 * one frame, not more: the bubble moves on as far as one frame would take it instead of catching up in a jump. True once
 * it rests.
 */
function stepSpring(spring: Spring, target: number, now: number, tau: number): boolean {
  const w = 1 / tau
  for (let left = Math.min(now - spring.last, 17); left > 0; left -= 4) {
    const h = Math.min(4, left)
    spring.v += (w * w * (target - spring.x) - 2 * w * spring.v) * h
    spring.x += spring.v * h
  }
  spring.last = now
  return Math.abs(target - spring.x) < 0.1 && Math.abs(spring.v) < 0.002
}

/** The height `bubble` takes from its contents: the lowest of its children in the flow, and its own padding. */
function naturalHeight(bubble: HTMLElement): number {
  const top = bubble.getBoundingClientRect().top
  const own = getComputedStyle(bubble)
  let bottom = 0
  for (const child of Array.from(bubble.children)) {
    const style = getComputedStyle(child)
    if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none') continue
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom - top + (parseFloat(style.marginBottom) || 0))
  }
  return bottom + (parseFloat(own.paddingBottom) || 0) + (parseFloat(own.borderBottomWidth) || 0)
}

/**
 * A bubble that eases to each new height instead of snapping to it, and the chat's end that follows it frame by frame
 * (`follow`, which leaves a reader who scrolled up where they are). The returned `resize` is called after each change of
 * its contents (in a layout effect, before the frame is drawn): the bubble holds the height it showed and moves from
 * there each frame (`stepSpring`); a change while it moves only gives it a new target. Off (`on` false, Animation speed
 * Off or reduced motion), it only notes the height.
 */
function useEasedHeight(ref: RefObject<HTMLElement | null>, on: boolean, follow?: () => void): () => void {
  const scale = useMotionScale()
  // A spring already moving takes a new speed at once; with motion off it stops where its target is.
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const state = useRef<{ target?: number; spring?: Spring; frame: number }>({ frame: 0 })
  const followRef = useRef(follow)
  followRef.current = follow
  const stop = useCallback(() => {
    const s = state.current
    cancelAnimationFrame(s.frame)
    s.frame = 0
    if (!s.spring) return
    s.spring = undefined
    ref.current?.style.removeProperty('height')
    ref.current?.classList.remove('is-easing')
  }, [ref])
  useEffect(() => stop, [stop])
  return useCallback(() => {
    const element = ref.current
    const s = state.current
    if (!element || !on) return
    if (scale === 0) stop()
    const height = naturalHeight(element)
    const shown = s.spring ? s.spring.x : s.target
    s.target = height
    if (s.spring || scale === 0 || shown === undefined || Math.abs(shown - height) < 0.5) return
    const spring: Spring = { x: shown, v: 0, last: performance.now() }
    s.spring = spring
    element.classList.add('is-easing')
    element.style.height = `${shown}px`
    const step = (now: number) => {
      if (stepSpring(spring, s.target!, now, BOT_GROW_TAU_MS * scaleRef.current)) stop()
      else {
        element.style.height = `${spring.x}px`
        s.frame = requestAnimationFrame(step)
      }
      followRef.current?.()
    }
    s.frame = requestAnimationFrame(step)
  }, [ref, on, scale, stop])
}

/**
 * The chat's live turn grows into place where it starts, as tall and as far below the message above as it will be, and
 * fades in, so the chat moves up to it over a few frames instead of all at once (`follow` each frame). Only on its
 * first draw while live (`on`), and not with motion off.
 */
function useGrowIn(ref: RefObject<HTMLElement | null>, on: boolean, follow?: () => void) {
  const scale = useMotionScale()
  const followRef = useRef(follow)
  followRef.current = follow
  const grown = useRef(!on)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || grown.current) return
    grown.current = true
    if (scale === 0) return
    const margin = parseFloat(getComputedStyle(element).marginTop) || 0
    const spring: Spring = { x: 0, v: 0, last: performance.now() }
    element.classList.add('is-growing-in')
    const draw = (height: number) => {
      const part = height > 0 ? Math.min(1, spring.x / height) : 1
      element.style.height = `${spring.x}px`
      element.style.marginTop = `${part * margin}px`
      element.style.opacity = `${part}`
    }
    const settle = () => {
      element.style.height = element.style.marginTop = element.style.opacity = ''
      element.classList.remove('is-growing-in')
    }
    draw(naturalHeight(element))
    let frame = 0
    const step = (now: number) => {
      const height = naturalHeight(element)
      if (stepSpring(spring, height, now, BOT_GROW_IN_TAU_MS * scale)) {
        frame = 0
        settle()
      } else {
        draw(height)
        frame = requestAnimationFrame(step)
      }
      followRef.current?.()
    }
    frame = requestAnimationFrame(step)
    // Cut short (its effects run twice in development, or the speed changed): it starts again if it is drawn again.
    return () => {
      if (!frame) return
      cancelAnimationFrame(frame)
      settle()
      grown.current = false
    }
  }, [ref, scale])
}

/** How long the typing row and the first words of the reply cross, before the speed scale. */
export const BOT_HANDOFF_MS = 180

/**
 * The chat's live turn inside its bubble, as a messaging app shows it. The bubble (a `BotMessage` with `live`) is the
 * one its message, once posted, is drawn in, so nothing mounts or goes when the reply comes:
 * - Typing: three dots and beside them what it is doing now (`useDoingLine`), in full, the only thing that moves.
 *   Waiting for the internet, it says so instead, still.
 * - Writing: the reply in whole words at an even pace, each fading in (`useFlowingText`), so lines already shown never
 *   re-wrap. Until its first word is whole the dots stay. Each new line eases the bubble taller (`useEasedHeight`).
 * - The handoff: the reply's words and the typing row share one place. The row fades out as the words fade in
 *   (`BOT_HANDOFF_MS`; at once with motion off), then stays there unseen and still, keeping the bubble at least as tall
 *   and as wide as it was. The reply's first line is as tall as the typing row (a paragraph's line, `.bot-turn-typing`).
 */
function BotTurnBody({ botId, botName, live, onSize, follow }: { botId: string; botName: string; live: BotLive; onSize: () => void; follow?: () => void }) {
  const { offline, doing } = live
  const reply = useBotLiveReply(botId)
  // Each reply of the turn is paced from its own start.
  const shown = useFlowingText(reply?.text ?? '', true, reply?.messageId ?? '')
  const writing = shown !== ''
  const scale = useMotionScale()
  useLayoutEffect(() => {
    onSize()
    follow?.()
  }, [shown, onSize, follow])
  // The words beside the dots as the reply took over: the unseen row keeps them, so its size holds still.
  const held = useRef(doing)
  if (!writing) held.current = doing
  // `leaving`: the typing row fading out over the first words.
  const [leaving, setLeaving] = useState(false)
  const wasWriting = useRef(writing)
  useLayoutEffect(() => {
    const was = wasWriting.current
    wasWriting.current = writing
    if (!writing || was || scale === 0) return
    setLeaving(true)
    const timer = setTimeout(() => setLeaving(false), BOT_HANDOFF_MS * scale)
    return () => {
      clearTimeout(timer)
      setLeaving(false)
    }
  }, [writing, scale])
  const typing = <span className={`an-md-p bot-turn-typing${writing ? leaving ? ' is-leaving' : ' is-held' : ''}`} aria-hidden={writing || undefined}>
    {offline && !writing ? <span className="bot-status-line">{OFFLINE_TEXT}</span> : <TypingDots status={writing ? held.current : doing} still={writing && !leaving} />}
  </span>
  return <div className={`bot-turn-body ${writing ? 'bot-live-reply' : 'bot-typing'}`}
    {...(writing ? { 'aria-busy': true } : { role: 'status', 'aria-label': offline ? OFFLINE_TEXT : doing ? `${botName}: ${doing}` : `${botName} is typing` })}>
    {/* A paragraph's line box, as the reply's own first line has: the typing row is as tall as one line of it. */}
    <div className="an-markdown bot-markdown bot-turn-place">{typing}</div>
    {writing && <BotMarkdown text={shown} className={`bot-markdown bot-turn-reply${leaving ? ' is-arriving' : ''}`} streaming />}
  </div>
}

/**
 * The key of the chat's live bubble (`live`), and of the bot messages that took one over (`keys`): a bot message of the
 * chat's turn (the latest `turn` named) that arrives after the chat first drew its rows, newer than every bot message
 * before it, takes the live bubble's key, and the live bubble moves on to a new one. So a posted message is drawn in the
 * bubble that was typing and writing it, not in a new one. Every other message keeps its id: loading older messages
 * changes no key.
 */
function useReplyKeys(rows: readonly BotChatRow[], turn: string | undefined): { keys: ReadonlyMap<string, string>; live: string } {
  const state = useRef<{ keys: Map<string, string>; next: number; turn?: string; seq: number } | null>(null)
  const botSeq = (row: BotChatRow) => (row.kind === 'message' && row.message.author === 'bot' ? row.message.seq : -Infinity)
  state.current ??= { keys: new Map(), next: 0, seq: Math.max(-Infinity, ...rows.map(botSeq)) }
  const s = state.current
  if (turn) s.turn = turn
  for (const row of rows) {
    if (row.kind !== 'message' || botSeq(row) <= s.seq) continue
    s.seq = row.message.seq
    if (s.turn && row.message.activationId === s.turn && !s.keys.has(row.message.id)) s.keys.set(row.message.id, `reply:${s.next++}`)
  }
  return { keys: s.keys, live: `reply:${s.next}` }
}

/** After a reply of the turn is posted, how long the turn waits before it shows typing again: most turns end with it. */
export const BOT_AFTER_REPLY_MS = 700

/**
 * A reply whose turn stopped before it finished (a Stop, a failure): what it had written, muted and marked stopped, as a
 * thread keeps a stopped reply. It is this window's only: never stored, never sent to the bot.
 */
function BotCutReply({ text, starts }: { text: string; starts: boolean }) {
  return <article className={`chat-participant-message from-agent bot-message bot-cut-reply${starts ? ' is-group-start' : ''}`}>
    <div className="bot-message-line">
      <div data-mousse="assistant-message" className="bot-bubble">
        <BotMarkdown text={text} className="bot-markdown" />
        <div className="bot-bubble-foot"><span className="bot-cut-mark" title="This reply stopped before it was finished, and was not sent.">Stopped</span></div>
      </div>
    </div>
  </article>
}

/**
 * The words beside the typing dots, held calm. `line` is what the turn does now (`botDoingLine`: only the bot's own
 * words), `turn` the chat turn it belongs to.
 * - The bot's own words show at once, and so does the first line of a turn.
 * - Once the turn has said what it does, a moment with nothing to say (its step ended, its reply not begun) keeps the
 *   last words: the line never falls back to the dots alone in between.
 */
function useDoingLine(turn: string | undefined, line: { text: string; own?: true; idle?: true }): string {
  const [shown, setShown] = useState(() => ({ turn, text: line.text, idle: Boolean(line.idle), at: Date.now() }))
  const sameTurn = shown.turn === turn
  const keep = sameTurn && Boolean(line.idle) && !shown.idle
  const text = keep ? shown.text : line.text
  const idle = keep ? shown.idle : Boolean(line.idle)
  const atOnce = !sameTurn || Boolean(line.own)
  useLayoutEffect(() => {
    if (sameTurn && shown.text === text) return
    const show = () => setShown({ turn, text, idle, at: Date.now() })
    const wait = atOnce ? 0 : shown.at + DOING_HOLD_MS - Date.now()
    if (wait <= 0) return show()
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [turn, text, idle, atOnce, sameTurn, shown])
  // A new turn's first line and the bot's own words are drawn in this render, not the next.
  return atOnce ? text : shown.text
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
 * Animation speed Off or reduced motion all of it stays still, and the words are plain; so is a row held unseen under
 * a reply (`hold`).
 */
function TypingDots({ status, still: hold = false }: { status: string; still?: boolean }) {
  const dotsRef = useRef<HTMLSpanElement>(null)
  const glintRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const still = useMotionScale() === 0 || hold
  const shimmerAnimations = useAppStore((state) => state.shimmerAnimations)
  const showShimmer = !still && shimmerAnimations && Boolean(status)
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
    if (!showShimmer || !glint || !copy || typeof glint.animate !== 'function') return
    const timing: KeyframeAnimationOptions = { duration: TYPING_CYCLE_MS, delay: TYPING_SHIMMER_DELAY_MS, iterations: Infinity, fill: 'backwards' }
    const shimmer = [glint.animate(TYPING_GLINT, timing), copy.animate(TYPING_GLINT_COPY, timing)]
    // On the dots' clock, so the wave that crosses them runs on into the words. Dots started in this same frame have no
    // start time yet: all of them then start together.
    const lead = dotsRef.current?.firstElementChild?.getAnimations?.()[0]
    if (lead?.startTime !== null && lead?.startTime !== undefined) for (const animation of shimmer) animation.startTime = lead.startTime
    return () => shimmer.forEach((animation) => animation.cancel())
  }, [showShimmer])
  // Paused, all together so the wave stays in step, while the bubble is scrolled out of view or the window is hidden.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (still || !bubble || typeof bubble.getAnimations !== 'function') return
    return watchOffscreen(bubble, (offscreen) => {
      for (const animation of bubble.getAnimations({ subtree: true })) {
        if (offscreen) animation.pause()
        else animation.play()
      }
    })
  }, [still, showShimmer])
  return <span ref={bubbleRef} className={`bot-typing-row${still ? ' is-still' : ''}`}>
    <span ref={dotsRef} className="bot-typing-dots" aria-hidden><i /><i /><i /></span>
    {status && <span className="bot-typing-status">
      {status}
      {showShimmer && <span ref={glintRef} className="bot-typing-glint" aria-hidden><span>{status}</span></span>}
    </span>}
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
  const storedDraft = useBotsStore((s) => s.drafts[bot.id] ?? '')
  const pasted = usePastedBotSecret(bot, storedDraft)
  const draft = pasted.draft
  const references = useBotsStore((s) => s.references[bot.id]) ?? NO_REFERENCES
  const attachments = useBotsStore((s) => s.attachments[bot.id])
  const replying = useBotsStore((s) => s.replyingTo[bot.id])
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
  // The chat's turn (a service from before work: the bot's working activation), and what it said it is doing now.
  const turn = useBotsStore((s) => bot.chat?.activationId ?? (legacy ? s.live[bot.id]?.activationId : undefined))
  const status = useBotsStore((s) => (turn ? s.statuses[turn] : undefined))
  const lastSeq = messages.at(-1)?.seq
  const firstId = messages[0]?.id
  const files = attachments ?? NO_FILES
  // The rows: messages, and quiet lines for work started and asks answered; what replies left on the owner's messages.
  // The lines of the owner's `/` commands go among them by time; they are this window's only, never the bot's. So are
  // the words of replies whose turn stopped before they were finished (botLiveReplies.ts).
  const notes = useBotsStore((s) => s.notes[bot.id] ?? NO_NOTES)
  const cuts = useBotCutReplies(bot.id)
  // A usage pause that still holds is said once, on the paused line above the composer (with its Resume); its chat line
  // shows only once the pause is over, quietly, as what happened.
  const resumeOn = useMemo(() => liveResumeLine(messages, { state: bot.state }), [messages, bot.state])
  const pauseLine = resumeOn ? messages.find((message) => message.id === resumeOn)?.error?.text : undefined
  const { rows, marks } = useMemo(() => {
    const shaped = chatRows(resumeOn ? messages.filter((message) => message.id !== resumeOn) : messages, bot.name, (message) => (message.ask ? askAnswerLine(message.ask, message.kind === 'notice') : undefined))
    const lines = cuts.length ? [...notes, ...cuts.map((cut) => ({ id: cut.id, at: cut.at, text: cut.text, cut: true as const }))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : notes
    return { rows: withNotes(shaped.rows, lines), marks: shaped.marks }
  }, [messages, resumeOn, bot.name, notes, cuts])
  // The sent rows and the messages on their way, in one run of groups (a quiet line ends a group), with the day lines.
  const shown = useMemo<BotChatRow[]>(() => (pending.length ? [...rows, ...pending.map((message) => ({ kind: 'message' as const, message }))] : rows), [rows, pending])
  const places = useMemo(() => placeMessages(shown.map((row, index) => (row.kind === 'message' ? { author: senderOf(row.message), at: row.message.at, sending: index >= rows.length } : { author: row.cut ? 'bot' : 'system', at: row.at }))), [shown, rows.length])
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
  // The bot's own browser: the reply of the run whose tab it shows has a live preview, and Expand opens it in the side
  // panel. Each watches the browser's pictures only while it is on screen.
  const browser = useBotBrowser(bot.id)
  // The side panel docked beside the chat pane: the browser, the bot's files, Agent settings (BotSidePanel.tsx).
  const side = useBotSidePanel(bot.id)
  const filesFolder = useMemo(() => botFilesFolder(messages, bot.id), [messages, bot.id])
  // A file a chip opened, in the side panel's Files view.
  const [file, setFile] = useState<string | null>(null)
  // An applet opened beside the chat, from its name.
  const [appletOpen, setAppletOpen] = useState<BotChatApplet | null>(null)
  useEffect(() => { setAppletOpen(null) }, [bot.id])
  const openApplet = useCallback((applet: BotChatApplet) => setAppletOpen(applet), [])
  // An action on a file that the computer refused ("Can't find notes.md…") is said above the composer.
  const fileFailed = useCallback((text: string) => useBotsStore.setState({ error: text, errorBotId: bot.id }), [bot.id])
  // A chip's click: a file shows in the side panel's Files view, a folder opens in the file manager, one that is gone
  // is said.
  const showSide = side.show
  const openFile = useCallback((path: string) => fileActions.open(path, (shown) => {
    setFile(shown)
    showSide('files')
  }, fileFailed), [fileFailed, showSide])
  const browserRun = browser?.activationId ?? browser?.activations.at(-1)
  const previewOn = browserRun ? messages.filter((message) => message.author === 'bot' && message.activationId === browserRun).at(-1)?.id : undefined
  const preview = browser && browserRun ? <BotBrowserPreview bot={bot} view={browser} /> : null
  // Work the owner's answer set going again: it starts no chat turn, so the chat says the work carries on until it posts.
  const resumed = useMemo(() => resumedWork(messages, bot.work), [messages, bot.work])

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
  // own steps don't bring the button back. `top`: where the last scroll left it. `landing`: Find is taking the reader to
  // a match, which may first have to be drawn; until it is there, a scroll that still finds the end (a write of the
  // reply's follow, a frame before) does not make the chat follow it again and pull the reader back.
  const anchor = useRef<{ firstId?: string; lastSeq?: number; height: number; atEnd: boolean; sent: number; heading?: boolean; top?: number; landing?: boolean }>({ height: 0, atEnd: true, sent: 0 })
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
    anchor.current = { firstId: firstShown, lastSeq, height: element.scrollHeight, atEnd: held.atEnd, sent: pending.length, heading: held.heading, top: held.top, landing: held.landing }
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
  // Retry sits on the newest failed chat turn only, while nothing the owner wrote came after it.
  const retryOn = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.author === 'owner') return ''
      if (message.kind === 'error' && botRetryOf(messages, message)) return message.id
    }
    return ''
  }, [messages])
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
      anchor.current.landing = true
    },
    onLanded: () => { anchor.current.landing = false }
  })

  const act = useCallback((action: NonNullable<BotError['action']>) => {
    // Sign in opens the card of the owner's provider entry the bot would run on; Set up opens the list.
    if (action.kind === 'sign_in' && action.instanceId) openProvider(action.instanceId)
    else if (action.kind === 'sign_in' || action.kind === 'open_providers') openSettingsSection('providers')
    // A picked model that can't run (#673): About opens at its model rows.
    else if (action.kind === 'pick_model') useBotsStore.setState({ aboutOpen: true, aboutFocus: 'runs-on' })
    else void store().resume(bot.id)
  }, [bot.id, store])
  const retry = useCallback(() => { if (retryOn) void store().retry(bot.id, retryOn) }, [bot.id, retryOn, store])
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
  const typingStarts = !((last?.kind === 'message' && last.message.author === 'bot') || (last?.kind === 'system' && last.cut))
  // The reply the chat's turn is writing takes the typing bubble's place, and the end stays in view as it grows.
  const writing = useHasBotLiveReply(bot.id)
  // What the bot says it is doing now, beside its typing dots; nothing of Mousse's own.
  const doing = useDoingLine(turn, botDoingLine({ status }))
  // The turn's live bubble is drawn as the bot message it becomes, under the key its message takes over.
  const replyKeys = useReplyKeys(shown, turn)
  const live = useMemo<BotLive>(() => ({ offline, doing }), [offline, doing])
  const liveMessage = useMemo<BotChatMessage>(() => ({ id: replyKeys.live, seq: -1, at: '', author: 'bot', kind: 'text', text: '', chips: [], ...(turn ? { activationId: turn } : {}) }), [replyKeys.live, turn])
  // A reply of the turn just posted: typing shows again only if the turn still works a moment later.
  const posted = !writing && turn && last?.kind === 'message' && last.message.author === 'bot' && last.message.activationId === turn ? last.message.id : undefined
  const [quietDone, setQuietDone] = useState<string>()
  useEffect(() => {
    if (!posted) return
    const timer = setTimeout(() => setQuietDone(posted), BOT_AFTER_REPLY_MS)
    return () => clearTimeout(timer)
  }, [posted])
  const liveShown = (writing || working || offline) && (!posted || quietDone === posted)
  const followEnd = useCallback(() => {
    const element = transcript.current
    if (!element || !anchor.current.atEnd) return
    element.scrollTop = element.scrollHeight
    anchor.current.height = element.scrollHeight
  }, [])
  // The face and the name open Agent settings in the side panel, and close it there.
  const toggleAbout = () => (side.open && side.view === 'settings' ? side.close() : side.show('settings'))
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
    {/* The chat pane: the conversation, and an applet beside it. The side panel docks outside it. */}
    <div className="bot-chat-pane">
    {/* The bot's colour tints the quotes of its messages. */}
    <section data-mousse="chat" className={`chat-conversation bot-conversation${typing ? ' is-typing' : ''}`} data-applet-conversation style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}>
      <header data-mousse="chat-header" className="chat-conversation-header">
        <button type="button" className="bot-header-about" aria-label={`About ${bot.name}`} onClick={toggleAbout}>
          <BotFace look={bot.look} state={botFaceState(bot, happy)} size={32} view="head" />
          <BotActivitySticker bot={bot} typing={typing} offline={offline} />
        </button>
        <div className="bot-header-who">
          <button type="button" className="bot-header-name" tabIndex={-1} aria-hidden onClick={toggleAbout}><h1>{bot.name}</h1></button>
          <BotPresenceLine bot={bot} typing={typing} offline={offline} />
        </div>
        <BotTasksButton botId={bot.id} tasks={bot.tasks} />
        {/* The provider it talks on, ringed by the usage left, and its model rows. */}
        <BotModelButton bot={bot} />
        <button type="button" className={`bot-header-panel${side.open ? ' is-open' : ''}`} aria-label={side.open ? 'Hide side panel' : 'Show side panel'} title={side.open ? 'Hide side panel' : 'Show side panel'} aria-expanded={side.open} onClick={side.toggle}>
          {side.open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        {/* From the menu, whose item goes as it closes: Escape then gives the focus to the composer. */}
        <BotMenu bot={bot} {...(find.openFind ? { onFind: () => { composerField()?.focus({ preventScroll: true }); find.openFind!() } } : {})} />
      </header>
      {find.barProps && <div className="bot-find-anchor"><FindInThreadBar {...find.barProps} /></div>}
      <div data-mousse="transcript" className="chat-transcript" data-applet-scroller ref={transcript} role="log" aria-label={`${bot.name} messages`} onScroll={(event) => {
        const element = event.currentTarget
        const down = element.scrollTop >= (anchor.current.top ?? 0)
        anchor.current.atEnd = !anchor.current.landing && element.scrollHeight - element.scrollTop - element.clientHeight < 40
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
          if (row.kind === 'system') return <Fragment key={row.id}>{day}{row.expiredReviews?.length
            ? <details className="bot-expired-actions" aria-label="Expired action reviews" data-turn-key={row.id}>
              <summary><span role="note">{row.text}</span></summary>
              {row.expiredReviews.map(message => <BotMessage key={message.id} bot={bot} message={message} onAction={act} quote={false} starts={true} time={false} onReply={reply} onApplet={openApplet} />)}
            </details>
            : row.cut ? <BotCutReply text={row.text} starts={place.starts} /> : <SystemLine row={row} />}</Fragment>
          const message = row.message
          const sending = index >= rows.length
          // A reply shows what it answers unless that is the message right above it.
          const above = shown[index - 1]
          const quote = Boolean(message.replyTo) && (sending || !((above?.kind === 'message' && above.message.id === message.replyTo!.id) || (above?.kind === 'system' && above.of === message.replyTo!.id)))
          return <Fragment key={replyKeys.keys.get(message.id) ?? message.id}>
            {day}
            {message.author === 'owner'
              ? <OwnerMessage botId={bot.id} message={message} pending={sending} botName={bot.name} quote={quote} starts={place.starts} time={place.time} marks={(marks ?? NO_MARKS).get(message.id)} onReply={sending ? undefined : reply} />
              : <BotMessage bot={bot} message={message} onAction={act} settled={message.error?.action?.kind === 'resume' && message.id !== resumeOn} browser={message.id === previewOn ? preview : undefined} quote={quote} starts={place.starts} time={place.time} onReply={reply} onApplet={openApplet}
                asked={message.replyTo ? byId.get(message.replyTo.id) : undefined} onRetry={message.id === retryOn ? retry : undefined} {...(replyKeys.keys.has(message.id) ? { follow: followEnd } : {})} />}
          </Fragment>
        }).concat(liveShown ? [<Fragment key={replyKeys.live}>{null}<BotMessage bot={bot} message={liveMessage} onAction={act} quote={false} starts={typingStarts} time={false} onReply={reply} onApplet={openApplet} live={live} follow={followEnd} /></Fragment>] : [])}
        {resumed && <p className="bot-system-line" role="status" data-work-id={resumed.id}><span>{resumedWorkLine(bot.name, resumed)}</span></p>}
        {/* A run still working before its reply: the preview follows it here. */}
        {preview && !previewOn && <div className="bot-browser-live">{preview}</div>}
        {bot.state === 'paused' && <p className="bot-paused-line" role="status">{(pauseLine ?? (bot.stateText.startsWith('Paused') ? bot.stateText : 'Paused')).replace(/\.$/, '')}. <button type="button" onClick={() => void store().resume(bot.id)}>Resume</button></p>}
      </div>
      <div className="chat-input-area bot-input-area" data-applet-composer>
        {(unseen || away) && <button type="button" className="bot-jump" onClick={toEnd}><ArrowDown size={14} aria-hidden />{unseen ? 'New message' : 'Go to latest'}</button>}
        {!!pinnedOff.length && <div className="bot-pins" role="status" aria-label="Waiting on you">{pinnedOff.map((item) => <PinnedLine key={item.kind} botId={bot.id} item={item} />)}</div>}
        {/* A secret the bot asked for: typed into its private card, never into the chat. */}
        <BotSecretRequests homeThreadId={bot.homeThreadId} botName={bot.name} />
        {/* Computer use one of the bot's turns asked to set up: whatever is chosen applies from its next turn. */}
        <ComputerUseSetupCard threadId={bot.homeThreadId} />
        {pasted.offer}
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
            onInputChange={pasted.change}
            attachedFiles={files}
            onAttachedFilesChange={(next) => store().setAttachments(bot.id, next)}
            references={references}
            onAddReference={(reference) => addBotReference(bot.id, reference)}
            onRemoveReference={(id) => store().removeReference(bot.id, id)}
            onReferenceError={(message) => useBotsStore.setState({ error: message, errorBotId: bot.id })}
            pastedThreadRefusal={botThreadReferenceRefusal}
            messageLimit={MAX_BOT_CHAT_TEXT}
            voiceMessages={NO_VOICE}
            onVoiceMessagesChange={ignore}
            enabledSkills={NO_SKILLS}
            disableSkillsPicker
            slashCommands={false}
            commandSuggestions={commandSuggestions}
            placeholder={`Message ${bot.name}`}
            stoppable={working}
            extraActions={<BotEmojiButton field={composerField} value={draft} onChange={pasted.change} />}
            onSend={() => { if (pasted.beforeSend()) void submitBotChat(bot.id) }}
            onStop={() => void store().stop(bot.id)}
            lastPrompt={lastPrompt}
          />
        </ComposerNoticeProvider>
      </div>
    </section>
    {appletOpen && <BotAppletPane botId={bot.id} applet={appletOpen} onClose={() => setAppletOpen(null)} />}
    </div>
    <BotSidePanel bot={bot} state={side} browser={browser} folder={filesFolder} file={file} onFile={setFile} />
    {memoryOpen && <BotMemoryDialog bot={bot} {...(memoryOpen.focus ? { focus: memoryOpen.focus } : {})} />}
  </ImageGalleryProvider></BotFilesProvider>
}
