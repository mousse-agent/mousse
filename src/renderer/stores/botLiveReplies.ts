import { useCallback, useSyncExternalStore } from 'react'
import type { BotChatMessage, BotSummary } from '../../shared/bots/personal/chat'
import type { BotReplyEvent } from '../../shared/bots/personal/methods'
import { SILENT_REPLY } from '../../shared/bots/personal/wakes'
import type { ChatMessage } from '../../shared/types'
import { assistantDisplayText } from '../chat/adapters/mousseToUI'

/**
 * A bot's reply as its chat turn writes it, shown in its chat before the turn ends. Display only: the message the
 * chat keeps is the one the service posts when the turn settles, which replaces this.
 *
 * Its source is the bot's home thread, where its chat turns run: the service already sends every window that thread's
 * reply as it streams (at most one update every 50 ms, `TEXT_EMIT_MS`), so nothing new is asked of it. A bot of another
 * computer has its home thread there: while a window shows its chat, its stream carries the same messages
 * (`bots.reply`, `noteBotReply`). Updates reach
 * the readers at most once per animation frame, and only the live bubble reads the text, so the chat around it never
 * renders for a token.
 *
 * What counts as the reply: the latest plain text of the chat's turn. A step (a tool call) after it makes it the bot's
 * status line instead (`statusLineOf`), so it leaves; a new message to the bot (its turn starting, a steer) does too.
 *
 * How it ends:
 * - its message is posted (a bot message of the same activation, after the reply began): it goes at once, even when
 *   the message comes before its first frame, and a late update of that reply never brings it back;
 * - the chat's turn ends with no such message within `SETTLE_MS`: if it was stopped (this window asked its Stop) or
 *   failed (its error came), what it had stays in this window only as a stopped reply (`cuts`), muted and marked so,
 *   never stored or sent, as a thread keeps a stopped reply; a message of that activation that still comes later takes
 *   its place. Any other turn that ends with no message meant to post nothing (a silent turn), so its reply just goes:
 *   when this window cannot tell how a turn ended, it never claims a Stop.
 */

interface LiveReply {
  /** The home thread's reply message it follows. */
  messageId: string
  text: string
  /** When its first words came (ISO): where a stopped reply sits among the chat's rows. */
  startedAt: string
  /** The chat turn it belongs to, once the bot's summary has named it. */
  activationId?: string
  /** The newest chat message held when it began: its own message comes after it. */
  afterSeq: number
  /** The chat's turn has ended and its message has not come yet. */
  ended?: boolean
  /** This window asked the bot to stop while it was being written. */
  stopAsked?: true
}

/** A reply its turn never finished: kept in this window only, shown muted and marked stopped. */
export interface BotCutReply {
  id: string
  at: string
  text: string
  activationId?: string
}

/** How long after its chat turn ended a reply waits for its message before it is shown as stopped. */
export const SETTLE_MS = 3000

/** Every step a turn takes in its thread: what a status line is the bot's words before (`statusLine.ts`). */
const STEP_KINDS: ReadonlySet<string> = new Set(['tool_call', 'mcp_tool_call', 'build_tool_call'])
/** What Claude Code writes when it resumes a session a steer cut: never the bot's words (`RUNTIME_PLACEHOLDER_REPLY`). */
const RUNTIME_PLACEHOLDER = /^no response requested\.?$/i

const replies = new Map<string, LiveReply>()
const cuts = new Map<string, BotCutReply[]>()
const listeners = new Map<string, Set<() => void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Text updates held for the next frame, by bot. Each keeps the chat as it stood when its words came (the newest seq,
 * the turn): its message, if it is posted before the frame, comes after that and still ends it.
 */
const held = new Map<string, { messageId: string; text: string; afterSeq: number; activationId?: string }>()
/** The last replies, by bot, whose message was posted or that settled: a late update of one never shows it again. */
const finished = new Map<string, string[]>()
const FINISHED_KEPT = 8
let frame: number | ReturnType<typeof setTimeout> | null = null

interface Sources {
  /** The bots as listed now. */
  bots(): readonly BotSummary[]
  /** The chat messages held for a bot. */
  messages(botId: string): readonly BotChatMessage[]
}
let sources: Sources = { bots: () => [], messages: () => [] }

function notify(botId: string): void {
  for (const listener of listeners.get(botId) ?? []) listener()
}

function botOfThread(threadId: string): BotSummary | undefined {
  return sources.bots().find((bot) => bot.homeThreadId === threadId)
}

