import { randomUUID } from 'node:crypto'
import { askText } from '../../../shared/bots/personal/askText'
import type { BotAskCard, BotAskStatus, BotChatApplet, BotChatMessage, BotChatQuote, BotWorkItem, BotChip, BotDetail, BotError, BotMessageKind, BotPermissionItem, BotReminderItem, BotRunItem, BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_MODEL_SLOT_KEYS, type BotDefinition, type BotLane, type BotManifest } from '../../../shared/bots/personal/definition'
import { isPinned, limitOnPick, slotsOf, stuckRowsOf } from '../../../shared/bots/personal/modelSlots'
import { askFingerprint, filesAsk, filesAskOf, isSpecialAsk, mcpAskTools, type BotAskRequest, type BotEscalationStatus, type BotPermissionRequest } from '../../../shared/bots/personal/escalation'
import { BOT_THREADS_PERMISSION, botStarterManifest, canonicalManifest, isOwnBotAppTool } from '../../../shared/bots/personal/manifest'
import { BOT_OFF_HERE_MARK, offHereNote, switchedOff, type BotComputerLimit } from '../../../shared/bots/personal/computerLimit'
import type { BotJournalKind } from '../../../shared/bots/personal/memory'
import { botState } from '../../../shared/bots/personal/state'
import { normalizeBotLook } from '../../../shared/bots/personal/look'
import { workModelDetail } from '../../../shared/bots/personal/chips'
import type { BotJournal } from '../seams'
import type { BotMcpWhere } from '../mcp/BotMcp'
import { workWaits, type BotActivationRow, type BotEscalationRow, type BotMessageRow, type BotQuestionRow, type BotStore } from '../store/BotStore'
import { plainChoices, type BotChatQuestion } from '../../../shared/bots/personal/questions'
import { replyApplets } from './replyApplets'
import { takeToolImages } from './toolImages'
import type { AppletReference } from '../../../shared/applets'

/**
 * The Bot UI's view of `bots.db` (Bot Phase 1 §5.1.1, §5.7): the chat rows (`bot_messages`), each
 * written with its journal row in one transaction, and the `BotSummary` and `BotDetail` builders.
 * The renderer reads only these, so no tool row, model name or instance id ever reaches it; the
 * one exception is `BotError.action.instanceId` (a Sign in button).
 */

