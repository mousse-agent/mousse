import type { AloneRequest } from '../actions/BotAlone'
import { asksFirstFor } from '../../../shared/bots/personal/asksFirst'
import { readableActionTitle, type ActionRow } from '../actions/BotActions'
import type { BotActionCard } from '../../../shared/bots/personal/chat'
import { workWaitLine, parkedNeedsOwner } from '../activation/workWaiting'
import { unattendedChatTurn } from '../activation/unattended'
import { replyPreviewText } from '../../../shared/threadPreview'
import { randomUUID } from 'node:crypto'
import { askText } from '../../../shared/bots/personal/askText'
import { launchedActive, withAppletNames, type BotAskCard, type BotAskStatus, type BotChatApplet, type BotChatMessage, type BotChatQuote, type BotLaunchedThread, type BotTaskItem, type BotWatcherItem, type BotWorkItem, type BotChip, type BotDetail, type BotError, type BotMessageKind, type BotPermissionItem, type BotReminderItem, type BotRunItem, type BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_MODEL_SLOT_KEYS, type BotDefinition, type BotLane, type BotManifest } from '../../../shared/bots/personal/definition'
import { isPinned, limitOnPick, slotsOf, stuckRowsOf } from '../../../shared/bots/personal/modelSlots'
import { askFingerprint, BOT_BUDGET_WALL_KEYS, isSpecialAsk, mcpAskTools, type BotAskRequest, type BotEscalationStatus, type BotPermissionRequest } from '../../../shared/bots/personal/escalation'
import { BOT_AUTOMATION_APP_TOOLS, BOT_RETIRED_APP_TOOLS, BOT_THREADS_PERMISSION, botStarterManifest, canonicalManifest, isOwnBotAppTool, withFullTrust } from '../../../shared/bots/personal/manifest'
import type { BotJournalKind } from '../../../shared/bots/personal/memory'
import { botState } from '../../../shared/bots/personal/state'
import { normalizeBotLook } from '../../../shared/bots/personal/look'
import { workModelDetail } from '../../../shared/bots/personal/chips'
import type { BotJournal } from '../seams'
import { installationOf, type BotMcpWhere } from '../mcp/BotMcp'
import { outOfSightRow, workWaits, type BotActivationRow, type BotEscalationRow, type BotMessageRow, type BotQuestionRow, type BotStore } from '../store/BotStore'
import { plainChoices, type BotChatQuestion } from '../../../shared/bots/personal/questions'
import { cardFileName, plainCards, type BotCard, type BotChatCard } from '../../../shared/bots/personal/cards'
import { MAX_BOT_CHAT_ATTACHMENTS } from '../../../shared/bots/personal/methods'
import { replyApplets } from './replyApplets'
import { takeToolImages } from './toolImages'
import { takeReplyCards } from './replyCards'
import { WAKE_LINE_PREFIX, wakeEventLabel } from '../../../shared/bots/personal/wakes'
import { BOT_FOLD_LINE_PREFIX, BOT_FOLD_LINE_TITLE } from '../../../shared/bots/personal/memory'

function isServiceLine(id: string): boolean {
  return ['bm_asks_first_', 'bm_permission_', 'bm_schedule_ended_', 'bm_schedule_done_', WAKE_LINE_PREFIX, BOT_FOLD_LINE_PREFIX].some(prefix => id.startsWith(prefix))
}
import type { AppletReference } from '../../../shared/applets'
import { BOT_USAGE_WINDOW_MS, botContextSummary, turnUsageSummary } from '../activation/turnUsage'

/**
 * The Bot UI's view of `bots.db` (Bot Phase 1 §5.1.1, §5.7): the chat rows (`bot_messages`), each
 * written with its journal row in one transaction, and the `BotSummary` and `BotDetail` builders.
 * The renderer reads only these, so no tool row, model name or instance id ever reaches it; the
 * one exception is `BotError.action.instanceId` (a Sign in button).
 */

/**
 * The starter grant (§5.3.1, `botStarterManifest`): files in the bot's own files folder, the web,
 * its own tools (`BOT_DEFAULT_APP_TOOLS`), no limits, and nothing outside. Pressing Create bot approves it.
 */
export function starterManifest(): BotManifest {
  return canonicalManifest(botStarterManifest())
}

/** How a chat row is journaled (bot-context.md §3). */
function journalKind(author: 'owner' | 'bot', kind: BotMessageKind, ask: boolean): BotJournalKind {
  if (author === 'owner') return 'owner_msg'
  if (kind === 'run_report') return 'run_report'
  if (ask) return 'ask'
  return kind === 'text' ? 'bot_msg' : 'notice'
}

/** The card's status, from its escalation's. */
function cardStatus(status: BotEscalationStatus): BotAskStatus {
  if (status === 'open') return 'open'
  if (status === 'allowed_bot' || status === 'allowed_once') return 'allowed'
  if (status === 'denied') return 'not_now'
  return 'withdrawn'
}

/** Whether a run activation still runs, waits at a wall, or waits to go on: whatever it was allowed reaches it. */
function stillWorking(row: BotActivationRow): boolean {
  return row.status === 'running' || row.status === 'waiting_grant' || workWaits(row)
}

