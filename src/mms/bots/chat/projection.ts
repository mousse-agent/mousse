import { randomUUID } from 'node:crypto'
import { askText } from '../../../shared/bots/personal/askText'
import type { BotAskCard, BotAskStatus, BotChatMessage, BotChatQuote, BotWorkItem, BotChip, BotDetail, BotError, BotMessageKind, BotPermissionItem, BotReminderItem, BotRunItem, BotSummary } from '../../../shared/bots/personal/chat'
import { type BotDefinition, type BotLane, type BotManifest } from '../../../shared/bots/personal/definition'
import { askFingerprint, filesAsk, filesAskOf, isSpecialAsk, type BotAskRequest, type BotEscalationStatus, type BotPermissionRequest } from '../../../shared/bots/personal/escalation'
import { botStarterManifest, canonicalManifest, isOwnBotAppTool } from '../../../shared/bots/personal/manifest'
import type { BotJournalKind } from '../../../shared/bots/personal/memory'
import { botState } from '../../../shared/bots/personal/state'
import { normalizeBotLook } from '../../../shared/bots/personal/look'
import type { BotJournal } from '../seams'
import { workWaits, type BotActivationRow, type BotEscalationRow, type BotMessageRow, type BotStore } from '../store/BotStore'

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

/** Whether a limit ask's activation is work the owner asked for that its Allow goes on with (not work they stopped). */
function carriesOn(row: BotActivationRow | undefined): boolean {
  return row?.trigger.kind === 'work' && row.status !== 'cancelled'
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
}

/** The chat rows of every bot of a profile, and the summaries built from `bots.db`. */
export class BotChatProjection {
  constructor(private readonly options: {
    store: BotStore
    journal?: BotJournal
    /** `bots.message`, after the row's transaction committed. */
    emit(event: { botId: string; message: BotChatMessage }): void
    /** A bot's schedules, from the shared store (`BotEngine.listSchedules`), for About → Runs. */
    schedules?(botId: string): Array<{ scheduleId: string; label: string; nextAt?: string }>
  }) {}