/** What of a home-thread reply the chat may show: its words, without a Stop's mark, an applet's source or the runtime's placeholder. */
export function liveReplyText(content: string): string {
  // A turn that stays quiet writes only the silent marker, and nothing is posted (`withoutSilentMarker`): it never
  // shows, nor its first characters while it is being written.
  const lines = assistantDisplayText(content).split('\n').filter((line) => line.trim() !== SILENT_REPLY)
  const last = lines.at(-1)?.trim() ?? ''
  if (last.startsWith('[') && SILENT_REPLY.startsWith(last)) lines.pop()
  let text = lines.join('\n')
  // An applet is shown from what the turn published, once its message is posted: its source never shows.
  const applet = text.search(/^ {0,3}(`{3,}|~{3,})[ \t]*mousse-applet/m)
  if (applet >= 0) text = text.slice(0, applet)
  // Its end stays as written: white space after a word is what says that word is whole (`useFlowingText`).
  const kept = text.split(/(\n\s*\n)/).filter((part) => !RUNTIME_PLACEHOLDER.test(part.trim())).join('').trimStart()
  return kept.trim() ? kept : ''
}

/**
 * Whether `bot`'s chat shows a turn of its own now, as its typing bubble does (`BotChatView`): the service names one
 * (`chat`), or a service from before work (no `chat`, `work` or `threads`) says the bot works.
 */
function chatTurnShown(bot: BotSummary): boolean {
  return Boolean(bot.chat) || (bot.chat === undefined && bot.work === undefined && bot.threads === undefined && bot.state === 'working')
}

/** What of a home-thread message the live reply reads: a thread's own message, or a bot of another computer's (`bots.reply`). */
interface ReplyNote {
  id: string
  role: string
  kind?: string
  content: string
  hidden?: boolean
}

function isReplyText(message: ReplyNote): boolean {
  return message.role === 'assistant' && !message.hidden && (message.kind === undefined || message.kind === 'message')
}

/** The newest seq held in `botId`'s chat. */
function lastSeq(botId: string): number {
  return sources.messages(botId).at(-1)?.seq ?? 0
}

function finish(botId: string, messageId: string): void {
  const list = finished.get(botId) ?? []
  if (!list.includes(messageId)) finished.set(botId, [...list, messageId].slice(-FINISHED_KEPT))
}

function drop(botId: string): void {
  held.delete(botId)
  const timer = timers.get(botId)
  if (timer) clearTimeout(timer)
  timers.delete(botId)
  if (replies.delete(botId)) notify(botId)
}

/** Whether `botId`'s chat holds the message that ends `reply`: the bot's own, of its turn, posted after it began. */
function answered(botId: string, reply: Pick<LiveReply, 'activationId' | 'afterSeq'>): boolean {
  return sources.messages(botId).some((message) => message.author === 'bot' && message.seq > reply.afterSeq && message.kind !== 'error' &&
    (reply.activationId === undefined || message.activationId === reply.activationId))
}

function flush(): void {
  frame = null
  for (const [botId, update] of held) {
    held.delete(botId)
    const bot = sources.bots().find((entry) => entry.id === botId)
    const current = replies.get(botId)
    if (current?.messageId === update.messageId) {
      if (current.text === update.text) continue
      replies.set(botId, { ...current, text: update.text })
    } else {
      // A new reply of the turn (after a thought, or the next dispatch) replaces the one before.
      const activationId = update.activationId ?? bot?.chat?.activationId ?? (current && !current.ended ? current.activationId : undefined)
      const reply: LiveReply = { messageId: update.messageId, text: update.text, startedAt: new Date().toISOString(), afterSeq: update.afterSeq, ...(activationId ? { activationId } : {}) }
      // Its message was posted before this frame: it never shows beside it.
      if (answered(botId, reply)) {
        finish(botId, reply.messageId)
        drop(botId)
        continue
      }
      replies.set(botId, reply)
    }
    notify(botId)
  }
}

function schedule(): void {
  if (frame !== null) return
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 16)
}

/** A message of a thread was added or updated (`orchestrator:thread-message`, `-updated`). */
export function noteThreadMessage(threadId: string, message: ChatMessage | undefined, added: boolean): void {
  if (!message) return
  const bot = botOfThread(threadId)
  if (bot) noteReply(bot, message, added)
}

/**
 * A bot of another computer wrote its reply, while this window shows its chat (`bots.reply`): its home thread lives on
 * that computer, which sends what of its messages the reply needs. Read as a home-thread message here is.
 */
export function noteBotReply(event: BotReplyEvent | undefined): void {
  if (!event?.botId || typeof event.messageId !== 'string') return
  const bot = sources.bots().find((entry) => entry.id === event.botId)
  if (!bot) return
  noteReply(bot, { id: event.messageId, role: event.role, ...(event.kind ? { kind: event.kind } : {}), content: event.text ?? '' }, event.added)
}

function noteReply(bot: BotSummary, message: ReplyNote, added: boolean): void {
  if (added && (message.role === 'user' || (message.kind !== undefined && STEP_KINDS.has(message.kind)))) {
    drop(bot.id)
    return
  }
  if (!isReplyText(message)) return
  // Only the chat's own turn is written live. A turn no person started or waits on (a wake-up, a thread's notice) is out
  // of sight: the service names no chat turn for it, and only what it posts shows.
  if (!chatTurnShown(bot)) return
  const text = liveReplyText(message.content)
  if (!text) {
    // Its words became nothing to show (the silent marker): what it showed goes.
    if (replies.get(bot.id)?.messageId === message.id || held.get(bot.id)?.messageId === message.id) drop(bot.id)
    return
  }
  if (finished.get(bot.id)?.includes(message.id)) return
  const prior = held.get(bot.id)
  const since = prior?.messageId === message.id ? prior : { afterSeq: lastSeq(bot.id), activationId: bot.chat?.activationId }
  held.set(bot.id, { messageId: message.id, text, afterSeq: since.afterSeq, ...(since.activationId ? { activationId: since.activationId } : {}) })
  schedule()
}

/**
 * The bots or their chats changed: a reply learns its turn, goes once its message is posted, and is shown as stopped
 * once its turn ended without one. A stopped reply goes when its message still comes.
 */
export function noteBots(): void {
  for (const [botId, reply] of replies) {
    if (answered(botId, reply)) {
      finish(botId, reply.messageId)
      drop(botId)
      continue
    }
    const chat = sources.bots().find((bot) => bot.id === botId)?.chat
    if (!reply.activationId && chat) replies.set(botId, { ...reply, activationId: chat.activationId })
    else if (reply.activationId && chat?.activationId !== reply.activationId && !reply.ended) {
      replies.set(botId, { ...reply, ended: true })
      timers.set(botId, setTimeout(() => settle(botId, reply.messageId), SETTLE_MS))
    }
  }
  for (const [botId, list] of cuts) {
    const kept = list.filter((cut) => !(cut.activationId && lateAnswer(botId, cut)))
    if (kept.length !== list.length) {
      cuts.set(botId, kept)
      notify(botId)
    }
  }
}

/** Whether a message of a stopped reply's turn came after all. */
function lateAnswer(botId: string, cut: BotCutReply): boolean {
  return sources.messages(botId).some((message) => message.author === 'bot' && message.kind !== 'error' && message.activationId === cut.activationId && Date.parse(message.at) >= Date.parse(cut.at))
}

/** Whether `reply`'s turn failed or stopped short: the service posted its error (`failActivation`, `stoppedRow`). */
function failed(botId: string, reply: LiveReply): boolean {
  return reply.activationId !== undefined && sources.messages(botId).some((message) => message.author === 'bot' && message.kind === 'error' &&
    message.seq > reply.afterSeq && message.activationId === reply.activationId)
}

/** This window asked `botId` to stop: a reply it is writing, if its message does not come, is a stopped one. */
export function noteBotStopAsked(botId: string): void {
  if (held.has(botId)) flush()
  const reply = replies.get(botId)
  if (reply && !reply.stopAsked) replies.set(botId, { ...reply, stopAsked: true })
}

function settle(botId: string, messageId: string): void {
  timers.delete(botId)
  const reply = replies.get(botId)
  if (!reply || reply.messageId !== messageId) return
  replies.delete(botId)
  finish(botId, messageId)
  if (!answered(botId, reply) && (reply.stopAsked || failed(botId, reply))) cuts.set(botId, [...(cuts.get(botId) ?? []), { id: `cut:${reply.messageId}`, at: reply.startedAt, text: reply.text, ...(reply.activationId ? { activationId: reply.activationId } : {}) }])
  notify(botId)
}

/** Where the bots and their chats are read from (the bots store). */
export function setBotLiveReplySources(next: Sources): void {
  sources = next
}

/** Drops every live and stopped reply: the profile changed, and tests. */
export function clearBotLiveReplies(): void {
  const bots = new Set([...replies.keys(), ...cuts.keys()])
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  held.clear()
  finished.clear()
  replies.clear()
  cuts.clear()
  for (const botId of bots) notify(botId)
}

function useBot<T>(botId: string, read: () => T): T {
  const subscribe = useCallback((listener: () => void) => {
    let set = listeners.get(botId)
    if (!set) listeners.set(botId, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(botId)
    }
  }, [botId])
  return useSyncExternalStore(subscribe, read, read)
}

/** The reply `botId`'s chat turn is writing, as far as it has come; undefined when none. Renders as it grows. */
export function useBotLiveReply(botId: string): { messageId: string; text: string } | undefined {
  return useBot(botId, () => replies.get(botId))
}

/** Whether `botId` has a reply being written: renders only when that changes. */
export function useHasBotLiveReply(botId: string): boolean {
  return useBot(botId, () => replies.has(botId))
}

const NO_CUTS: BotCutReply[] = []
/** The replies of `botId`'s turns that stopped before they finished, oldest first; this window's only. */
export function useBotCutReplies(botId: string): readonly BotCutReply[] {
  return useBot(botId, () => cuts.get(botId) ?? NO_CUTS)
}
