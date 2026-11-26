import { actionPlace } from './BotAlone'
import { BOT_ALONE_HOURLY_CALLS, BOT_ALONE_DAILY_CALLS } from '../../../shared/bots/personal/definition'
import { unmistakableCredential } from '../../../shared/secretShapes'
import { botActionRefusalText, isBotActionRefusalCode, type BotActionRefusalCode } from '../../../shared/bots/personal/actionRefusal'
import { notice, quoted } from '../../../shared/mousseContext'
/** Longest an accepted Send may wait before transport dispatch, counted from the owner's tap. */
export const APPROVED_SEND_WINDOW_MS = 10 * 60_000
/** Longest a chat turn's approved call may run once sent: no turn waits on it, so this timer ends it. */
export const BOT_CHAT_ACTION_MS = 60_000
import { registerHeldCalls } from './lifecycle'
import { randomUUID } from 'node:crypto'
import type { MousseSettings } from '../../../shared/settings'
import type { BotMcpTool } from '../../../shared/bots/personal/authority'
import type { BotActivationRow, BotStore } from '../store/BotStore'
import { canonicalJson, shortHash } from '../../integrations/revision'
import { maskMemoryCredentials } from '../memory/guard'
import { plainText, type BotMcpCallOutcome } from '../mcp/BotMcp'
import type { ToolOutcome } from '../../run/mcp/appTools/types'

/** The sole feature-switch read. The file setting remains a support rollback. */
export function botAsksFirst(settings?: Pick<MousseSettings, 'experimental'>): boolean {
  return Boolean(settings && settings.experimental.botAsksFirstOff !== true)
}
export function readableActionTitle(name: string): string {
  const words = plainText(name, 160).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_ .:/-]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Send this action'
}
export const actionDigest = (value: unknown): string => shortHash(canonicalJson(value), 64)
const hiddenKey = (key: string): boolean => /(?:authorization|password|passwd|secret|token|apikey)$/i.test(key.replace(/[^a-z0-9]/gi, ''))
export const ACTION_HIDDEN_VALUE = Object.freeze({ $mousse: 'hidden', text: 'hidden · will be sent' })
/** Total serialized argument JSON, kept whole for review. */
export const ACTION_MAX_ARGUMENT_CHARS = 256_000