  private get store(): BotStore {
    return this.options.store
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
      this.store.insertMessage({
        id,
        botId: input.botId,
        at,
        author: input.author,
        kind: input.kind,
        text: input.text,
        chips: input.chips ?? [],
        askId: input.askId ?? null,
        error: input.error ?? null,
        activationId: input.activationId ?? null,
        attachments: input.attachments?.length ? input.attachments : null,
        clientRequestId: input.clientRequestId ?? null,
        replyTo: input.replyTo ?? null
      })
      if (input.askId) this.store.setEscalationMessage(input.askId, id)
      // The journal row joins this transaction: a chat row is never kept without it (bot-context.md §4).
      this.options.journal?.appendInTx(this.store.db, {
        botId: input.botId,
        kind: journalKind(input.author, input.kind, Boolean(input.askId)),
        ...(input.lane ? { lane: input.lane } : {}),
        ...(input.activationId ? { activationId: input.activationId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        sourceKey: `bm:${id}`,
        who: input.author === 'owner' ? 'owner' : input.kind === 'error' ? 'mousse' : 'bot',
        text: input.text || (input.error?.text ?? ''),
        json: {
          v: 1,
          kind: input.kind,
          ...(input.askId ? { askId: input.askId } : {}),
          ...(input.chips?.length ? { chips: input.chips } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {})
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
    return {
      seq: row.seq,
      id: row.id,
      at: row.at,
      author: row.author,
      kind: row.kind,
      text: row.text,
      chips: row.chips,
      ...(escalation ? { ask: this.card(escalation) } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.activationId ? { activationId: row.activationId } : {}),
      ...(row.attachments?.length ? { attachments: row.attachments } : {}),
      ...(row.replyTo ? { replyTo: this.quoteOf(row.replyTo) } : {}),
      ...(row.author === 'owner' && row.clientRequestId ? { clientRequestId: row.clientRequestId } : {})
    }
  }

  /** What a reply shows of the message it answers: who wrote it and its first line. A message that is gone shows as such. */
  private quoteOf(messageId: string): BotChatQuote {
    const quoted = this.store.message(messageId)
    if (!quoted) return { id: messageId, author: 'owner', text: '', gone: true }
    const text = oneLine(quoted.text || quoted.error?.text || (quoted.attachments?.length ? quoted.attachments.map((file) => file.name).join(', ') : ''), 160)
    return { id: quoted.id, author: quoted.author, text }
  }

  card(escalation: BotEscalationRow): BotAskCard {
    const text = escalation.title !== null ? { title: escalation.title, note: escalation.note ?? '' } : askText(escalation.permission)
    return {
      askId: escalation.id,
      title: text.title,
      note: text.note,
      status: cardStatus(escalation.status),
      kind: isSpecialAsk(escalation.permission) ? 'export_memory' : 'permission',
      // A limit that work the owner asked for waits on (it took the ask over): Allow carries that work on now, unless the
      // owner stopped it meanwhile.
      ...('budget' in escalation.permission && escalation.mode === 'ask' && carriesOn(this.store.activation(escalation.activationId)) ? { carriesOn: true as const } : {}),
      ...this.permissionOutcome(escalation)
    }
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
    const paused = Boolean(registry?.pausedReason) && !(registry?.pausedReason === 'usage_limit' && pausedUntil !== undefined && pausedUntil <= now)
    const error = registry?.error?.error
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
        status: row.status === 'queued' || row.endReason === 'room_allowed' ? 'queued' as const : row.status === 'paused' || row.status === 'blocked' ? 'paused' as const : row.offline ? 'waiting_for_internet' as const : 'running' as const,
        startedAt: row.createdAt,
        ...(row.trigger.kind === 'schedule' ? { scheduled: true as const } : {})
      }))
    const state = botState({ paused, ...(error ? { error } : {}), openAsks: asks.length, liveActivations: live })
    // Working, but every running activation waits for the internet.
    const running = liveRows.filter((row) => row.status === 'running')
    const offline = state === 'working' && running.length > 0 && running.every((row) => row.offline)
    const last = this.store.lastMessage(definition.id)
    const ended = this.store.lastEndedActivation(definition.id)
    const stateText = state === 'paused'
      ? registry?.pausedReason === 'usage_limit' && registry.pausedUntil ? `Paused until ${clockTime(registry.pausedUntil)}` : 'Paused'
      : state === 'stuck' ? `Needs you: ${error!.text}`
        : state === 'needs_you' ? `Wants to ${this.card(asks[0]!).title}`
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
      ...(last ? { last: { text: oneLine(last.text || last.error?.text || '', 200), at: last.at, author: last.author } } : {}),
      ...(ended ? { lastOutcome: ended.status === 'done' ? 'ok' as const : ended.status === 'failed' ? 'failed' as const : 'stopped' as const } : {}),
      unread: this.store.unread(definition.id, registry?.readSeq ?? 0),
      createdAt: registry?.createdAt ?? new Date(now).toISOString(),
      ...(chatTurn ? { chat: { activationId: chatTurn.id, ...(chatTurn.offline ? { offline: true as const } : {}) } } : {}),
      ...(work.length ? { work } : {})
    }
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
      permissions: grant ? this.permissionItems(definition.id, grant.manifest, grant.approvedAt) : [],
      runs,
      reminders
    }
  }

  /** Each permission of `manifest` beyond the starter grant, as About → Can use lists it. */
  permissionItems(botId: string, manifest: BotManifest, approvedAt: string): BotPermissionItem[] {
    return grantedPermissions(manifest).map((permission) => {
      const id = permissionId(permission)
      const text = askText(permission, { budget: starterManifest().budget })
      return { id, title: text.title, note: text.note, grantedAt: this.store.allowedAsk(botId, id)?.answeredAt ?? approvedAt }
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
  for (const pair of manifest.mcp) items.push({ mcp: { serverId: pair.serverId, tool: pair.tool } })
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
  else if ('mcp' in permission) next.mcp = next.mcp.filter((pair) => pair.serverId !== permission.mcp.serverId || pair.tool !== permission.mcp.tool)
  else {
    const key = permission.budget.key
    if (starter.budget[key] === undefined) delete next.budget[key]
    else next.budget[key] = starter.budget[key]!
  }
  return canonicalManifest(next)
}