/**
 * The starter grant (§5.3.1, `botStarterManifest`): files in the bot's own files folder, the web,
 * its own tools (`BOT_DEFAULT_APP_TOOLS`) and an hour of work per activation, and nothing
 * outside. Pressing Create bot approves it.
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

/** One line of text for a list ("Recent"): the first line, cut. */
function oneLine(text: string, max = 120): string {
  const line = text.trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export interface PostInput {
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
  /** The message this one answers. */
  replyTo?: string
  /** A bot's message: the question it carries (its bubble). The owner's: the question it answered. */
  questionId?: string
  /**
   * For the owner's eyes only (#673: a picked model that can't run, by name): journaled as a hidden kind, which no
   * pack, search or read gives the bot, so it never learns a model's or an entry's name from its own chat.
   */
  hidden?: true
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

/** The longest part of a written answer a question's bubble shows. */
const ANSWER_SHOWN_CHARS = 120

/**
 * A question as its bubble (or a nudge of it) shows it: its answers, where it stands, and the answer once there is one;
 * for one from work, whether the work waits on it (`waits`) and whether the chat passed the answer on (`by: 'chat'`). An
 * open one with a default says what it goes with, and when; a defaulted one says what the bot went with, and what the
 * owner answered after.
 */
function questionView(question: BotQuestionRow, waits: boolean, nudge: boolean): BotChatQuestion {
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
    ...(nudge ? { nudge: true as const } : {})
  }
}

/** The chat rows of every bot of a profile, and the summaries built from `bots.db`. */
export class BotChatProjection {
  private replyParts: BotReplyParts | undefined

  constructor(private readonly options: {
    store: BotStore
    journal?: BotJournal
    /** `bots.message`, after the row's transaction committed. */
    emit(event: { botId: string; message: BotChatMessage }): void
    /** A bot's schedules, from the shared store (`BotEngine.listSchedules`), for About → Runs. */
    schedules?(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }>
    /**
     * Where a granted MCP server stands now (`BotMcp.where`), for About → Can use; undefined while the servers were not
     * read yet (nothing is shown gone then).
     */
    mcpWhere?(serverId: string): BotMcpWhere | undefined
    /** What this computer lets bots do (Settings → What bots may do here), for About → Can use. Absent: everything. */
    computerLimit?(): BotComputerLimit
    /** When a question's first follow-up is due, its bubble shown at `shownAt` (`BotEngine.firstFollowUpAt`); null for none. */
    followUpAt?(question: BotQuestionRow, shownAt: string): string | null
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
  private shown(input: PostInput): { text: string; journal: string; attachments: NonNullable<BotMessageRow['attachments']> } {
    const files = input.attachments ?? []
    if (input.author !== 'bot' || input.kind === 'error' || input.hidden) return { text: input.text, journal: input.text, attachments: [...files] }
    const parts = this.replyParts
    const made = input.threadId && parts ? replyApplets(input.text, input.threadId, () => parts.published(input.threadId!)) : undefined
    // A message of a dispatch (its thread is named) shows what that activation's tools handed it.
    const images = input.threadId ? takeToolImages(input.activationId) : []
    return {
      text: made?.text ?? input.text,
      journal: made?.journal ?? input.text,
      attachments: [...files, ...images, ...(made?.applets ?? []).map((applet) => ({ name: applet.reference.title, path: '', applet }))]
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
      const at = this.store.now()
      const shown = this.shown(input)
      // A question's bubble is journaled with its answers as text, so the chat pack, search and Forget see them. A nudge
      // of it (a later row carrying it) is journaled as its own fixed line: a copy of the answers would outlive a forget.
      const carried = input.questionId && input.author === 'bot' ? this.store.question(input.questionId) : undefined
      const asked = carried && carried.messageId === null ? carried : undefined
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
        ...(input.questionId ? { questionId: input.questionId } : {})
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
        who: input.author === 'owner' ? 'owner' : input.kind === 'error' ? 'mousse' : 'bot',
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
      return { row: this.store.message(id)!, inserted: true }
    })
    const message = this.toMessage(row)
    // Emitted once the row is durable: inside a caller's transaction, after its commit.
    if (inserted) this.store.db.afterCommit(() => this.emitMessage(this.toMessage(this.store.message(row.id) ?? row), row.botId))
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

  toMessage(row: BotMessageRow): BotChatMessage {
    const escalation = row.askId ? this.store.escalation(row.askId) : undefined
    const question = row.questionId ? this.store.question(row.questionId) : undefined
    // A question's bubble, or a nudge of it (any other bot row that carries it): its words, then its answers as plain text
    // for an app that doesn't draw them (`plainFrom`).
    const asks = question && row.author === 'bot' && question.messageId ? question : undefined
    const plain = asks && asks.spec.choices.length ? plainChoices(asks.spec) : ''
    return {
      seq: row.seq,
      id: row.id,
      at: row.at,
      author: row.author,
      kind: row.kind,
      // Reserved ids keep permission switch lines quiet after a restart without a message schema change.
      ...(row.kind === 'notice' && row.id.startsWith('bm_permission_') ? { systemLine: true as const } : {}),
      text: plain ? `${row.text}\n\n${plain}` : row.text,
      ...(plain ? { plainFrom: row.text.length } : {}),
      ...(asks ? { question: questionView(asks, asks.lane === 'run' && asks.status === 'open' && this.store.activation(asks.activationId)?.endReason === 'question', asks.messageId !== row.id) } : {}),
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

  /** What a reply shows of the message it answers: who wrote it and its first line. A message that is gone shows as such. */
  private quoteOf(messageId: string): BotChatQuote {
    const quoted = this.store.message(messageId)
    if (!quoted) return { id: messageId, author: 'owner', text: '', gone: true }
    // A message with no words is quoted by its files' and applets' names.
    const text = oneLine(quoted.text || quoted.error?.text || (quoted.attachments?.length ? quoted.attachments.map((file) => file.name).join(', ') : ''), 160)
    return { id: quoted.id, author: quoted.author, text }
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
    return {
      askId: escalation.id,
      title: text.title,
      note: text.note,
      ...(tip ? { tip } : {}),
      status: cardStatus(escalation.status),
      kind: isSpecialAsk(escalation.permission) ? 'export_memory' : 'permission',
      ...(tools.length ? { details: { summary: `${tools.length} ${mcp?.added ? 'new ' : ''}tool${tools.length === 1 ? '' : 's'}`, items: tools, ...(more ? { more } : {}) } } : {}),
      ...(mcp && !tools.length && escalation.status === 'open' ? { loading: true as const } : {}),
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
    const liveRows = this.store.activationsIn(definition.id, ['queued', 'running', 'waiting_grant'])
    const live = liveRows.length
    // The chat and its work are apart: the chat's turn has the status line and Stop, work its own line.
    const chatTurn = liveRows.find((row) => row.lane === 'chat' && row.status === 'running')
    // Work that waits to go on keeps its line (with Stop): held while it waits, waiting its turn once allowed.
    const work: BotWorkItem[] = this.store.activationsIn(definition.id, ['queued', 'running', 'waiting_grant', 'paused', 'blocked'])
      .filter((row) => row.lane === 'run' && (row.status !== 'blocked' || workWaits(row)))
      .sort((a, b) => (a.status === 'queued' ? 1 : 0) - (b.status === 'queued' ? 1 : 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        title: row.trigger.kind === 'work' ? row.trigger.title : oneLine(row.trigger.input, 60),
        status: row.status === 'queued' || row.endReason === 'room_allowed' || row.endReason === 'question_answered' ? 'queued' as const : row.status === 'paused' || row.status === 'blocked' ? 'paused' as const : row.offline ? 'waiting_for_internet' as const : 'running' as const,
        // Held for the owner's answer to the question it asked them: an older app shows "held", a new one "waiting on you".
        ...(row.status === 'blocked' && row.endReason === 'question' ? { waitsFor: 'answer' as const } : {}),
        startedAt: row.createdAt,
        ...(row.trigger.kind === 'schedule' ? { scheduled: true as const } : {}),
        // A model the owner asked for this work alone, not the bot's usual one: named on its line.
        ...(row.trigger.kind === 'work' && row.trigger.model?.name ? { model: { name: row.trigger.model.name, detail: workModelDetail(row.trigger.model) } } : {}),
        ...this.runningSubagents(row.id)
      }))
    // Questions the bot's work waits on need the owner too ("Asked: Which flat…?"); a permission ask's words come first.
    const waitingOn = this.store.waitingQuestions(definition.id)
    const state = botState({ paused, ...(error ? { error } : {}), openAsks: asks.length + waitingOn.length, liveActivations: live })
    // Working, but every running activation waits for the internet.
    const running = liveRows.filter((row) => row.status === 'running')
    const offline = state === 'working' && running.length > 0 && running.every((row) => row.offline)
    const last = this.store.lastMessage(definition.id)
    const ended = this.store.lastEndedActivation(definition.id)
    const stateText = state === 'paused'
      ? pausedHere
        ? registry?.pausedReason === 'usage_limit' && registry.pausedUntil ? `Paused until ${clockTime(registry.pausedUntil)}` : 'Paused'
        : `Paused until ${clockTime(limitedUntil!)}`
      : state === 'stuck' ? `Needs you: ${error!.text}`
        : state === 'needs_you' ? (asks[0] ? `Wants to ${this.card(asks[0]).title}` : `Asked: ${oneLine(waitingOn[0]!.spec.question, 80)}`)
          : state === 'working' ? (offline ? 'Waiting for internet' : chatTurn || !work.length ? 'Working…' : workingOn(work))
            : last ? oneLine(last.text || last.error?.text || '') : ''
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      look: normalizeBotLook(definition.look),
      state,
      stateText,
      ...(offline ? { waiting: 'internet' as const } : {}),
      ...(error ? { error } : {}),
      ...(last ? { last: { text: oneLine(last.text || last.error?.text || last.attachments?.map((file) => file.name).join(', ') || '', 200), at: last.at, author: last.author } } : {}),
      ...(ended ? { lastOutcome: ended.status === 'done' ? 'ok' as const : ended.status === 'failed' ? 'failed' as const : 'stopped' as const } : {}),
      unread: this.store.unread(definition.id, registry?.readSeq ?? 0),
      createdAt: registry?.createdAt ?? new Date(now).toISOString(),
      ...(registry?.homeThreadId ? { homeThreadId: registry.homeThreadId } : {}),
      ...(chatTurn ? { chat: { activationId: chatTurn.id, ...(chatTurn.offline ? { offline: true as const } : {}) } } : {}),
      ...(work.length ? { work } : {})
    }
  }

  /**
   * The subagents of a piece of work that run now (a subagent turn not ended), each by its title and model, for its line.
   * Read from `bots.db`, where each of their turns names what it runs as.
   */
  private runningSubagents(activationId: string): { subagents?: Array<{ title: string; model: string; lacks?: string[] }> } {
    const running = new Map<string, { title: string; model: string; lacks?: string[] }>()
    for (const dispatch of this.store.dispatches(activationId)) {
      const spec = dispatch.prompt.subagent
      // Its model names its entry ("Opus 5.5 on Claude Code"): which provider does this part; and what it runs without.
      if (dispatch.kind === 'subagent' && dispatch.endedAt === null && spec)
        running.set(dispatch.threadId, { title: spec.title, model: spec.model, ...(spec.lacks?.length ? { lacks: spec.lacks } : {}) })
    }
    return running.size ? { subagents: [...running.values()] } : {}
  }

  /** About this bot: what it can use beyond the starter grant, its runs, and its waiting reminders. */
  detail(definition: BotDefinition, now: number): BotDetail {
    const grant = this.store.activeGrant(definition.id)
    const runs: BotRunItem[] = (this.options.schedules?.(definition.id) ?? []).map((schedule) => (
      { id: schedule.scheduleId, label: schedule.label, ...(schedule.nextAt ? { nextAt: schedule.nextAt } : {}), kind: 'schedule' as const }
    ))
    const reminders: BotReminderItem[] = this.store.waitingReminders(definition.id).map((reminder) => (
      { id: reminder.id, dueAt: reminder.dueAt, text: reminder.text, ...(reminder.work ? { work: true as const } : {}) }
    ))
    return {
      summary: this.summary(definition, now),
      permissions: grant ? [
        ...this.permissionItems(definition.id, grant.manifest, grant.approvedAt).filter((item) => !this.store.disabledPermissions(definition.id).some((off) => off.id === item.id)).map((item) => ({ ...item, enabled: true })),
        ...this.store.disabledPermissions(definition.id).flatMap((off) => this.permissionItems(definition.id, off.manifest, grant.approvedAt).filter((item) => item.id === off.id).map((item) => ({ ...item, enabled: false, note: `Switched off for this bot. ${item.note}` })))
      ] : [],
      runs,
      reminders
    }
  }

  /**
   * Each permission of `manifest` beyond the starter grant, as About → Can use lists it. The owner's MCP tools are one
   * line per server ("Use your GitHub tools"). One that gives nothing now says what is true (gone from Mousse, switched
   * off, changed since it was allowed, MCP turned off, or switched off on this computer) and is marked so; Remove is there
   * as an option, not as the fix.
   */
  permissionItems(botId: string, manifest: BotManifest, approvedAt: string): BotPermissionItem[] {
    const limit = this.options.computerLimit?.()
    return grantedPermissions(manifest).map((permission): BotPermissionItem => {
      const id = permissionId(permission)
      const allowed = this.store.allowedAsk(botId, id)
      const grantedAt = allowed?.answeredAt ?? approvedAt
      if ('mcp' in permission) {
        const where = this.options.mcpWhere?.(permission.mcp.serverId)
        const live = where?.state === 'on' || where?.state === 'changed' ? where.server : undefined
        const asked = allowed && 'mcp' in allowed.permission ? allowed.permission.mcp.name : undefined
        const name = live?.name ?? (where?.state === 'off' ? where.name : undefined) ?? asked ?? 'an MCP server'
        const title = `use your ${name} tools`
        const tools = mcpAskTools(permission.mcp)
        if (where?.state === 'gone') return { id, title, note: `${name} isn't set up in Mousse any more, so this gives nothing now. You can remove it.`, grantedAt, gone: true as const, mark: 'Gone from Mousse' }
        if (where?.state === 'off') return { id, title, note: `${name} is switched off in Settings → Skills & MCP, so this gives nothing while it is. Switch it on there to use it again, or remove it.`, grantedAt, mark: 'Switched off' }
        if (where?.state === 'mcp_off') return { id, title, note: `MCP is turned off in Settings → Skills & MCP, so this gives nothing while it is. Turn it on there to use it again, or remove it.`, grantedAt, mark: 'MCP is off' }
        if (where?.state === 'changed') return { id, title, note: `${name} was changed since you allowed it (it runs from another address or command now), so this gives nothing until ${name} is allowed again. The bot asks when it needs it; you can also remove it.`, grantedAt, mark: 'Changed' }
        const shown = tools.slice(0, 6).join(', ')
        const unusable = live?.unusable.length ? ` (${live.unusable.length} more of its tools can't be used by a bot)` : ''
        return { id, title, note: `${tools.length} tool${tools.length === 1 ? '' : 's'}: ${shown}${tools.length > 6 ? ', …' : ''}${unusable}`, grantedAt }
      }
      const text = askText(permission, { budget: starterManifest().budget })
      // Kept in the grant, but this computer has it switched off: it gives nothing here until it is switched on.
      const off = limit ? switchedOff(limit, permission) : undefined
      if (limit && off) return { id, title: text.title, note: offHereNote(off, limit), grantedAt, mark: BOT_OFF_HERE_MARK, ...('tool' in permission && permission.tool === BOT_THREADS_PERMISSION ? { needsFullAccess: true as const } : {}) }
      // About's tooltip says what it gives in full, as the card's does ("use your threads": full access).
      return { id, title: text.title, note: text.tip ?? text.note, grantedAt, ...('tool' in permission && permission.tool === BOT_THREADS_PERMISSION ? { needsFullAccess: true as const } : {}) }
    })
  }
}

/** A permission's id in About: its ask fingerprint (a limit's without its amount). */
export function permissionId(permission: BotPermissionRequest): string {
  return askFingerprint('budget' in permission ? { budget: { key: permission.budget.key } } : permission)
}

/**
 * The fingerprint of an ask: at most one is open per bot and fingerprint (a limit's without its
 * amount, a folder's as the one file ask).
 */
export function askFingerprintOf(request: BotAskRequest): string {
  return 'budget' in request ? permissionId(request) : askFingerprint(filesAskOf(request))
}

/** What `manifest` grants beyond the starter grant, one request per permission. */
export function grantedPermissions(manifest: BotManifest): BotPermissionRequest[] {
  const starter = starterManifest()
  const items: BotPermissionRequest[] = []
  // File access is one permission, however many folders an older grant names (`filesAsk`).
  if (manifest.workspace) items.push(filesAsk())
  for (const tool of manifest.tools) if (!starter.tools.includes(tool)) items.push({ tool })
  // The bot's own tools are never permissions: About never lists them.
  for (const tool of manifest.appTools) if (!starter.appTools.includes(tool) && !isOwnBotAppTool(tool)) items.push({ tool })
  for (const skill of manifest.skills) items.push({ skill })
  // The owner's MCP tools: one permission per server, whose tools the grant keeps one by one.
  const servers = new Map<string, string[]>()
  for (const pair of manifest.mcp) servers.set(pair.serverId, [...(servers.get(pair.serverId) ?? []), pair.tool])
  for (const [serverId, tools] of servers) items.push({ mcp: { serverId, tools: [...tools].sort() } })
  for (const key of ['maxActiveMs', 'maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const) {
    const held = manifest.budget[key]
    const base = starter.budget[key]
    if (held !== undefined && (base === undefined || held > base)) items.push({ budget: { key, ...(base !== undefined ? { amount: held - base } : {}) } })
  }
  return items
}

/**
 * `manifest` without `permission` (About → Remove): file access goes as a whole, a tool, skill or
 * MCP tool is taken away, a limit returns to the starter one. Narrowing never needs consent.
 */
export function withoutPermission(manifest: BotManifest, permission: BotPermissionRequest): BotManifest {
  const starter = starterManifest()
  const next: BotManifest = { ...manifest, tools: [...manifest.tools], appTools: [...manifest.appTools], mcp: manifest.mcp.map((pair) => ({ ...pair })), skills: [...manifest.skills], budget: { ...manifest.budget } }
  if ('path' in permission) next.workspace = null
  else if ('tool' in permission) {
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
  if ('path' in permission) next.workspace = remembered.workspace
  else if ('tool' in permission) {
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