/** Mask before cutting, recursively: a cut must not split a credential before the mask sees it. */
export function maskedActionData(value: unknown, limit = 32_000): unknown {
  if (typeof value === 'string') return maskMemoryCredentials(value).slice(0, limit)
  if (Array.isArray(value)) return value.map(item => maskedActionData(item, limit))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskMemoryCredentials(key), hiddenKey(key) ? '[held back: looks like a secret]' : maskedActionData(item, limit)]))
  return value
}
/** Defense for older rows: an echoed hidden argument must not outlive executable storage. */
export function removeHiddenArguments(result: ToolOutcome, args: unknown, schema: unknown): ToolOutcome {
  const hidden = new Map<string, { left: boolean; right: boolean }>()
  const collect = (original: unknown): void => {
    if (typeof original === 'string' || typeof original === 'number') {
      const value = String(original)
      if (value.length >= 4) {
        const left = value.length <= 8 && /[A-Za-z0-9_]/.test(value[0]!)
        const right = value.length <= 8 && /[A-Za-z0-9_]/.test(value.at(-1)!)
        for (const variant of typeof original === 'string' ? [value, JSON.stringify(original).slice(1, -1)] : [value]) {
          const existing = hidden.get(variant)
          hidden.set(variant, { left: left && (existing?.left ?? true), right: right && (existing?.right ?? true) })
        }
      }
      return
    }
    if (Array.isArray(original)) { original.forEach(collect); return }
    if (original && typeof original === 'object') Object.values(original).forEach(collect)
  }
  reviewArguments(args, schema).hiddenValues.forEach(collect)
  const pattern = [...hidden].sort(([a], [b]) => b.length - a.length).map(([value, bounded]) => {
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return `${bounded.left ? '(?<![A-Za-z0-9_])' : ''}${literal}${bounded.right ? '(?![A-Za-z0-9_])' : ''}`
  }).join('|')
  const text = pattern ? result.text.replace(new RegExp(pattern, 'gu'), () => '[held back: looks like a secret]') : result.text
  return { ...result, text }
}
/** The continuation is text. Images are omitted explicitly, never truncated into invalid base64. */
function boundedActionResult(result: BotMcpCallOutcome): BotMcpCallOutcome {
  const note = result.images?.length ? `\n[${result.images.length} image(s) left out of the stored result.]` : ''
  const text = String(maskedActionData(result.text, Infinity))
  const build = (end: number): BotMcpCallOutcome => ({ text: `${text.slice(0, end)}${end < text.length ? '\n[Result cut to fit stored size.]' : ''}${note}`, ...(result.isError ? { isError: true } : {}), ...(result.toolReportedError ? { toolReportedError: true } : {}), ...(result.notSentInTime ? { notSentInTime: true } : {}) })
  let low = 0, high = Math.min(text.length, 32_000)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(build(mid))) <= 65_536) low = mid
    else high = mid - 1
  }
  return build(low)
}
/** Check original strings before any key-based hiding, including object keys and nested containers. */
function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') return unmistakableCredential(value)
  if (Array.isArray(value)) return value.some(containsCredential)
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]) => containsCredential(key) || containsCredential(item)))
}
/** The review follows declared properties through local references and every composition branch. */
function reviewArguments(value: unknown, schema: unknown): { args: unknown; hasHiddenValues: boolean; hiddenValues: unknown[] } {
  const hiddenValues: unknown[] = []
  const record = (item: unknown): Record<string, unknown> | undefined => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
  const localRef = (ref: string): unknown => {
    if (!ref.startsWith('#')) return undefined
    try {
      const pointer = decodeURIComponent(ref.slice(1))
      if (!pointer) return schema
      if (!pointer.startsWith('/')) return undefined
      let node: unknown = schema
      for (const part of pointer.slice(1).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
        const object = record(node)
        if (!object || !Object.hasOwn(object, key)) return undefined
        node = object[key]
      }
      return node
    } catch { return undefined }
  }
  const expand = (schemas: unknown[], inheritedUnknown: boolean): { nodes: Record<string, unknown>[]; unresolved: boolean } => {
    const nodes: Record<string, unknown>[] = []
    const seen = new Set<unknown>()
    let unresolved = inheritedUnknown
    const follow = (part: unknown, depth: number): void => {
      if (depth > 32) { unresolved = true; return }
      const node = record(part)
      if (!node || seen.has(node)) return
      seen.add(node)
      nodes.push(node)
      if (Object.hasOwn(node, '$dynamicRef')) unresolved = true
      for (const keyword of ['if', 'then', 'else']) if (Object.hasOwn(node, keyword)) follow(node[keyword], depth + 1)
      const dependents = record(node.dependentSchemas)
      if (dependents) for (const branch of Object.values(dependents)) follow(branch, depth + 1)
      if (Object.hasOwn(node, '$ref')) {
        const target = typeof node.$ref === 'string' ? localRef(node.$ref) : undefined
        if (target === undefined) unresolved = true
        else follow(target, depth + 1)
      }
      for (const kind of ['allOf', 'anyOf', 'oneOf']) {
        const branches = node[kind]
        if (Array.isArray(branches)) for (const branch of branches) follow(branch, depth + 1)
      }
    }
    schemas.forEach(part => follow(part, 0))
    return { nodes, unresolved }
  }
  const visit = (item: unknown, schemas: unknown[], inheritedUnknown = false): unknown => {
    const { nodes, unresolved } = expand(schemas, inheritedUnknown)
    if (Array.isArray(item)) return item.map((entry, i) => visit(entry, nodes.map(node => Array.isArray(node.prefixItems) && i < node.prefixItems.length ? node.prefixItems[i] : Array.isArray(node.items) ? node.items[i] : node.items), unresolved))
    if (item && typeof item === 'object') {
      const entries = Object.entries(item).map(([key, entry]) => {
        const declarations = nodes.map(node => record(node.properties)).filter(properties => properties && Object.hasOwn(properties, key))
        if ((declarations.length || unresolved) && hiddenKey(key)) { hiddenValues.push(entry); return [key, ACTION_HIDDEN_VALUE] }
        return [key, visit(entry, declarations.map(properties => properties![key]), unresolved)]
      })
      const value = Object.fromEntries(entries)
      // Escape every object in the reserved namespace, including an attempted literal wrapper.
      return Object.hasOwn(item, '$mousse') ? { $mousse: 'literal', value } : value
    }
    return item
  }
  const args = visit(value, [schema])
  return { args, hasHiddenValues: hiddenValues.length > 0, hiddenValues }
}
export interface ActionRow {
  id: string; call_key: string; bot_id: string; activation_id: string; lane?: 'chat' | 'run'; status: string
  exec_args: string | null; args_digest: string; binding_json: string; target_json: string
  answered_device: string | null; answered_at: string | null; ran_at: string | null; args_json: string; card_json: string | null; message_id: string; expires_at: string; result_json: string | null
}
/** Content-free reason survives redaction; legacy rows fall back to their stored sentence. */
function withdrawalCode(action: Pick<ActionRow, 'card_json' | 'result_json'>): BotActionRefusalCode {
  const code = JSON.parse(action.card_json ?? '{}').withdrawalCode
  if (isBotActionRefusalCode(code)) return code
  const text: string = JSON.parse(action.result_json ?? '{}').text ?? ''
  if (text.includes('work ended')) return 'bot_action_work_ended'
  if (text.includes('paused')) return 'bot_action_owner_paused'
  if (text.includes('forgotten')) return 'bot_action_owner_removed'
  if (text.includes('could not wait') || text.includes('owner changed a setting')) return 'bot_action_disabled'
  if (text.includes('schedule') && text.includes('changed')) return 'bot_action_schedule_changed'
  if (text.includes('changed since')) return 'bot_action_binding_changed'
  if (text.includes('tool') && text.includes('changed')) return 'bot_action_permission_changed'
  return 'bot_action_withdrawn'
}
const EXPIRED_WORK_TEXT = 'This expired, so nothing was sent. Carry on without it; do not ask for it again unless your owner writes.'
/** Stored outcomes are timed updates, assembled with all other work updates at dispatch. */
export function actionContinuation(action: Pick<ActionRow, 'status' | 'result_json'> & Partial<Pick<ActionRow, 'card_json'>>, scheduled = false): string {
  if (scheduled) {
    const text = actionContinuation(action)
    const split = text.indexOf('\n')
    return notice({ kind: 'bot_action' }, split < 0 ? [text] : [text.slice(0, split), quoted('held call outcome', text.slice(split + 1))])
  }
  const result = action.result_json ? JSON.parse(action.result_json) as BotMcpCallOutcome : undefined
  if (JSON.parse(action.card_json ?? '{}').ownerRemoved) return 'Your owner removed this request. Do not ask for it again unless they write.'
  if (action.status === 'expired' && result?.text !== '[forgotten]') return EXPIRED_WORK_TEXT
  const forgotten = result?.text === '[forgotten]'
  if (action.status === 'withdrawn') return forgotten ? `${botActionRefusalText(withdrawalCode({ card_json: action.card_json ?? null, result_json: action.result_json }))} The saved details of this outcome were removed.` : result?.text ?? 'Nothing was sent. Carry on without it.'
  const card = JSON.parse(action.card_json ?? '{}')
  if (result?.notSentInTime) return `${result.text} Nothing left Mousse. Decide whether a new request is needed.`
  const line = action.status === 'done' ? forgotten ? 'Your owner sent it.' : 'Your owner sent it. The tool answered:'
    : action.status === 'declined' ? 'Your owner chose Not now; nothing was sent. Carry on without it and say what you skipped.'
      : action.status === 'expired' ? 'This expired, so nothing was sent.'
      : action.status === 'uncertain' ? 'It could not be confirmed whether this went through: check before trying again.'
        : result?.toolReportedError || card.toolReportedError ? 'The tool reported an error. It may have done part of it: check before trying again. The tool answered:'
          : 'Nothing was sent. The call failed:'
  if (forgotten) return `${line} The saved details of this outcome were removed.`
  return `${line}${['done', 'failed', 'withdrawn', 'expired'].includes(action.status) ? `\n${result?.text ?? 'Carry on without it.'}` : ''}`
}
interface Host {
  store: BotStore
  enabled(): boolean
  name(botId: string): string
  refresh(tool?: BotMcpTool): Promise<boolean | void>
  park(row: BotActivationRow): void
  origin(row: BotActivationRow): 'owner' | 'unattended' | undefined
  schema(tool: BotMcpTool): unknown
  binding(row: BotActivationRow, tool: BotMcpTool): unknown | undefined
  alone?(row: BotActivationRow, tool: BotMcpTool, place: Record<string, unknown> | undefined, args: Record<string, unknown>, dispatch: string): string | undefined
  obsolete(action: ActionRow): boolean
  post(row: BotActivationRow, id: string, text: string): void
  sentAlone?(): void
  settled(row: BotActivationRow): void
  publish(messageId: string): void
  ownerAnswered(row: BotActivationRow): void
  held(): void
  forgottenRequest(row: BotActivationRow): void
  /**
   * A chat turn's held call reached `done`, `failed` or `uncertain`: its result goes to the owner's chat once, as a turn
   * of its own, written in the same `bots.db` transaction as the status (`action_result`).
   */
  resulted?(action: ActionRow): void
  /** Sends held call `action` (`running`): `assertRunning(action.id)` is its last fence before the server sees it. */
  execute(row: BotActivationRow, tool: BotMcpTool, args: Record<string, unknown>, action: ActionRow): Promise<BotMcpCallOutcome>
}
const pending = new Set(['open', 'approved', 'running'])
export class BotActionChanged extends Error { constructor(message: string, readonly code = 'bot_action_changed') { super(message) } }
const changed = () => new BotActionChanged('This changed since you saw it. Check it again before sending.')
export class BotActions {
  private warming?: Promise<void>
  private readonly executing = new Set<string>()
  /** Sending calls past their last check (`assertRunning`): from then on the server may see them, so nothing retires them. */
  private readonly dispatched = new Set<string>()
  /**
   * Sending calls a pause or `/clear` retired before they reached the server: their last check refuses them, whatever
   * happens after (a Resume while they still connect never lets them through).
   */
  private readonly retired = new Map<string, BotActionChanged>()
  private readonly answering = new Set<string>()
  constructor(private readonly host: Host) {
    registerHeldCalls(host.store.db, {
      endWork: (id, to) => this.withdrawWork(id, to),
      grantChanged: botId => this.withdrawChanged(botId),
      forgetMessage: (botId, messageId) => {
        // A chat turn's held call goes with the owner's message that turn answered, as work's goes with its request.
        const ids = host.store.all(`SELECT a.* FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id
          WHERE a.bot_id = ? AND (a.message_id = ? OR json_extract(w.trigger_json, '$.replyTo') = ?
            OR (a.lane = 'chat' AND EXISTS (SELECT 1 FROM bot_messages m WHERE m.id = ? AND m.bot_id = a.bot_id AND m.activation_id = a.activation_id AND m.author = 'owner')))`, botId, messageId, messageId, messageId)
        for (const action of ids) {
          const pending = ['open', 'approved'].includes(String(action.status))
          if (pending) this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'The request was forgotten. Nothing was sent.' }, 'bot_action_owner_removed')
          this.forgetText(botId, String(action.id))
          if (pending && action.message_id === messageId) this.host.store.run(`UPDATE bot_actions SET card_json = json_set(card_json,
            '$.ownerRemoved', json('true'), '$.removedOwnerSeq', ?, '$.removedNoteSeq', ?) WHERE id = ?`,
          host.store.ownerLastWroteSeq(botId), Number(host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `cursor:action-note:${action.activation_id}`)?.value ?? 0), String(action.id))
          if (!pending) continue
          const row = host.store.activation(String(action.activation_id))
          if (row && row.trigger.kind === 'work' && row.trigger.replyTo === messageId) host.forgottenRequest(row)
          else host.store.db.afterCommit(() => this.finish(action as unknown as ActionRow))
        }
      }
    })
  }
  /** Erase call content without erasing owner intervention facts or the run-once key. */
  forgetText(botId: string, actionId?: string): void {
    // Forgetting the source of authority also forgets the standing consent and pending snapshots.
    this.host.store.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND (key GLOB 'alone:*' OR key GLOB 'alone-ask:*')", botId)
    for (const action of this.host.store.all('SELECT message_id FROM bot_actions WHERE bot_id = ? AND (? IS NULL OR id = ?)', botId, actionId ?? null, actionId ?? null)) {
      const source = `bm:${action.message_id}`
      const statusPrefix = `${source}:status:`
      this.host.store.run(`UPDATE bot_journal SET text = ?, keys = '', json = NULL, redacted_at = COALESCE(redacted_at, ?)
        WHERE bot_id = ? AND (source_key IN (?, ?) OR substr(source_key, 1, ?) = ?)`,
      '[removed at your request]', this.host.store.now(), botId, `${source}_n1`, `${source}_n2`, statusPrefix.length, statusPrefix)
    }
    this.host.store.run(`UPDATE bot_actions SET args_json = ?, args_digest = '[forgotten]',
      card_json = json_object('text', '[forgotten]', 'ownerSeq', COALESCE(json_extract(card_json, '$.ownerSeq'), 0), 'noteSeq', COALESCE(json_extract(card_json, '$.noteSeq'), 0),
        'withdrawalCode', json_extract(card_json, '$.withdrawalCode'),
        'toolReportedError', COALESCE(json_extract(result_json, '$.toolReportedError'), json_extract(card_json, '$.toolReportedError')),
        'ownerRemoved', json_extract(card_json, '$.ownerRemoved'), 'removedOwnerSeq', json_extract(card_json, '$.removedOwnerSeq'), 'removedNoteSeq', json_extract(card_json, '$.removedNoteSeq'),
        'invocationId', json_extract(card_json, '$.invocationId')),
      place_json = NULL, bot_note = ?, result_json = ? WHERE bot_id = ? AND (? IS NULL OR id = ?)`,
    '"[forgotten]"', '[forgotten]', '{"text":"[forgotten]"}', botId, actionId ?? null, actionId ?? null)
  }
  /**
   * The activation `id` ended: its unstarted held calls are withdrawn. A chat turn's outlive it when it ends done (the
   * card stays for the owner, and the chat's slot is free); a failed or cancelled chat turn takes them with it.
   */
  withdrawWork(id: string, to?: 'done' | 'failed' | 'cancelled'): void {
    for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE activation_id = ? AND status IN ('open', 'approved') AND NOT (lane = 'chat' AND ? = 'done')", id, to ?? null))
      this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'This work ended. Nothing was sent.' }, 'bot_action_work_ended')
  }
  /**
   * The owner cleared the chat (`/clear`, inside its transaction): every chat turn's call not yet sent goes with its
   * card, so no stale Send runs it and it holds back no same request. One already sent finishes.
   */
  withdrawChat(botId: string): void {
    for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE bot_id = ? AND lane = 'chat' AND status IN ('open', 'approved')", botId))
      if (this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'Your owner cleared the chat, so nothing was sent.' }, 'bot_action_owner_removed'))
        this.host.store.db.afterCommit(() => this.finish(action as unknown as ActionRow))
    // One sent but still connecting: its last check refuses it. One the server may have seen already finishes.
    this.retireSending(botId, 'chat', new BotActionChanged('Your owner cleared the chat, so nothing was sent.', 'bot_action_owner_removed'))
  }
  /** Marks the bot's calls (of `lane`, or every lane) that are sending but not yet past their last check as retired. */
  private retireSending(botId: string, lane: 'chat' | undefined, refusal: BotActionChanged): void {
    for (const action of this.host.store.all("SELECT id FROM bot_actions WHERE bot_id = ? AND status = 'running' AND (? IS NULL OR lane = ?)", botId, lane ?? null, lane ?? null)) {
      const id = String(action.id)
      if (this.executing.has(id) && !this.dispatched.has(id) && !this.retired.has(id)) this.retired.set(id, refusal)
    }
  }
  /** Rollback retires all unstarted calls together; an already dispatched call finishes. */
  withdrawDisabled(): void {
    if (this.host.enabled()) return
    this.host.store.db.transaction(() => {
      for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE status IN ('open', 'approved')")) {
        if (this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'Your owner changed a setting, so this request was withdrawn and nothing was sent. Do not make this call again in this work; say in your report what you would have sent.' }, 'bot_action_disabled'))
          this.host.store.db.afterCommit(() => this.finish(action as unknown as ActionRow))
      }
    })
  }
  /** The bot was paused: an approved call is not sent, and a chat turn's open card is retired (no turn waits on it). */
  withdrawPaused(botId: string): void {
    for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE bot_id = ? AND (status = 'approved' OR (lane = 'chat' AND status = 'open'))", botId)) {
      if (this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'This bot was paused, so nothing was sent. Carry on without it when resumed.' }, 'bot_action_owner_paused'))
        this.host.store.db.afterCommit(() => this.finish(action as unknown as ActionRow))
    }
    // One sent but still connecting is not sent either, even when the owner resumes the bot before it connects.
    this.retireSending(botId, undefined, new BotActionChanged('This bot was paused, so nothing was sent. Carry on without it when resumed.', 'bot_action_owner_paused'))
  }
  private approvedDeadline(action: Pick<ActionRow, 'answered_at'>): number {
    return action.answered_at ? Date.parse(action.answered_at) + APPROVED_SEND_WINDOW_MS : 0
  }
  nextDueAt(botId?: string): number | undefined {
    const times = (this.host.store.all("SELECT * FROM bot_actions WHERE status = 'approved' AND (? IS NULL OR bot_id = ?)", botId ?? null, botId ?? null) as unknown as ActionRow[])
      .map(action => this.approvedDeadline(action))
    return times.length ? Math.min(...times) : undefined
  }
  private sendTimeout(action: ActionRow): boolean {
    const service = JSON.parse(action.card_json ?? '{}').serverName ?? 'The service'
    const moved = this.transition(action.id, action.status, 'failed', { isError: true, notSentInTime: true, text: `${service} couldn't be reached, so nothing was sent.` })
    if (moved) this.finish(action)
    return moved
  }
  expireDue(): void {
    for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE status = 'approved'") as unknown as ActionRow[])
      if (this.approvedDeadline(action) <= Date.parse(this.host.store.now())) this.sendTimeout(action)
  }
  withdrawChanged(botId?: string): void {
    for (const a of this.host.store.all("SELECT * FROM bot_actions WHERE status IN ('open', 'approved') AND (? IS NULL OR bot_id = ?)", botId ?? null, botId ?? null)) {
      if (this.host.obsolete(a as unknown as ActionRow) && this.transition(String(a.id), String(a.status), 'withdrawn', { text: this.host.store.activation(String(a.activation_id))?.trigger.kind === 'schedule' ? 'This schedule or its tool changed since you saw it. Nothing was sent. Carry on without it.' : 'This tool or its permission changed, so nothing was sent. Carry on without it.' }, this.host.store.activation(String(a.activation_id))?.trigger.kind === 'schedule' ? 'bot_action_schedule_changed' : 'bot_action_permission_changed')) this.host.store.db.afterCommit(() => this.finish(a as unknown as ActionRow))
    }
  }
  get(id: string): ActionRow | undefined { return this.host.store.get('SELECT * FROM bot_actions WHERE id = ?', id) as unknown as ActionRow | undefined }
  forWork(id: string): ActionRow | undefined {
    return this.host.store.get("SELECT * FROM bot_actions WHERE kind = 'mcp' AND activation_id = ? ORDER BY rowid DESC LIMIT 1", id) as unknown as ActionRow | undefined
  }
  inTurn(activationId: string, mainN: number): ActionRow | undefined {
    const action = this.forWork(activationId)
    if (!action) return undefined
    const dispatchId = JSON.parse(action.call_key)[1]
    const dispatch = this.host.store.dispatches(activationId).find(d => d.clientRequestId === dispatchId)
    return dispatch && (dispatch.n === mainN || dispatch.mainN === mainN) ? action : undefined
  }
  pendingInTurn(activationId: string, mainN: number): ActionRow | undefined {
    const action = this.inTurn(activationId, mainN)
    return action && pending.has(action.status) ? action : undefined
  }
  private ownerWroteAfter(action: ActionRow, removed = false): boolean {
    const card = JSON.parse(action.card_json ?? '{}')
    const note = Number(this.host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', action.bot_id, `cursor:action-note:${action.activation_id}`)?.value ?? 0)
    return this.host.store.ownerLastWroteSeq(action.bot_id) > Number((removed ? card.removedOwnerSeq : card.ownerSeq) ?? (action.status === 'open' ? this.host.store.message(action.message_id)?.seq : 0) ?? 0) || note > Number((removed ? card.removedNoteSeq : card.noteSeq) ?? 0)
  }
  private refuse(row: BotActivationRow, action: ActionRow, text: string): ToolOutcome {
    this.host.store.recordWorkRefusal(row.id, row.botId, `${action.id}:${text.startsWith('Your owner chose Not now') ? 'repeat' : 'loop'}`, text)
    return { text, isError: true }
  }
  hold(row: BotActivationRow, dispatch: string, tool: BotMcpTool, args: Record<string, unknown>, toolCallId?: string, invocationId?: string): ToolOutcome | Promise<ToolOutcome> {
    if (!this.host.enabled()) return { text: 'This tool cannot be used now. Carry on without it.', isError: true }
    if (!toolCallId) return { text: 'This call cannot be held without its call id. Carry on without it.', isError: true }
    const callKey = JSON.stringify([row.id, dispatch, toolCallId])
    const existing = this.host.store.get('SELECT * FROM bot_actions WHERE call_key = ?', callKey)
    if (existing?.args_digest === '[forgotten]' && existing.target_json === JSON.stringify({ server: tool.server, tool: tool.tool }))
      return { text: 'This call id belongs to a forgotten call. Nothing new was held or sent.' }
    if (existing && (existing.args_digest !== actionDigest(args) || existing.target_json !== JSON.stringify({ server: tool.server, tool: tool.tool })))
      return { text: 'This call id was already used for a different call. Nothing was held for this call.', isError: true }
    if (existing?.card_json === null && existing.result_json && !pending.has(String(existing.status))) return JSON.parse(String(existing.result_json)) as ToolOutcome
    if (existing) return pending.has(String(existing.status)) ? { text: existing.card_json === null ? 'This call is already running. Wait for its result before trying another call.' : 'This call is held for your owner. End your turn now.' } : { text: actionContinuation(existing as unknown as ActionRow), isError: true }
    const active = this.forWork(row.id)
    if (pending.has(active?.status ?? '')) return { text: active?.card_json === null ? 'A call is already running. Wait for its result before trying another call.' : 'A call is already held for your owner. End your turn now.', isError: true }
    const origin = this.host.origin(row)
    if (!origin) return { text: "This work's starting turn could not be established. Nothing was held or sent; say so in your report.", isError: true }
    const digest = actionDigest(args)
    const target = JSON.stringify({ server: tool.server, tool: tool.tool })
    const duplicate = this.host.store.get("SELECT * FROM bot_actions WHERE bot_id = ? AND target_json = ? AND args_digest = ? AND status = 'open' LIMIT 1", row.botId, target, digest) as unknown as ActionRow | undefined
    if (duplicate) return this.refuse(row, duplicate, 'An identical call is already waiting for your owner on an earlier card. If your owner sends that card, the call goes out once. Say that in your report; do not say it was not sent. Do not ask again.')
    // Unattended work and schedules share history. Owner messages and taps retain per-work history.
    const scope = origin === 'unattended'
      ? this.host.store.all('SELECT a.* FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id WHERE a.bot_id = ? AND a.target_json = ? ORDER BY a.rowid DESC', row.botId, target)
        .filter(action => { const owner = this.host.store.activation(String(action.activation_id)); return owner && this.host.origin(owner) === 'unattended' })
      : this.host.store.all('SELECT * FROM bot_actions WHERE activation_id = ? AND target_json = ? ORDER BY rowid DESC', row.id, target)
    const history = scope as unknown as ActionRow[]
    const removed = history.find(action => JSON.parse(action.card_json ?? '{}').ownerRemoved && !this.ownerWroteAfter(action, true))
    if (removed) return this.refuse(row, removed, 'Your owner removed this request. Do not ask for it again unless they write.')
    const open = history.filter(action => action.status === 'open')
    if (origin === 'unattended' && open.length >= 3)
      return this.refuse(row, open[0], 'Not sent: three requests for this tool already wait for your owner. Say in your report what you would have sent; do not ask again until one is answered.')
    const unanswered = history.filter(action => (['declined', 'expired'].includes(action.status) || origin === 'unattended' && action.status === 'open') && !this.ownerWroteAfter(action))
    const refused = unanswered.find(action => action.args_digest === digest && (row.trigger.kind !== 'schedule' || action.activation_id === row.id))
    if (refused)
      return this.refuse(row, refused, refused.status === 'expired' ? 'This expired, so nothing was sent. Carry on without it; do not ask for it again unless your owner writes.' : 'Your owner chose Not now; nothing was sent. Do not ask again unless they write; carry on without it and say in your report what you skipped.')
    const binding = this.host.binding(row, tool)
    if (!binding) return { text: 'This tool changed. Carry on without it.', isError: true }
    if (containsCredential(args)) return { text: 'This contains something that looks like a secret. It is never sent through a tool this way. Send it without that value.', isError: true }
    const exact = JSON.stringify(args)
    const review = reviewArguments(args, this.host.schema(tool))
    if (exact.length > ACTION_MAX_ARGUMENT_CHARS)
      return { text: 'These arguments exceed the 256,000-character limit for a complete review. Nothing was held or sent. Send less.', isError: true }
    const place = actionPlace(this.host.schema(tool), args)
    const uncertain = history.some(a => a.activation_id === row.id && a.status === 'uncertain')
    const exception = !uncertain && this.host.alone?.(row, tool, place, args, dispatch)
    const now = Date.parse(this.host.store.now())
    const counts = exception ? this.host.store.get(`SELECT
      SUM(CASE WHEN target_json = ? AND ran_at >= ? THEN 1 ELSE 0 END) AS hour,
      COUNT(*) AS day FROM bot_actions WHERE bot_id = ? AND kind = 'mcp' AND ran_at >= ?`, target, new Date(now - 3600_000).toISOString(), row.botId, new Date(now - 86400_000).toISOString()) : undefined
    const capped = !!exception && (Number(counts?.hour) >= BOT_ALONE_HOURLY_CALLS || Number(counts?.day) >= BOT_ALONE_DAILY_CALLS)
    const alone = exception && !capped
    const capNote = capped ? `${this.host.name(row.botId)} has used ${Number(counts?.hour) >= BOT_ALONE_HOURLY_CALLS ? `this action ${counts?.hour} times this hour` : `tools ${counts?.day} times today`}. Send this one too?` : undefined
    const id = `action_${randomUUID()}`
    const messageId = `bm_${id}`
    this.host.store.db.transaction(() => {
      const introduced = !alone && this.host.store.run("INSERT OR IGNORE INTO bot_memory_state(bot_id, key, value) VALUES(?, 'asks-first:introduced', '1')", row.botId)
      if (introduced) this.host.post(row, `bm_asks_first_${row.botId}`, `${this.host.name(row.botId)} asks you before using tools that may send or change things. Tools that say they only read don't ask.`)
      this.host.store.run(`INSERT INTO bot_actions(id, call_key, bot_id, activation_id, lane, kind, target_json, exec_args,
        args_json, args_digest, binding_json, place_json, bot_note, card_json, status, message_id, expires_at, created_at, answered_at, answered_device)
        VALUES(?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, callKey, row.botId, row.id, row.lane, JSON.stringify({ server: tool.server, tool: tool.tool }), exact, JSON.stringify(review.args), actionDigest(JSON.parse(exact)), JSON.stringify(binding), place ? JSON.stringify(place) : null, null, alone ? null : JSON.stringify({ hasHiddenValues: review.hasHiddenValues, title: capNote ?? readableActionTitle(tool.tool), actionTitle: readableActionTitle(tool.tool), serverName: tool.serverName, ...(invocationId ? { invocationId } : {}) }), alone ? 'approved' : 'open', messageId,
      // expires_at is retained for older settled rows; open rows have no deadline.
      '9999-12-31T23:59:59.999Z', this.host.store.now(), alone ? this.host.store.now() : null, alone ? exception : null)
      if (alone) return
      // Work waits for the answer; a chat turn ends at once and frees the chat (the card outlives it).
      if (row.lane !== 'chat') this.host.park(row)
      this.host.post(row, messageId, `${tool.serverName} · ${tool.tool}\n${review.hasHiddenValues ? 'Hidden values will be sent.\n' : ''}${JSON.stringify(review.args)}`)
    })
    if (alone) return this.runApproved(id).then(() => JSON.parse(this.get(id)?.result_json ?? '{"text":"Nothing was sent.","isError":true}'))
    this.host.held()
    return { text: 'This call is held for your owner. End your turn now.' }
  }
  /** The only status writer. Settlement clears executable arguments in the same statement. */
  transition(id: string, from: string, to: string, result?: BotMcpCallOutcome, withdrawalReason?: BotActionRefusalCode): boolean {
    if (to === 'uncertain') result = { ...result, text: 'It could not be confirmed whether this went through: check before trying again.' }
    // Forgotten while it ran: its words go, never that the tool reported an error (so it was sent), so the result turn or
    // notice still tells the truth (`actionResultNoticeInTx`).
    const forgotten = JSON.stringify({ text: '[forgotten]', ...(result?.toolReportedError ? { toolReportedError: true } : {}) })
    return this.host.store.db.transaction(() => {
      const moved = this.host.store.run(`UPDATE bot_actions SET status = ?, exec_args = CASE WHEN ? THEN exec_args ELSE NULL END,
        result_json = CASE WHEN args_json = '"[forgotten]"' THEN ? ELSE ? END, answered_at = CASE WHEN ? = 'open' THEN ? ELSE answered_at END,
        ran_at = CASE WHEN ? IN ('running', 'done') THEN ? ELSE ran_at END WHERE id = ? AND status = ?`,
      to, pending.has(to) ? 1 : 0, forgotten, result ? JSON.stringify(boundedActionResult(result)) : null,
      from, this.host.store.now(), to, this.host.store.now(), id, from) > 0
      if (moved && to === 'withdrawn' && this.get(id)?.card_json !== null) this.host.store.run("UPDATE bot_actions SET card_json = json_set(COALESCE(card_json, '{}'), '$.withdrawalCode', ?) WHERE id = ?", withdrawalReason ?? withdrawalCode({ card_json: null, result_json: JSON.stringify(result ?? {}) }), id)
      if (moved && result?.notSentInTime) this.host.store.run("UPDATE bot_actions SET card_json = json_set(card_json, '$.settledAt', ?) WHERE id = ?", this.host.store.now(), id)
      if (moved && this.get(id)?.card_json !== null && ['approved', 'running'].includes(to)) {
        const action = this.get(id)!
        const service = JSON.parse(action.card_json ?? '{}').serverName ?? 'the service'
        this.host.store.run('UPDATE bot_messages SET text = ? WHERE id = ?', to === 'approved' ? `Waiting for ${service}…` : 'Sending…', action.message_id)
        this.host.store.db.afterCommit(() => this.host.publish(action.message_id))
      }
      if (moved && ['declined', 'expired'].includes(to)) {
        const action = this.get(id)!
        this.host.store.run(`UPDATE bot_actions SET card_json = json_set(COALESCE(card_json, '{}'), '$.ownerSeq', ?, '$.noteSeq', ?) WHERE id = ?`,
          this.host.store.ownerLastWroteSeq(action.bot_id), Number(this.host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', action.bot_id, `cursor:action-note:${action.activation_id}`)?.value ?? 0), id)
      }
      if (moved && !pending.has(to)) {
        const action = this.get(id)!
        const row = this.host.store.activation(action.activation_id)
        if (action.args_json !== '"[forgotten]"') this.host.store.run('UPDATE bot_messages SET text = ? WHERE id = ?', result?.notSentInTime ? result.text : to === 'expired' ? 'Expired · not sent' : to === 'done' ? 'Sent' : to === 'uncertain' ? "Couldn't tell if it went through" : result?.toolReportedError ? 'The tool reported an error' : 'Not sent', action.message_id)
        if (row?.endReason === 'approval') this.host.store.moveActivation(row.id, ['blocked'], 'blocked', { endReason: 'approval_answered' })
        // A chat turn's call that was sent: its result reaches the owner once, in a turn of its own.
        if (action.lane === 'chat' && ['done', 'failed', 'uncertain'].includes(to)) this.host.resulted?.(action)
        if (action.card_json !== null) this.host.store.db.afterCommit(() => this.host.publish(action.message_id))
      }
      return moved
    })
  }

  private valid(action: ActionRow, allowCold = false): BotActivationRow | undefined {
    const row = this.host.store.activation(action.activation_id)
    if (!row || !action.exec_args || action.exec_args.length > ACTION_MAX_ARGUMENT_CHARS) return undefined
    try {
      const args: unknown = JSON.parse(action.exec_args)
      if (containsCredential(args) || actionDigest(args) !== action.args_digest) return undefined
      const target = JSON.parse(action.target_json)
      if (action.card_json === null && (!action.answered_device?.startsWith('alone:') || this.host.alone?.(row, target, actionPlace(this.host.schema(target), args as Record<string, unknown>), args as Record<string, unknown>, JSON.parse(action.call_key)[1]) !== action.answered_device)) return undefined
      const binding = this.host.binding(row, target)
      // Admission may precede the first relay listing. Execution always requires the full binding.
      if (!binding && allowCold && !this.host.obsolete(action)) return row
      const review = reviewArguments(args, this.host.schema(target))
      if (action.args_json !== '"[forgotten]"' && (canonicalJson(JSON.parse(action.args_json)) !== canonicalJson(review.args)
        || action.card_json !== null && Boolean(JSON.parse(action.card_json ?? '{}').hasHiddenValues) !== review.hasHiddenValues)) return undefined
      return binding && canonicalJson(binding) === canonicalJson(JSON.parse(action.binding_json)) ? row : undefined
    } catch { return undefined }
  }

  assertRunning(id: string): void {
    const action = this.get(id)
    if (action?.status === 'running' && this.approvedDeadline(action) <= Date.parse(this.host.store.now())) {
      this.sendTimeout(action)
      throw new BotActionChanged(botActionRefusalText('bot_action_gone'), 'bot_action_gone')
    }
    if (!action || action.status !== 'running' || !this.valid(action)) throw changed()
    // Paused (or its chat cleared) after Send marked it running, before it reached the server: it is not sent (it settles
    // failed), even if the bot was resumed since.
    const retired = this.retired.get(id)
    if (retired) throw retired
    if (this.host.store.registry(action.bot_id)?.pausedReason === 'owner') throw new BotActionChanged('This bot was paused, so nothing was sent. Carry on without it when resumed.', 'bot_action_owner_paused')
    this.dispatched.add(id)
  }
  /** Admission may retire stale lifecycle state; it never approves or dispatches the call. */
  check(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }): void {
    this.checked(input, true)
  }
  private checked(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }, settle: boolean): ActionRow {
    const action = this.get(input.actionId)
    if (!action) throw new BotActionChanged("This can't be sent any more.", 'bot_action_gone')
    if (action.result_json && JSON.parse(action.result_json).notSentInTime) throw new BotActionChanged(botActionRefusalText('bot_action_gone'), 'bot_action_gone')
    if (action.status === 'expired') throw new BotActionChanged('This expired, so nothing was sent.', 'bot_action_expired')
    if (action.status === 'withdrawn') {
      const code = withdrawalCode(action)
      throw new BotActionChanged(botActionRefusalText(code), code)
    }
    if (action.status !== 'open') throw new BotActionChanged('This was already answered.', 'bot_action_settled')
    if (action && input.answer === 'send' && this.host.store.registry(action.bot_id)?.pausedReason === 'owner') throw new BotActionChanged(`Resume ${this.host.name(action.bot_id)} to send this.`, 'bot_action_paused')
    const row = this.host.store.activation(action.activation_id)
    if (row?.trigger.kind === 'schedule' && this.host.obsolete(action)) {
      if (settle) this.host.store.db.transaction(() => {
        if (this.transition(action.id, 'open', 'withdrawn', { text: 'This schedule changed since you saw it. Nothing was sent. Carry on without it.' }, 'bot_action_schedule_changed')) this.host.store.db.afterCommit(() => this.finish(action))
      })
      throw new BotActionChanged('This changed since you saw it. Nothing was sent.', 'bot_action_schedule_changed')
    }
    if (!action || action.status !== 'open' || action.args_digest !== input.digest || !this.valid(action, true)) throw changed()
    if (input.answer === 'send' && !this.host.binding(row!, JSON.parse(action.target_json))) {
      // Admission is synchronous at the bridge. Refuse before effects, then warm for a later tap.
      this.warming ??= Promise.resolve().then(async () => { await this.host.refresh() }).catch(() => {}).finally(() => { this.warming = undefined })
      const service = JSON.parse(action.card_json ?? '{}').serverName ?? 'The service'
      throw new BotActionChanged(botActionRefusalText('bot_action_unreachable', { serverName: service }), 'bot_action_unreachable')
    }
    return action
  }
  async answer(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }): Promise<{ status: string }> {
    if (this.answering.has(input.actionId)) throw changed()
    this.answering.add(input.actionId)
    try { return await this.answerOnce(input) }
    finally { this.answering.delete(input.actionId) }
  }
  private async answerOnce(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }): Promise<{ status: string }> {
    if (input.answer === 'send') {
      const held = this.get(input.actionId)
      if (held?.status === 'open' && held.args_digest === input.digest && await this.host.refresh(JSON.parse(held.target_json)) === false) {
        const service = JSON.parse(held.card_json ?? '{}').serverName ?? 'The service'
        throw new BotActionChanged(botActionRefusalText('bot_action_unreachable', { serverName: service }), 'bot_action_unreachable')
      }
    }
    const action = this.checked(input, true)
    if (input.answer === 'not_now') {
      this.host.store.db.transaction(() => {
        if (!this.transition(action.id, 'open', 'declined', { text: 'Your owner chose Not now; nothing was sent. Carry on without it and say what you skipped.' })) throw changed()
        this.host.ownerAnswered(this.host.store.activation(action.activation_id)!)
      })
      this.finish(action)
      return { status: 'declined' }
    }
    this.host.store.db.transaction(() => {
      if (!this.transition(action.id, 'open', 'approved')) throw changed()
      this.host.ownerAnswered(this.host.store.activation(action.activation_id)!)
    })
    this.host.held()
    await this.runApproved(action.id, true)
    return { status: this.get(action.id)!.status }
  }
  private async runApproved(id: string, refresh = false): Promise<void> {
    if (refresh) await this.host.refresh()
    this.withdrawDisabled()
    const action = this.get(id)
    if (!action || action.status !== 'approved') return
    if (this.approvedDeadline(action) <= Date.parse(this.host.store.now())) { this.sendTimeout(action); return }
    if (this.host.store.registry(action.bot_id)?.pausedReason === 'owner') {
      this.transition(id, 'approved', 'withdrawn', { text: 'This bot was paused, so nothing was sent. Carry on without it when resumed.' }, 'bot_action_owner_paused')
      this.finish(action)
      return
    }
    const row = this.valid(action)
    if (!row) {
      const current = this.host.store.activation(action.activation_id)
      let intact = false
      try { intact = Boolean(action.exec_args && action.exec_args.length <= ACTION_MAX_ARGUMENT_CHARS && !containsCredential(JSON.parse(action.exec_args)) && actionDigest(JSON.parse(action.exec_args)) === action.args_digest) } catch { /* Corrupt arguments are never recoverable. */ }
      if (intact && current && !this.host.binding(current, JSON.parse(action.target_json)) && !this.host.obsolete(action)) return
      this.transition(id, 'approved', 'withdrawn', { text: 'This changed since you saw it. Nothing was sent. Carry on without it.' }, 'bot_action_binding_changed')
      this.finish(action)
      return
    }
    // Separate autocommits: a restart can distinguish approved from a call that may have reached the server.
    if (!action.exec_args || !this.transition(id, 'approved', 'running')) return
    this.executing.add(id)
    try {
      const result = await this.host.execute(row, JSON.parse(action.target_json), JSON.parse(action.exec_args), action)
      // A transport failure can have happened after the server acted. Never promise that retrying is safe.
      this.transition(id, 'running', result.isError ? result.callState ?? 'uncertain' : 'done', result)
    } catch (error) {
      this.transition(id, 'running', error instanceof BotActionChanged ? 'failed' : 'uncertain', { text: error instanceof BotActionChanged ? error.message : 'It could not be confirmed whether this went through: check before trying again.' })
    } finally {
      this.executing.delete(id)
      this.dispatched.delete(id)
      this.retired.delete(id)
    }
    if (action.card_json === null) this.host.sentAlone?.()
    this.finish(action)
  }
  private finish(action: ActionRow): void {
    const row = this.host.store.activation(action.activation_id)
    if (!row) return
    this.host.settled(row)
  }
  async retryApproved(): Promise<void> {
    for (const action of this.host.store.all("SELECT id FROM bot_actions WHERE status = 'approved'"))
      await this.runApproved(String(action.id))
  }
  async reconcile(): Promise<void> {
    // Service reads have no held card or executable arguments to replay after a restart.
    this.host.store.run(`UPDATE bot_actions SET status = 'failed', result_json = ? WHERE kind = 'secret_fetch' AND status IN ('running', 'approved')`, JSON.stringify({text:'The service read was interrupted.',isError:true}))
    this.withdrawDisabled()
    this.host.store.pruneWorkRefusals()
    this.withdrawChanged()
    this.expireDue()
    const interrupted = this.host.store.all("SELECT id FROM bot_actions WHERE status IN ('running', 'approved')")
    if (interrupted.length || this.host.store.get("SELECT 1 FROM bot_actions WHERE status = 'open' LIMIT 1")) await this.host.refresh()
    this.withdrawChanged()
    if (this.host.store.get("SELECT 1 FROM bot_actions WHERE status IN ('open', 'approved') LIMIT 1")) this.host.held()
    for (const a of interrupted) {
      const action = this.get(String(a.id))
      if (!action || this.executing.has(action.id)) continue
      if (action.status === 'running') {
        if (this.transition(action.id, 'running', 'uncertain', { text: 'It could not be confirmed whether this went through: check before trying again.' })) this.finish(action)
      } else await this.runApproved(action.id)
    }
  }
}