/** A time of day in local time, "14:00". */
export function clockTime(iso: string): string {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** The Recent line of a bot whose chat is free while its work runs: "Working on Vacuum comparison", "Working on 2 things". */
function workingOn(work: readonly BotWorkItem[]): string {
  const running = work.filter((item) => item.status !== 'queued')
  if (running.length === 1 && work.length === 1) return `Working on ${running[0]!.title}`
  return `Working on ${work.length} things`
}

/** The Recent line of a bot that manages threads it started: "Managing Dictation mock-ups", "Managing 2 threads: A, B". */
export function managingLine(threads: readonly BotLaunchedThread[]): string {
  if (threads.length === 1) return `Managing ${threads[0]!.title}`
  return oneLine(`Managing ${threads.length} threads: ${threads.map((thread) => thread.title).join(', ')}`, 120)
}

/** One line of text for a list ("Recent"): the first line, cut. */
function oneLine(text: string, max = 120): string {
  const line = text.trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What each run of a schedule does, in its own words on one line, for About. A fixed line ("Say exactly: …") has none:
 * its label already says it.
 */
function scheduleDoes(prompt: string | undefined): string | undefined {
  const text = prompt?.replace(/\s+/g, ' ').trim()
  if (!text || text.startsWith('Say exactly: ')) return undefined
  return text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text
}

export interface PostInput {
  /** Journal provenance only: the chat keeps the original author and text. */
  external?: boolean
  botId: string
  author: 'owner' | 'bot'
  kind: BotMessageKind
  text: string
  /** Stable when the row may be written twice (a dispatch's reply): a repeat finds the first one. */
  id?: string
  chips?: BotChip[]
  askId?: string
  error?: BotError
  activationId?: string
  attachments?: Array<{ name: string; path: string }>
  clientRequestId?: string
  lane?: BotLane
  threadId?: string
  /**
   * A dispatch's reply: the id of its thread's message (in `threadId`) that holds these words. Capture copies that
   * message too; the chat row stands for it, so the journal holds the reply once, and a Forget of it holds.
   */
  transcriptMessageId?: string
  /** The message this one answers. */
  replyTo?: string
  /** A bot's message: the question it carries (its bubble). The owner's: the question it answered. */
  questionId?: string
  /**
   * A bot's message: cards to show with it, checked already (`cardOf`, a gallery's pictures in its files folder). A
   * message of a dispatch also takes the cards its turn made (`show_card`), and a question's bubble its question's card.
   */
  cards?: BotCard[]
  /**
   * A bot's message that asks its owner while its work waits (its question's bubble, a held action's card): it takes the
   * pictures the activation's tools handed it since its last message (`takeToolImages`), as a dispatch's message does, so
   * the owner sees a screenshot before they answer, not under the work's later report.
   */
  toolImages?: true
  /** A service notice that stays in chat without its own notification. */
  quiet?: true
  /** A notice the chat shows once in a row: the same text as the chat's latest message is not posted again. */
  unlessLatest?: true
  /**
   * For the owner's eyes only (#673: a picked model that can't run, by name): journaled as a hidden kind, which no
   * pack, search or read gives the bot, so it never learns a model's or an entry's name from its own chat.
   */
  hidden?: true
  /** Trusted job facts from the scheduler, used only by the post-time telling classifier. */
  scheduleLine?: { say: string; ownerAsked?: boolean }
}

/**
 * What a bot's message shows beside its words, read from where its turn made it (`setReplyParts`): the applets its
 * thread published (newest first), so the reply shows them as a thread's reply does.
 */
export interface BotReplyParts {
  published(threadId: string): readonly AppletReference[]
}

/** A row's files and its applets, apart (`BotMessageRow.attachments` keeps both, the files first). */
function filesOf(row: Pick<BotMessageRow, 'attachments'>): Array<{ name: string; path: string }> {
  return (row.attachments ?? []).filter((file) => !file.applet).map((file) => ({ name: file.name, path: file.path }))
}

function appletsOf(row: Pick<BotMessageRow, 'attachments'>): BotChatApplet[] {
  return (row.attachments ?? []).flatMap((file) => (file.applet ? [file.applet] : []))
}

/** A message's cards as the app draws them: a gallery's pictures named by their files. */
function chatCards(cards: readonly BotCard[] | undefined): BotChatCard[] {
  return (cards ?? []).map((card) => card.type === 'gallery'
    ? { ...card, files: card.files.map((file) => ({ path: file.path, name: cardFileName(file.path), ...(file.caption ? { caption: file.caption } : {}) })) }
    : card)
}

/**
 * The pictures a message's galleries show, as its files too (`card`), so a phone reads them through
 * `bots.chat.attachment` and an older app shows them: each once, after the files it has, while there is room.
 */
function galleryFiles(cards: readonly BotCard[], files: ReadonlyArray<{ path: string }>): Array<{ name: string; path: string; card: true }> {
  const added: Array<{ name: string; path: string; card: true }> = []
  for (const card of cards) {
    if (card.type !== 'gallery') continue
    for (const file of card.files) {
      if (files.length + added.length >= MAX_BOT_CHAT_ATTACHMENTS) return added
      if (files.some((kept) => kept.path === file.path) || added.some((kept) => kept.path === file.path)) continue
      added.push({ name: cardFileName(file.path), path: file.path, card: true })
    }
  }
  return added
}

/** The longest part of a written answer a question's bubble shows. */
const ANSWER_SHOWN_CHARS = 120

/**
 * A question as its bubble (or a nudge of it) shows it: its answers, where it stands, and the answer once there is one;
 * for one from work, whether the work waits on it (`waits`) and whether the chat passed the answer on (`by: 'chat'`). An
 * open one with a default says what it goes with, and when; a defaulted one says what the bot went with, and what the
 * owner answered after.
 */
function questionView(question: BotQuestionRow, waits: boolean, rowId: string): BotChatQuestion {
  const nudge = rowId !== question.messageId
  const answered = (question.status === 'answered' || question.status === 'defaulted') && !question.answer?.redacted ? question.answer : undefined
  const words = answered?.choice ?? (answered?.text ? oneLine(answered.text, ANSWER_SHOWN_CHARS) : undefined)
  const late = question.status === 'defaulted' ? question.answer?.late : undefined
  const lateWords = late?.choice ?? (late?.text ? oneLine(late.text, ANSWER_SHOWN_CHARS) : undefined)
  const goesWith = question.status === 'open' && question.follow?.kind === 'default' && question.follow.default && question.nextAt ? question.follow : undefined
  return {
    questionId: question.id,
    choices: question.spec.choices,
    other: question.spec.other,
    status: question.status,
    ...(words ? { answer: words, answeredWith: answered?.choice !== undefined ? 'choice' as const : 'text' as const } : {}),
    ...(question.status === 'answered' && question.answer?.by === 'chat' ? { by: 'chat' as const } : {}),
    ...(question.status === 'defaulted' ? { by: 'default' as const } : {}),
    ...(waits ? { waits: true as const } : {}),
    ...(goesWith ? { default: goesWith.default!, defaultAt: question.nextAt! } : {}),
    ...(lateWords ? { late: lateWords } : {}),
    ...(nudge ? { nudge: true as const } : {}),
    ...(rowId !== latestCarrier(question) ? { nudged: true as const } : {})
  }
}

/** The row that carries a question's answers while it waits: its latest nudge, else its bubble. */
function latestCarrier(question: Pick<BotQuestionRow, 'id' | 'messageId' | 'nudges'>): string | null {
  return question.nudges > 0 ? `bm_${question.id}_n${question.nudges}` : question.messageId
}

/** The chat rows of every bot of a profile, and the summaries built from `bots.db`. */
export class BotChatProjection {
  private replyParts: BotReplyParts | undefined

  constructor(private readonly options: {
    store: BotStore
    asksFirst?(): boolean
    aloneItems?(botId: string): BotPermissionItem[]
    /** About → Can use's switches of what every bot has by default (MCP and each server, skills, automation tools). */
    defaultItems?(botId: string): BotPermissionItem[]
    aloneAsk?(botId: string, activationId: string, request: AloneRequest): { title: string; details: { summary: string; items: string[] } } | undefined
    journal?: BotJournal
    /** `bots.message`, after the row's transaction committed. */
    emit(event: { botId: string; message: BotChatMessage }): void
    classify?(message: BotChatMessage, input: PostInput): 'now' | 'soon' | 'later' | null
    /** A bot's schedules, from the shared store (`BotEngine.listSchedules`), for About → Runs. */
    schedules?(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string; jobId?: string; paused?: boolean; name?: string; prompt?: string }>
    /**
     * Where a granted MCP server stands now (`BotMcp.where`), for About → Can use; undefined while the servers were not
     * read yet (nothing is shown gone then).
     */
    mcpWhere?(serverId: string): BotMcpWhere | undefined
    /** When a question's first follow-up is due, its bubble shown at `shownAt` (`BotEngine.firstFollowUpAt`); null for none. */
    followUpAt?(question: BotQuestionRow, shownAt: string): string | null
    /** The threads the bot started, hidden ones too, and how each stands (`BotEngine.launchedThreads`). */
    launched?(botId: string): BotLaunchedThread[]
    /** The bot's background commands running now. */
    watchers?(botId: string): BotWatcherItem[]
    /** The checklist kept on these threads (its chat's, then its work's), in that order; never throws. */
    tasks?(threadIds: string[]): BotTaskItem[]
  }) {}

  private get store(): BotStore {
    return this.options.store
  }

  /** Where a bot's replies find the applets their turns published (the profile's threads). */
  setReplyParts(parts: BotReplyParts | undefined): void {
    this.replyParts = parts
  }

  /**
   * A bot's message as it is kept: its turn's applet fences as references to what its thread published, and the
   * pictures a tool handed the activation since its last message, as files. Its journal keeps the words with each applet
   * named, never an applet's source. Anything else is kept as given.
   */
  private shown(input: PostInput, question?: BotQuestionRow): { text: string; journal: string; attachments: NonNullable<BotMessageRow['attachments']>; cards: BotCard[] } {
    const files = input.attachments ?? []
    if (input.author !== 'bot' || input.kind === 'error' || input.hidden) return { text: input.text, journal: input.text, attachments: [...files], cards: [] }
    const parts = this.replyParts
    const made = input.threadId && parts ? replyApplets(input.text, input.threadId, () => parts.published(input.threadId!)) : undefined
    // A message of a dispatch (its thread is named) shows what that activation's tools handed it: pictures, and cards. One
    // that asks its owner while the work waits takes its pictures too, so they show before the owner answers.
    const images = input.threadId || input.toolImages ? takeToolImages(input.activationId) : []
    const cards = [...(input.cards ?? []), ...(input.threadId ? takeReplyCards(input.activationId) : []), ...(question?.spec.card ? [question.spec.card] : [])]
    const kept = [...files, ...images]
    // Its journal row holds the cards as text after its words, so the chat pack, search and Forget see them.
    const words = made?.journal ?? input.text
    const plain = plainCards(cards)
    return {
      text: made?.text ?? input.text,
      journal: plain ? (words ? `${words}\n\n${plain}` : plain) : words,
      attachments: [...kept, ...galleryFiles(cards, kept), ...(made?.applets ?? []).map((applet) => ({ name: applet.reference.title, path: '', applet }))],
      cards
    }
  }

  /**
   * Writes a chat row and its journal row in one transaction (joining the caller's, if any), then
   * emits `bots.message`. A row whose id or request id exists already is returned as it was.
   */
  post(input: PostInput): BotChatMessage {
    const id = input.id ?? `bm_${randomUUID()}`
    const { row, inserted } = this.store.db.transaction(() => {
      const existing = this.store.message(id) ?? (input.clientRequestId ? this.store.messageByRequest(input.clientRequestId) : undefined)
      if (existing) return { row: existing, inserted: false }
      if (input.unlessLatest) {
        const latest = this.store.lastMessage(input.botId)
        if (latest && latest.author === input.author && latest.kind === input.kind && latest.text === input.text) return { row: latest, inserted: false }
      }
      const at = this.store.now()
      // A question's bubble is journaled with its card and its answers as text, so the chat pack, search and Forget see
      // them. A nudge of it (a later row carrying it) is journaled as its own fixed line: a copy would outlive a forget.
      const carried = input.questionId && input.author === 'bot' ? this.store.question(input.questionId) : undefined
      const asked = carried && carried.messageId === null ? carried : undefined
      const shown = this.shown(input, asked)
      if (asked) shown.journal = `${shown.journal}\n\n${plainChoices(asked.spec)}`
      this.store.insertMessage({
        id,
        botId: input.botId,
        at,
        author: input.author,
        kind: input.kind,
        text: shown.text,
        chips: input.chips ?? [],
        askId: input.askId ?? null,
        error: input.error ?? null,
        activationId: input.activationId ?? null,
        attachments: shown.attachments.length ? shown.attachments : null,
        clientRequestId: input.clientRequestId ?? null,
        replyTo: input.replyTo ?? null,
        ...(input.questionId ? { questionId: input.questionId } : {}),
        ...(shown.cards.length ? { cards: shown.cards } : {})
      })
      if (input.askId) this.store.setEscalationMessage(input.askId, id)
      // Its follow-up counts from when the owner sees it.
      if (asked) this.store.setQuestionMessage(asked.id, id, this.options.followUpAt?.(asked, at) ?? null)
      // The journal row joins this transaction: a chat row is never kept without it (bot-context.md §4).
      this.options.journal?.appendInTx(this.store.db, {
        botId: input.botId,
        kind: input.hidden ? 'model_change' : journalKind(input.author, input.kind, Boolean(input.askId)),
        ...(input.lane ? { lane: input.lane } : {}),
        ...(input.activationId ? { activationId: input.activationId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        sourceKey: `bm:${id}`,
        ...(input.threadId && input.transcriptMessageId ? { standsFor: `${input.threadId}:${input.transcriptMessageId}` } : {}),
        who: input.external ? 'tool' : input.author === 'owner' ? 'owner' : input.kind === 'error' || isServiceLine(id) ? 'mousse' : 'bot',
        ...(input.external ? { external: true } : {}),
        text: shown.journal || (input.error?.text ?? ''),
        json: {
          v: 1,
          kind: input.kind,
          ...(input.askId ? { askId: input.askId } : {}),
          ...(input.chips?.length ? { chips: input.chips } : {}),
          ...(filesOf(shown).length ? { attachments: filesOf(shown) } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(input.questionId ? { questionId: input.questionId } : {})
        }
      })
      // A row the chat never shows (an event's line, `outOfSightRow`) is kept for the bot's memory and its guards only:
      // it tells nobody and reaches no window.
      const tell = input.quiet || outOfSightRow(input.kind, id) ? null : this.options.classify?.(this.toMessage(this.store.message(id)!), input) ?? null
      this.store.run('UPDATE bot_messages SET tell = ?, tell_at = ? WHERE id = ?', tell, tell ? at : null, id)
      return { row: this.store.message(id)!, inserted: true }
    })
    const message = this.toMessage(row)
    // Emitted once the row is durable: inside a caller's transaction, after its commit.
    if (inserted && !outOfSightRow(row.kind, row.id)) this.store.db.afterCommit(() => this.emitMessage(this.toMessage(this.store.message(row.id) ?? row), row.botId))
    return message
  }

  /** The row again, after its card changed (an answer): `bots.message` with the same seq. */
  republish(messageId: string): BotChatMessage | undefined {
    const row = this.store.message(messageId)
    if (!row) return undefined
    const message = this.toMessage(row)
    this.emitMessage(message, row.botId)
    return message
  }

  private emitMessage(message: BotChatMessage, botId: string): void {
    try {
      this.options.emit({ botId, message })
    } catch {
      // A listener never undoes a committed row.
    }
  }

  /** A lightweight row-kind check for telling priority; no card or message reads. */
  isActionMessage(row: Pick<BotMessageRow, 'id'>): boolean {
    return row.id.startsWith('bm_action_')
  }

  toMessage(row: BotMessageRow): BotChatMessage {
    const reminder = row.id.startsWith('bm_rem_') ? this.store.reminderForMessage(row.botId, row.id) : undefined
    const expiresAt = reminder?.deliveredAt ? new Date(Date.parse(reminder.deliveredAt) + 24 * 60 * 60_000).toISOString() : undefined
    const snoozed = reminder && this.store.snoozedCopy(row.botId, reminder.id)
    const action = this.isActionMessage(row) ? this.actionForMessage(row.id) : undefined
    const sentAction = row.id.startsWith('bm_action_') ? this.store.get("SELECT ran_at FROM bot_actions WHERE message_id = ? AND status = 'done'", row.id) : undefined
    const expiredAction = row.id.startsWith('bm_action_') ? this.store.get("SELECT activation_id FROM bot_actions WHERE message_id = ? AND status = 'expired'", row.id) : undefined
    const expiredRun = expiredAction ? this.store.activation(String(expiredAction.activation_id)) : undefined
    const escalation = row.askId ? this.store.escalation(row.askId) : undefined
    const question = row.questionId ? this.store.question(row.questionId) : undefined
    // A question's bubble, or a nudge of it (any other bot row that carries it): its words, then its answers as plain text
    // for an app that doesn't draw them (`plainFrom`).
    const asks = question && row.author === 'bot' && question.messageId ? question : undefined
    // Its cards as plain text first, then the question's answers: an app that draws them stops at `plainFrom`.
    const cards = row.author === 'bot' ? chatCards(row.cards) : []
    const plain = [plainCards(cards), asks && asks.spec.choices.length ? plainChoices(asks.spec) : ''].filter(Boolean).join('\n\n')
    return {
      ...(reminder && expiresAt && expiresAt > this.store.now() && !reminder.work && !reminder.wake && !this.store.messageForgotten(row.botId, row.id) ? { reminder: { expiresAt, ...(snoozed ? { snoozedUntil: snoozed.dueAt } : {}) } } : {}),
      ...(typeof sentAction?.ran_at === 'string' ? { actionSentAt: sentAction.ran_at } : {}),
      ...(action ? { action } : {}),
      ...(expiredRun?.trigger.kind === 'schedule' ? { expiredActionSchedule: expiredRun.trigger.scheduleId } : {}),
      seq: row.seq,
      id: row.id,
      at: row.at,
      author: row.author,
      kind: row.kind,
      // Reserved ids keep permission switch lines quiet after a restart without a message schema change.
      // A wake's line too: it says why the bot speaks unasked.
      ...(row.kind === 'notice' && isServiceLine(row.id) ? { systemLine: true as const } : {}),
      // A fold's line says what happened on hover (docs/plans/bot-context.md §14).
      ...(row.kind === 'notice' && row.id.startsWith(BOT_FOLD_LINE_PREFIX) ? { systemTitle: BOT_FOLD_LINE_TITLE } : {}),
      text: plain ? (row.text ? `${row.text}\n\n${plain}` : plain) : row.text,
      ...(plain ? { plainFrom: row.text.length } : {}),
      ...(cards.length ? { cards } : {}),
      ...(asks ? { question: questionView(asks, asks.lane === 'run' && asks.status === 'open' && this.store.activation(asks.activationId)?.endReason === 'question', row.id) } : {}),
      ...(question && row.author === 'owner' && question.answerMessage === row.id && question.status === 'answered'
        ? { answers: { questionId: question.id, tapped: question.answer?.choice !== undefined } } : {}),
      // The owner's answer after the bot went with its default.
      ...(question && row.author === 'owner' && question.answerMessage === row.id && question.status === 'defaulted' && question.answer?.late
        ? { answers: { questionId: question.id, tapped: question.answer.late.tapped === true } } : {}),
      chips: row.chips,
      ...(escalation ? { ask: this.card(escalation) } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.activationId ? { activationId: row.activationId } : {}),
      ...(filesOf(row).length ? { attachments: filesOf(row) } : {}),
      ...(appletsOf(row).length ? { applets: appletsOf(row) } : {}),
      ...(row.replyTo ? { replyTo: this.quoteOf(row.replyTo) } : {}),
      ...(row.author === 'owner' && row.clientRequestId ? { clientRequestId: row.clientRequestId } : {}),
      ...(row.author === 'bot' && row.ownerReaction ? { reaction: row.ownerReaction.emoji } : {})
    }
  }

  private actionForMessage(messageId: string): BotActionCard | undefined {
    // Only the two known nudge ids refer back to an existing review; they never create actions.
    messageId = messageId.replace(/_n[12]$/, '')
    const row = this.store.get('SELECT id, bot_id, activation_id, args_digest, args_json, card_json, status, created_at, ran_at, answered_at, target_json, result_json FROM bot_actions WHERE message_id = ?', messageId) as unknown as (ActionRow & { created_at: string }) | undefined
    if (!row) return undefined
    const storedMetadata = JSON.parse(row.card_json ?? '{}')
    const metadata = storedMetadata && typeof storedMetadata === 'object' && !Array.isArray(storedMetadata) ? storedMetadata : {}
    const forgotten = row.args_digest === '[forgotten]' && row.args_json === '"[forgotten]"'
    const args: unknown = forgotten ? null : JSON.parse(row.args_json)
    const hiddenPaths: string[][] = []
    const visit = (value: unknown, path: string[]): void => {
      if (!value || typeof value !== 'object') return
      const object = value as Record<string, unknown>
      if (object.$mousse === 'hidden') { hiddenPaths.push(path); return }
      if (object.$mousse === 'literal') {
        // The wrapper escapes this object's namespace only. Its children may still contain real markers.
        if (object.value && typeof object.value === 'object')
          for (const [key, item] of Object.entries(object.value)) visit(item, [...path, key])
        return
      }
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key])
    }
    visit(args, [])
    const result = forgotten
      ? (metadata.toolReportedError === true || metadata.toolReportedError === 1 ? { text: '', toolReportedError: true } : undefined)
      : row.result_json ? JSON.parse(row.result_json) : undefined
    const previous = row.status === 'open' && !forgotten ? this.store.all(`SELECT status, ran_at, answered_at, created_at, target_json, result_json FROM bot_actions WHERE bot_id = ? AND args_digest = ?
      AND rowid < (SELECT rowid FROM bot_actions WHERE id = ?) AND status IN ('done', 'uncertain', 'failed') ORDER BY rowid DESC`, row.bot_id, row.args_digest, row.id)
      .find(candidate => {
        const target = JSON.parse(String(candidate.target_json))
        const current = JSON.parse(row.target_json)
        return target.server === current.server && target.tool === current.tool &&
          (candidate.status !== 'failed' || JSON.parse(String(candidate.result_json ?? '{}')).toolReportedError === true)
      }) : undefined
    const previousAt = previous?.ran_at ?? previous?.answered_at ?? previous?.created_at
    const validAt = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    const at = [metadata.settledAt, row.ran_at, row.answered_at].find(validAt)
    return {
      actionId: row.id, digest: row.args_digest, askedAt: row.created_at,
      title: typeof metadata.title === 'string' ? metadata.title : readableActionTitle(JSON.parse(row.target_json).tool),
      serverName: typeof metadata.serverName === 'string' ? metadata.serverName : 'Your service', args,
      hasHiddenValues: !forgotten && metadata.hasHiddenValues === true, hiddenPaths,
      ...(forgotten ? { forgotten: true as const } : {}),
      status: row.status as BotActionCard['status'],
      ...(previous && typeof previousAt === 'string' ? { previous: { status: previous.status as 'done' | 'uncertain' | 'failed', at: previousAt } } : {}),
      ...(at ? { at } : {}),
      ...(result ? { result: { text: result.text, ...(result.toolReportedError ? { toolReportedError: true } : {}), ...(result.notSentInTime === true ? { notSentInTime: true } : {}) } } : {})
    }
  }

  /** What a reply shows of the message it answers: who wrote it and its first line. A message that is gone shows as such. */
  private quoteOf(messageId: string): BotChatQuote {
    const quoted = this.store.message(messageId)
    if (!quoted) return { id: messageId, author: 'owner', text: '', gone: true }
    // Its applets by name first, then its words, or with none its files' names.
    const files = filesOf(quoted)
    const line = oneLine(quoted.text || quoted.error?.text || plainCards(quoted.cards) || files.map((file) => file.name).join(', '), 160)
    return { id: quoted.id, author: quoted.author, text: oneLine(withAppletNames(line, appletsOf(quoted)), 160) }
  }

  card(escalation: BotEscalationRow): BotAskCard {
    const text = escalation.title !== null ? { title: escalation.title, note: escalation.note ?? '' } : askText(escalation.permission)
    // What Allow gives in full, as the note's tooltip ("use your threads"): read from the permission, never stored.
    const tip = isSpecialAsk(escalation.permission) || 'budget' in escalation.permission ? undefined : askText(escalation.permission).tip
    // An MCP ask lists the tools Allow grants, by name, on a line the owner can open, with how many a bot can't use. One
    // whose server has not listed its tools yet has none: Allow stays off until they are filled in.
    const mcp = 'mcp' in escalation.permission ? escalation.permission.mcp : undefined
    const tools = mcp ? mcpAskTools(mcp) : []
    const more = mcp?.unusable ? `${mcp.unusable} more of ${mcp.name ? `${mcp.name}'s` : 'its'} tools can't be used by a bot.` : undefined
    const asks = this.options.asksFirst?.() && mcp && tools.some(tool => {
      const where = this.options.mcpWhere?.(mcp.serverId)
      const server = where?.state === 'on' || where?.state === 'changed' ? where.server : undefined
      return asksFirstFor({ tool, serverName: [server?.name ?? mcp.name ?? '', server?.installationId ?? installationOf(mcp.serverId)], readOnlyHint: server?.tools.find(t => t.tool === tool)?.readOnlyHint })
    })
    return {
      askId: escalation.id,
      title: text.title,
      note: asks ? 'Tools that may send or change things ask before each use. Tools that say they only read do not ask.' : this.options.asksFirst?.() && mcp?.changes === 'unknown' ? 'Mousse decides which calls ask at each use. Tools that say they only read do not ask.' : text.note,
      ...(tip ? { tip } : {}),
      status: cardStatus(escalation.status),
      kind: isSpecialAsk(escalation.permission) && escalation.permission.ask === 'export_memory' ? 'export_memory' : 'permission',
      ...(tools.length ? { details: { summary: `${tools.length} ${mcp?.added ? 'new ' : ''}tool${tools.length === 1 ? '' : 's'}`, items: tools, ...(more ? { more } : {}) } } : {}),
      ...(mcp && !tools.length && escalation.status === 'open' ? { loading: true as const } : {}),
      ...('ask' in escalation.permission && escalation.permission.ask === 'let_alone' ? this.options.aloneAsk?.(escalation.botId, escalation.activationId, escalation.permission) : {}),
      ...this.limitOutcome(escalation),
      ...this.permissionOutcome(escalation)
    }
  }

  /**
   * A limit that work the owner asked for waits on (its own ask, or a card its notice carries): open, Allow would carry
   * that work on while some of it still waits; allowed, it says so only for work this answer really carried on (waiting
   * its turn, or gone on since). Work that ended without going on, or failed before this build, carries nothing on.
   */
  private limitOutcome(escalation: BotEscalationRow): { carriesOn?: true; carried?: number } {
    if (!('budget' in escalation.permission)) return {}
    const linked = this.waitingOnAsk(escalation)
    if (escalation.status === 'open') return linked.some(({ row }) => workWaits(row) && row.endReason === 'budget_exhausted') ? { carriesOn: true } : {}
    if (escalation.status !== 'allowed_bot' && escalation.status !== 'allowed_once') return {}
    const answered = Date.parse(escalation.answeredAt ?? this.store.now())
    const carried = linked.filter(({ row, n }) => (row.endReason === 'room_allowed' && workWaits(row)) ||
      this.store.dispatches(row.id).some((dispatch) => dispatch.kind === 'continue' && dispatch.n > n && (dispatch.startedAt === null || dispatch.startedAt >= answered)))
    return carried.length ? { carriesOn: true, ...(carried.length > 1 ? { carried: carried.length } : {}) } : {}
  }

  /**
   * The work that waited on a limit ask, with the dispatch it ran out in: the work that owns it and every work whose
   * notice carries its card.
   */
  private waitingOnAsk(escalation: BotEscalationRow): Array<{ row: BotActivationRow; n: number }> {
    const found = new Map<string, number>()
    const owner = this.store.activation(escalation.activationId)
    if (owner?.lane === 'run' && owner.trigger.kind === 'work') found.set(owner.id, escalation.dispatchN)
    for (const message of this.store.messagesForAsk(escalation.id)) {
      const row = message.activationId ? this.store.activation(message.activationId) : undefined
      if (row?.lane !== 'run' || row.trigger.kind !== 'work') continue
      const n = Number(/_d(\d+)$/.exec(message.id)?.[1] ?? 0)
      found.set(row.id, Math.max(found.get(row.id) ?? 0, n))
    }
    return [...found].flatMap(([id, n]) => {
      const row = this.store.activation(id)
      return row ? [{ row, n }] : []
    })
  }

  /**
   * What a run's permission ask did once allowed: the run that asked carries on with it (it is still running or
   * waiting, or it went on after the answer), or the bot has it from its next run, saying so when nothing of the bot
   * was running or waiting at the answer.
   */
  private permissionOutcome(escalation: BotEscalationRow): { carriesOn?: true; idle?: true } {
    if (escalation.mode !== 'ask' || 'budget' in escalation.permission || isSpecialAsk(escalation.permission)) return {}
    if (escalation.status !== 'allowed_bot' && escalation.status !== 'allowed_once') return {}
    const asker = this.store.activation(escalation.activationId)
    const answeredAt = escalation.answeredAt ?? this.store.now()
    const answered = Date.parse(answeredAt)
    if (asker?.lane === 'run' && (stillWorking(asker) || this.store.dispatches(asker.id).some((dispatch) => dispatch.kind !== 'consult' && dispatch.n > escalation.dispatchN && dispatch.startedAt !== null && dispatch.startedAt >= answered)))
      return { carriesOn: true }
    const busy = this.store.all(
      "SELECT id FROM bot_activations WHERE bot_id = ? AND lane = 'run' AND id != ? AND created_at <= ? AND ((ended_at IS NULL AND status IN ('queued', 'running', 'waiting_grant', 'blocked')) OR ended_at > ?)",
      escalation.botId, escalation.activationId, answeredAt, answeredAt
    ).some((entry) => {
      const row = this.store.activation(entry.id as string)
      return row !== undefined && (row.status !== 'blocked' || workWaits(row))
    })
    return busy ? {} : { idle: true }
  }

  /** One bot as the Bots section and Recent list it (§5.7). */
  summary(definition: BotDefinition, now: number): BotSummary {
    const registry = this.store.registry(definition.id)
    const pausedUntil = registry?.pausedUntil ? Date.parse(registry.pausedUntil) : undefined
    // A usage-limit pause whose time has passed is over, even before the next tick clears it.
    const pausedHere = Boolean(registry?.pausedReason) && !(registry?.pausedReason === 'usage_limit' && pausedUntil !== undefined && pausedUntil <= now)
    // A picked bot (#673): rows whose pick can't run, and usage limits on the entries its rows are on. Either shows while
    // any row is held: stuck with Pick a model, or paused until the earliest reset.
    const slots = slotsOf(definition.main)
    const stuck = stuckRowsOf(registry?.model?.stuck, slots)
    const limitedUntil = BOT_MODEL_SLOT_KEYS
      .map((key) => slots[key])
      .flatMap((pick) => (pick && isPinned(pick) ? [limitOnPick(registry?.model?.limits, pick, now)?.until] : []))
      .filter((until): until is string => Boolean(until))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    const paused = pausedHere || limitedUntil !== undefined
    const error: BotError | undefined = registry?.error?.error ?? (stuck[0] ? { text: stuck[0][1].text, action: { kind: 'pick_model', label: 'Pick a model' } } : undefined)
    // Only asks whose card is posted: a chat turn's asks show once its message is complete.
    const asks = this.store.openAsks(definition.id).filter((ask) => ask.messageId !== null)
    // A chat turn no person started or waits on (a wake-up, a thread's notice or message, another bot's message) is out of
    // sight: no typing, no working line. Only what it says shows, as any reply.
    const liveRows = this.store.activationsIn(definition.id, ['queued', 'running', 'waiting_grant']).filter((row) => !unattendedChatTurn(row))
    const live = liveRows.length
    // The chat and its work are apart: the chat's turn has the status line and Stop, work its own line.
    const chatTurn = liveRows.find((row) => row.lane === 'chat' && row.status === 'running')
    // Work that waits to go on keeps its line (with Stop): held while it waits, waiting its turn once allowed.
    const workRows = this.store.activationsIn(definition.id, ['queued', 'running', 'waiting_grant', 'paused', 'blocked'])
      .filter((row) => row.lane === 'run' && (row.status !== 'blocked' || workWaits(row)))
      .sort((a, b) => (a.status === 'queued' ? 1 : 0) - (b.status === 'queued' ? 1 : 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const work: BotWorkItem[] = workRows
      .map((row) => ({
        id: row.id,
        title: row.trigger.kind === 'work' ? row.trigger.title : oneLine(row.trigger.input, 60),
        ...workWaitLine(row, { store: () => this.store }),
        startedAt: row.createdAt,
        ...(row.trigger.kind === 'schedule' ? { scheduled: true as const } : {}),
        // A model the owner asked for this work alone, not the bot's usual one: named on its line.
        ...(row.trigger.kind === 'work' && row.trigger.model?.name ? { model: { name: row.trigger.model.name, detail: workModelDetail(row.trigger.model) } } : {}),
        ...this.runningSubagents(row.id)
      }))
    // Posted chat questions and questions the bot's work waits on need the owner too ("Asked: Which flat…?"); a permission ask's words come first.
    const approval = this.store.get(`SELECT m.text, a.card_json, a.target_json FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id
      LEFT JOIN bot_messages m ON m.id = a.message_id
      WHERE a.bot_id = ? AND a.status = 'open' AND w.status = 'blocked' AND w.end_reason = 'approval'
      ORDER BY a.rowid LIMIT 1`, definition.id)
    // The legacy message begins with a raw tool id. Reuse the review's stored display names for the sidebar.
    const approvalMetadata = approval && this.options.asksFirst?.() === true ? JSON.parse(String(approval.card_json ?? '{}')) ?? {} : undefined
    const approvalLabel = approvalMetadata
      ? `${typeof approvalMetadata.actionTitle === 'string' ? approvalMetadata.actionTitle : typeof approvalMetadata.title === 'string' ? approvalMetadata.title : readableActionTitle(JSON.parse(String(approval!.target_json)).tool)} · ${typeof approvalMetadata.serverName === 'string' ? approvalMetadata.serverName : 'Your service'}`
      : String(approval?.text ?? 'Send this action?').split('\n')[0]
    const waitingOn = this.store.waitingQuestions(definition.id)
    const chatQuestions = this.store.openChatQuestions(definition.id)
    const held = this.store.heldChainSteps(definition.id)
    const chainHold = held[0] ? {
      holdId: held[0].holdId,
      held: held.length,
      to: [...new Set(held.flatMap((hold) => hold.kind === 'message' ? [String((hold.payload as { toName?: unknown }).toName ?? '')] : []))].filter(Boolean),
      wakes: held.filter((hold) => hold.kind === 'wake').length
    } : undefined
    const needsOwner = !paused && (asks.length + waitingOn.length + chatQuestions.length > 0 || held.length > 0
      || parkedNeedsOwner(this.store.activationsIn(definition.id, ['blocked']), { store: () => this.store }))
    // Threads it started that still work keep it busy: it manages them. Those that ended are listed, never counted.
    const threads = this.launchedOf(definition.id)
    const watchers = this.options.watchers?.(definition.id) ?? []
    // Its checklist: what its chat keeps, then what its work keeps while that work goes on.
    const taskThreads = [registry?.homeThreadId, ...workRows.map((row) => row.threadId)].filter((id): id is string => Boolean(id))
    const tasks = taskThreads.length ? this.options.tasks?.(taskThreads) ?? [] : []
    const managing = threads.filter(launchedActive)
    const state = botState({ paused, ...(error ? { error } : {}), openAsks: asks.length + waitingOn.length + Number(Boolean(approval)) + (live + managing.length === 0 ? chatQuestions.length : 0), liveActivations: live + managing.length })
    // Working, but every running activation waits for the internet.
    const running = liveRows.filter((row) => row.status === 'running')
    const offline = state === 'working' && running.length > 0 && running.every((row) => row.offline)
    const last = this.store.lastMessage(definition.id)
    const ended = this.store.lastEndedActivation(definition.id)
    const replied = last?.author === 'bot' && last.text ? last : this.store.lastBotReply(definition.id)
    const lastReply = replied?.text ? replyPreviewText(replied.text) : undefined
    const stateText = state === 'paused'
      ? pausedHere
        ? registry?.pausedReason === 'usage_limit' && registry.pausedUntil ? `Paused until ${clockTime(registry.pausedUntil)}` : 'Paused'
        : `Paused until ${clockTime(limitedUntil!)}`
      : state === 'stuck' ? `Needs you: ${error!.text}`
        : state === 'needs_you' ? (asks[0] ? `Wants to ${this.card(asks[0]).title}` : approval ? `${this.options.asksFirst?.() === true ? 'Waiting for you' : 'Wants to send'}: ${oneLine(approvalLabel, 80)}` : `Asked: ${oneLine((waitingOn[0] ?? chatQuestions[0])?.spec.question ?? 'Your answer is needed', 80)}`)
          : state === 'working' ? (offline ? 'Waiting for internet' : chatTurn ? 'Working…' : work.length ? workingOn(work) : managing.length ? managingLine(managing) : 'Working…')
            : last ? oneLine(last.text || last.error?.text || plainCards(last.cards)) : ''
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      ...(definition.promptDefault ? { promptEdited: true as const } : {}),
      look: normalizeBotLook(definition.look),
      state,
      ...(needsOwner ? { needsOwner: true as const } : {}),
      stateText,
      ...(offline ? { waiting: 'internet' as const } : {}),
      ...(error ? { error } : {}),
      // A message of cards alone reads as its first card's plain text.
      ...(last ? { last: { text: oneLine(last.text || last.error?.text || plainCards(last.cards) || last.attachments?.map((file) => file.name).join(', ') || '', 200), at: last.at, author: last.author } } : {}),
      ...(lastReply ? { lastReply } : {}),
      ...(ended ? { lastOutcome: ended.status === 'done' ? 'ok' as const : ended.status === 'failed' ? 'failed' as const : 'stopped' as const } : {}),
      unread: this.store.unread(definition.id, registry?.readSeq ?? 0),
      createdAt: registry?.createdAt ?? new Date(now).toISOString(),
      ...(registry?.homeThreadId ? { homeThreadId: registry.homeThreadId } : {}),
      ...(chainHold ? { chainHold } : {}),
      ...(chatTurn ? { chat: { activationId: chatTurn.id, ...(chatTurn.offline ? { offline: true as const } : {}) } } : {}),
      ...(work.length ? { work } : {}),
      ...(threads.length ? { threads } : {}),
      ...(watchers.length ? { watchers } : {}),
      ...(tasks.length ? { tasks } : {})
    }
  }

  /** `launched`, never failing the summary: a lookup that throws reads as no thread. */
  private launchedOf(botId: string): BotLaunchedThread[] {
    try {
      return this.options.launched?.(botId) ?? []
    } catch {
      return []
    }
  }

  /**
   * The subagents of a piece of work that run now (a turn neither charged nor told to the work yet), each by its title
   * and model, for its line. Read from `bots.db` (`bot_subagent_runs`), where each of their turns names what it runs as.
   */
  private runningSubagents(activationId: string): { subagents?: Array<{ title: string; model: string; lacks?: string[] }> } {
    const running = new Map<string, { title: string; model: string; lacks?: string[] }>()
    for (const entry of this.store.subagentRuns(activationId)) {
      // Its model names its entry ("Opus 5.5 on Claude Code"): which provider does this part; and what it runs without.
      if (entry.chargedAt === null && entry.deliveredAt === null)
        running.set(entry.threadId, { title: entry.spec.title, model: entry.spec.model, ...(entry.spec.lacks?.length ? { lacks: entry.spec.lacks } : {}) })
    }
    return running.size ? { subagents: [...running.values()] } : {}
  }

  /** About this bot: what it can use beyond the starter grant, its runs, and its waiting reminders. */
  detail(definition: BotDefinition, now: number): BotDetail {
    const grant = this.store.activeGrant(definition.id)
    const lastRuns = this.store.lastScheduleRuns(definition.id)
    const runs: BotRunItem[] = (this.options.schedules?.(definition.id) ?? []).map((schedule) => {
      const last = lastRuns.get(schedule.scheduleId)
      const does = scheduleDoes(schedule.prompt)
      return {
        id: schedule.scheduleId, label: schedule.label, ...(schedule.nextAt ? { nextAt: schedule.nextAt } : {}), kind: 'schedule' as const, ...(schedule.jobId ? { jobId: schedule.jobId } : {}), ...(schedule.paused ? { paused: true as const } : {}),
        ...(schedule.name ? { name: schedule.name } : {}), ...(does ? { does } : {}),
        ...(last ? { lastAt: last.endedAt, lastOutcome: last.status === 'done' ? 'ok' as const : last.status === 'failed' ? 'failed' as const : 'stopped' as const } : {})
      }
    })
    const reminders: BotReminderItem[] = this.store.waitingReminders(definition.id).filter((reminder) => !reminder.workId).map((reminder) => (
      { id: reminder.id, dueAt: reminder.dueAt, text: reminder.text, ownerSet: reminder.ownerSet, ...(reminder.work ? { work: true as const } : {}), ...(reminder.wake ? { wake: reminder.event ? wakeEventLabel(reminder.event) : '' } : {}) }
    ))
    const disabled = grant ? this.store.disabledPermissions(definition.id) : []
    // While "Allow everything" is on, a tool it gives can be switched off but not removed: it would come straight back.
    const given = grant?.manifest.fullTrust === true ? new Set(grantedPermissions(withFullTrust(grant.manifest)).filter((item) => 'tool' in item).map(permissionId)) : undefined
    const trusted = (item: BotPermissionItem) => given?.has(item.id) ? { fromFullTrust: true as const } : {}
    return {
      summary: this.summary(definition, now),
      permissions: grant ? [
        ...(this.options.defaultItems?.(definition.id) ?? []),
        ...(this.options.aloneItems?.(definition.id) ?? []),
        // Each permission "Allow everything" gives is a row of its own, so the owner can switch one off and keep the rest.
        ...this.permissionItems(definition.id, withFullTrust(grant.manifest), grant.approvedAt).filter((item) => !disabled.some((off) => off.id === item.id)).map((item) => ({ ...item, enabled: true, ...trusted(item) })),
        ...disabled.flatMap((off) => this.permissionItems(definition.id, withFullTrust(off.manifest), grant.approvedAt).filter((item) => item.id === off.id).map((item) => ({ ...item, enabled: false, note: `Switched off for this bot. ${item.note}`, ...trusted(item) })))
      ] : [],
      ...(grant ? { fullTrust: grant.manifest.fullTrust === true } : {}),
      runs,
      reminders,
      ...((usage) => (usage ? { usage } : {}))(turnUsageSummary(this.store.turnUsageSince(definition.id, 'chat', now - BOT_USAGE_WINDOW_MS))),
      ...((context) => (context ? { context } : {}))(botContextSummary(this.store.lastTurnUsage(definition.id, 'chat')))
    }
  }

  /**
   * Each permission of `manifest` beyond the starter grant, as About → Can use lists it. The owner's MCP servers are not
   * among them: every bot has them unless switched off, and their switches are About's own (`defaultItems`), one per
   * server, whatever an older grant names of them.
   */
  permissionItems(botId: string, manifest: BotManifest, approvedAt: string): BotPermissionItem[] {
    return grantedPermissions(manifest).flatMap((permission): BotPermissionItem[] => {
      if ('mcp' in permission) return []
      const id = permissionId(permission)
      const allowed = this.store.allowedAsk(botId, id)
      const grantedAt = allowed?.answeredAt ?? approvedAt
      const text = askText(permission, { budget: starterManifest().budget })
      // About's tooltip says what it gives in full, as the card's does ("use your threads": full access).
      return [{ id, title: text.title, note: text.tip ?? text.note, grantedAt, ...('tool' in permission && permission.tool === BOT_THREADS_PERMISSION ? { needsFullAccess: true as const } : {}) }]
    })
  }
}

/** A permission's id in About: its ask fingerprint (a limit's without its amount). */
export function permissionId(permission: BotPermissionRequest): string {
  return askFingerprint('budget' in permission ? { budget: { key: permission.budget.key } } : permission)
}

/**
 * The permission a switched-off row names, from the manifest it kept. "Allow everything" is expanded first, so a
 * permission only it gave (Run commands on a bot that never asked) is found too.
 */
export function switchedOffPermission(off: { id: string; manifest: BotManifest }): BotPermissionRequest | undefined {
  return grantedPermissions(withFullTrust(off.manifest)).find((item) => permissionId(item) === off.id)
}

/** The fingerprint of an ask: at most one is open per bot and fingerprint (a limit's without its amount). */
export function askFingerprintOf(request: BotAskRequest): string {
  return 'budget' in request ? permissionId(request) : askFingerprint(request)
}

/**
 * What `manifest` grants beyond the starter grant and what every bot has, one request per permission. A stored
 * `workspace` ("use files on this computer", removed) grants nothing, so it is never listed; nor are skills and the
 * automation tools an older grant names, which every bot has unless switched off (About's own switches).
 */
export function grantedPermissions(manifest: BotManifest): BotPermissionRequest[] {
  const starter = starterManifest()
  const items: BotPermissionRequest[] = []
  for (const tool of manifest.tools) if (!starter.tools.includes(tool)) items.push({ tool })
  // The bot's own tools are never permissions, and a retired one gives nothing: About never lists them.
  for (const tool of manifest.appTools) if (!starter.appTools.includes(tool) && !isOwnBotAppTool(tool) && !BOT_RETIRED_APP_TOOLS.has(tool) && !BOT_AUTOMATION_APP_TOOLS.includes(tool)) items.push({ tool })
  // The owner's MCP tools: one permission per server, whose tools the grant keeps one by one.
  const servers = new Map<string, string[]>()
  for (const pair of manifest.mcp) servers.set(pair.serverId, [...(servers.get(pair.serverId) ?? []), pair.tool])
  for (const [serverId, tools] of servers) items.push({ mcp: { serverId, tools: [...tools].sort() } })
  for (const key of BOT_BUDGET_WALL_KEYS) {
    const held = manifest.budget[key]
    const base = starter.budget[key]
    if (held !== undefined && (base === undefined || held > base)) items.push({ budget: { key, ...(base !== undefined ? { amount: held - base } : {}) } })
  }
  return items
}

/**
 * `manifest` without `permission` (About → Remove): a tool, skill or MCP tool is taken away, a limit
 * returns to the starter one. Narrowing never needs consent.
 */
export function withoutPermission(manifest: BotManifest, permission: BotPermissionRequest): BotManifest {
  const starter = starterManifest()
  const next: BotManifest = { ...manifest, tools: [...manifest.tools], appTools: [...manifest.appTools], mcp: manifest.mcp.map((pair) => ({ ...pair })), skills: [...manifest.skills], budget: { ...manifest.budget } }
  if ('path' in permission) return canonicalManifest(next)
  if ('tool' in permission) {
    next.tools = next.tools.filter((tool) => tool !== permission.tool)
    next.appTools = next.appTools.filter((tool) => tool !== permission.tool)
  } else if ('skill' in permission) next.skills = next.skills.filter((skill) => skill !== permission.skill)
  // A server's tools go together: it is one permission.
  else if ('mcp' in permission) next.mcp = next.mcp.filter((pair) => pair.serverId !== permission.mcp.serverId)
  else {
    const key = permission.budget.key
    if (starter.budget[key] === undefined) delete next.budget[key]
    else next.budget[key] = starter.budget[key]!
  }
  return canonicalManifest(next)
}

/** Restore exactly what this row kept, including older grants that hold a web tool in both lists. */
export function restorePermission(manifest: BotManifest, remembered: BotManifest, permission: BotPermissionRequest): BotManifest {
  const next = withoutPermission(manifest, permission)
  if ('path' in permission) return next
  if ('tool' in permission) {
    next.tools.push(...remembered.tools.filter((tool) => tool === permission.tool))
    next.appTools.push(...remembered.appTools.filter((tool) => tool === permission.tool))
  } else if ('skill' in permission) next.skills.push(permission.skill)
  else if ('mcp' in permission) next.mcp.push(...remembered.mcp.filter((pair) => pair.serverId === permission.mcp.serverId))
  else {
    const value = remembered.budget[permission.budget.key]
    if (value !== undefined) next.budget[permission.budget.key] = value
  }
  return canonicalManifest(next)
}
