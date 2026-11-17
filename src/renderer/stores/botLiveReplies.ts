import { useCallback, useSyncExternalStore } from 'react'
import type { BotChatMessage, BotSummary } from '../../shared/bots/personal/chat'
import { SILENT_REPLY } from '../../shared/bots/personal/wakes'
import type { ChatMessage } from '../../shared/types'
import { assistantDisplayText } from '../chat/adapters/mousseToUI'

/**
 * A bot's reply as its chat turn writes it, shown in its chat before the turn ends. Display only: the message the
 * chat keeps is the one the service posts when the turn settles, which replaces this.
 *
 * Its source is the bot's home thread, where its chat turns run: the service already sends every window that thread's
 * reply as it streams (at most one update every 50 ms, `TEXT_EMIT_MS`), so nothing new is asked of it. Updates reach
 * the readers at most once per animation frame, and only the live bubble reads the text, so the chat around it never
 * renders for a token.
 *
 * What counts as the reply: the latest plain text of the chat's turn. A step (a tool call) after it makes it the bot's
 * status line instead (`statusLineOf`), so it leaves; a new message to the bot (its turn starting, a steer) does too.
 *
 * How it ends:
 * - its message is posted (a bot message of the same activation, after the reply began): it goes at once;
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
/** Text updates held for the next frame, by bot. */
const held = new Map<string, { messageId: string; text: string }>()
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
  // Its end stays as written: a blank line after a paragraph is what says that paragraph is finished (`usePacedText`).
  const kept = text.split(/(\n\s*\n)/).filter((part) => !RUNTIME_PLACEHOLDER.test(part.trim())).join('').trimStart()
  return kept.trim() ? kept : ''
}

function isReplyText(message: ChatMessage): boolean {
  return message.role === 'assistant' && !message.hidden && (message.kind === undefined || message.kind === 'message')
}

/** The newest seq held in `botId`'s chat. */
function lastSeq(botId: string): number {
  return sources.messages(botId).at(-1)?.seq ?? 0
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
      const activationId = bot?.chat?.activationId ?? (current && !current.ended ? current.activationId : undefined)
      replies.set(botId, { messageId: update.messageId, text: update.text, startedAt: new Date().toISOString(), afterSeq: lastSeq(botId), ...(activationId ? { activationId } : {}) })
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
  if (!bot) return
  if (added && (message.role === 'user' || (message.kind !== undefined && STEP_KINDS.has(message.kind)))) {
    drop(bot.id)
    return
  }
  if (!isReplyText(message)) return
  const text = liveReplyText(message.content)
  if (!text) {
    // Its words became nothing to show (the silent marker): what it showed goes.
    if (replies.get(bot.id)?.messageId === message.id || held.get(bot.id)?.messageId === message.id) drop(bot.id)
    return
  }
  held.set(bot.id, { messageId: message.id, text })
  schedule()
}

/**
 * The bots or their chats changed: a reply learns its turn, goes once its message is posted, and is shown as stopped
 * once its turn ended without one. A stopped reply goes when its message still comes.
 */
export function noteBots(): void {
  for (const [botId, reply] of replies) {
    if (answered(botId, reply)) {
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
