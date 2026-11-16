import { MAX_SAME_WAKES } from '../../../shared/bots/personal/wakes'
import { registerHeldCalls } from './lifecycle'
import { randomUUID } from 'node:crypto'
import type { MousseSettings } from '../../../shared/settings'
import type { BotMcpTool } from '../../../shared/bots/personal/authority'
import type { BotActivationRow, BotStore } from '../store/BotStore'
import { canonicalJson, shortHash } from '../../integrations/revision'
import { maskMemoryCredentials } from '../memory/guard'
import type { BotMcpCallOutcome } from '../mcp/BotMcp'
import type { ToolOutcome } from '../../run/mcp/appTools/types'

/** The sole feature-switch read. No UI sets it until the complete feature ships. */
export function botAsksFirst(settings?: Pick<MousseSettings, 'experimental'>): boolean {
  return settings?.experimental.botAsksFirst === true
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
  const build = (end: number): BotMcpCallOutcome => ({ text: `${text.slice(0, end)}${end < text.length ? '\n[Result cut to fit stored size.]' : ''}${note}`, ...(result.isError ? { isError: true } : {}), ...(result.toolReportedError ? { toolReportedError: true } : {}) })
  let low = 0, high = Math.min(text.length, 32_000)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(build(mid))) <= 65_536) low = mid
    else high = mid - 1
  }
  return build(low)
}
// Deliberately narrower than the memory heuristic: IDs, attachments and prose need review, not refusal.
const UNMISTAKABLE_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}\b|ya29\.[0-9A-Za-z_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/
function unmistakableCredential(text: string): boolean {
  if (UNMISTAKABLE_KEYS.test(text)) return true
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    try {
      const url = new URL(match[0])
      if (url.password || [...url.searchParams].some(([key, value]) => value && /(?:token|key|secret|signature|password|passwd|pwd|authorization|credentials?)$/i.test(key))) return true
    } catch { /* Invalid addresses remain visible to the owner. */ }
  }
  return false
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
  id: string; call_key: string; bot_id: string; activation_id: string; status: string
  exec_args: string | null; args_digest: string; binding_json: string; target_json: string
  answered_at: string | null; ran_at: string | null; args_json: string; card_json: string | null; message_id: string; expires_at: string; result_json: string | null
}
/** Stored outcomes are timed updates, assembled with all other work updates at dispatch. */
export function actionContinuation(action: Pick<ActionRow, 'status' | 'result_json'>): string {
  const result = action.result_json ? JSON.parse(action.result_json) as BotMcpCallOutcome : undefined
  const line = action.status === 'done' ? 'Your owner sent it. The tool answered:'
    : action.status === 'declined' ? 'Your owner chose not to send this: carry on without it and say what you skipped.'
      : action.status === 'expired' ? 'This call expired. Nothing was sent; do not try the same call again without a new reason.'
      : action.status === 'withdrawn' ? 'This call was withdrawn. Nothing was sent.'
      : action.status === 'uncertain' ? 'It could not be confirmed whether this went through: check before trying again.'
        : result?.toolReportedError ? 'The tool reported an error. It may have done part of it: check before trying again. The tool answered:'
          : 'Nothing was sent. The call failed:'
  return `${line}${['done', 'failed', 'withdrawn', 'expired'].includes(action.status) ? `\n${result?.text ?? 'Carry on without it.'}` : ''}`
}
interface Host {
  store: BotStore
  enabled(): boolean
  refresh(): Promise<void>
  park(row: BotActivationRow): void
  schema(tool: BotMcpTool): unknown
  binding(row: BotActivationRow, tool: BotMcpTool): unknown | undefined
  obsolete(action: ActionRow): boolean
  post(row: BotActivationRow, id: string, text: string): void
  settled(row: BotActivationRow): void
  publish(messageId: string): void
  ownerAnswered(row: BotActivationRow): void
  held(): void
  execute(row: BotActivationRow, tool: BotMcpTool, args: Record<string, unknown>): Promise<BotMcpCallOutcome>
}
const pending = new Set(['open', 'approved', 'running'])
export class BotActionChanged extends Error { readonly code = 'bot_action_changed' }
const changed = () => new BotActionChanged('This changed since you saw it. Redraw the action.')
export class BotActions {
  private readonly executing = new Set<string>()
  constructor(private readonly host: Host) {
    registerHeldCalls(host.store.db, {
      endWork: id => this.withdrawWork(id),
      forgetMessage: (botId, messageId) => {
        if (!host.enabled()) return
        const ids = host.store.all(`SELECT a.* FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id
          WHERE a.bot_id = ? AND (a.message_id = ? OR json_extract(w.trigger_json, '$.replyTo') = ?)`, botId, messageId, messageId)
        for (const action of ids) {
          const pending = ['open', 'approved'].includes(String(action.status))
          if (pending) this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'The request was forgotten. Nothing was sent.' })
          this.forgetText(botId, String(action.id))
          if (!pending) continue
          const row = host.store.activation(String(action.activation_id))
          if (row && host.store.moveActivation(row.id, ['blocked'], 'cancelled', { endReason: 'forgotten', result: 'This work ended because its request was forgotten.' }))
            host.post(row, `bm_${action.id}_forgotten`, 'This work ended because its request was forgotten.')
        }
      }
    })
  }
  /** Erase call content without erasing owner intervention facts or the run-once key. */
  forgetText(botId: string, actionId?: string): void {
    if (!this.host.enabled()) return
    this.host.store.run(`UPDATE bot_actions SET args_json = ?, args_digest = '[forgotten]',
      card_json = json_object('text', '[forgotten]', 'ownerSeq', COALESCE(json_extract(card_json, '$.ownerSeq'), 0), 'noteSeq', COALESCE(json_extract(card_json, '$.noteSeq'), 0)),
      bot_note = ?, result_json = ? WHERE bot_id = ? AND (? IS NULL OR id = ?)`,
    '"[forgotten]"', '[forgotten]', '{"text":"[forgotten]"}', botId, actionId ?? null, actionId ?? null)
  }
  withdrawWork(id: string): void {
    if (!this.host.enabled()) return
    for (const action of this.host.store.all("SELECT * FROM bot_actions WHERE activation_id = ? AND status IN ('open', 'approved')", id))
      this.transition(String(action.id), String(action.status), 'withdrawn', { text: 'This work ended. Nothing was sent.' })
  }
  expireDue(): void {
    if (!this.host.enabled()) return
    for (const a of this.host.store.all("SELECT * FROM bot_actions WHERE status IN ('open', 'approved') AND expires_at <= ?", this.host.store.now())) {
      if (this.transition(String(a.id), String(a.status), 'expired', { text: 'This call expired. Carry on without it; do not try the same call again without a new reason.' })) this.finish(a as unknown as ActionRow)
    }
  }
  withdrawChanged(): void {
    if (!this.host.enabled()) return
    for (const a of this.host.store.all("SELECT * FROM bot_actions WHERE status IN ('open', 'approved')")) {
      if (this.host.obsolete(a as unknown as ActionRow) && this.transition(String(a.id), String(a.status), 'withdrawn', { text: 'This tool or its permission changed. Carry on without it.' })) this.host.store.db.afterCommit(() => this.finish(a as unknown as ActionRow))
    }
  }
  get(id: string): ActionRow | undefined { return this.host.store.get('SELECT * FROM bot_actions WHERE id = ?', id) as unknown as ActionRow | undefined }
  forWork(id: string): ActionRow | undefined {
    return this.host.store.get("SELECT * FROM bot_actions WHERE activation_id = ? ORDER BY rowid DESC LIMIT 1", id) as unknown as ActionRow | undefined
  }
  pendingInTurn(activationId: string, mainN: number): ActionRow | undefined {
    const action = this.forWork(activationId)
    if (!action || !pending.has(action.status)) return undefined
    const dispatchId = JSON.parse(action.call_key)[1]
    const dispatch = this.host.store.dispatches(activationId).find(d => d.clientRequestId === dispatchId)
    return dispatch && (dispatch.n === mainN || dispatch.mainN === mainN) ? action : undefined
  }
  private ownerWroteAfter(action: ActionRow): boolean {
    const card = JSON.parse(action.card_json ?? '{}')
    const note = Number(this.host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', action.bot_id, `cursor:action-note:${action.activation_id}`)?.value ?? 0)
    return this.host.store.ownerLastWroteSeq(action.bot_id) > Number(card.ownerSeq ?? 0) || note > Number(card.noteSeq ?? 0)
  }
  private refuse(row: BotActivationRow, action: ActionRow, text: string): ToolOutcome {
    // A lost tool reply must not lose the refusal: use the same ordered notes as other updates.
    if (!this.host.store.get('SELECT 1 FROM bot_work_notes WHERE activation_id = ? AND from_message = ? AND text = ?', row.id, action.message_id, text))
      this.host.store.addWorkNote(row.id, row.botId, text, action.message_id)
    return { text, isError: true }
  }
  hold(row: BotActivationRow, dispatch: string, tool: BotMcpTool, args: Record<string, unknown>, toolCallId?: string): ToolOutcome {
    if (!toolCallId) return { text: 'This call cannot be held without its call id. Carry on without it.', isError: true }
    const callKey = JSON.stringify([row.id, dispatch, toolCallId])
    const existing = this.host.store.get('SELECT id FROM bot_actions WHERE call_key = ?', callKey)
    if (existing) return { text: 'This call is held for your owner. End your turn now.' }
    if (pending.has(this.forWork(row.id)?.status ?? '')) return { text: 'A call is already held for your owner. End your turn now.', isError: true }
    const declined = this.host.store.all("SELECT * FROM bot_actions WHERE activation_id = ? AND target_json = ? AND status = 'declined' ORDER BY rowid DESC", row.id, JSON.stringify({ server: tool.server, tool: tool.tool })) as unknown as ActionRow[]
    const unanswered = declined.filter(action => !this.ownerWroteAfter(action))
    if (unanswered.length >= MAX_SAME_WAKES)
      return this.refuse(row, unanswered[0], 'Your owner said no three times. Say what you need in your report and wait for them to write.')
    const digest = actionDigest(args)
    const refused = this.host.store.all("SELECT * FROM bot_actions WHERE activation_id = ? AND target_json = ? AND args_digest = ? AND status IN ('declined', 'expired') ORDER BY rowid DESC", row.id, JSON.stringify({ server: tool.server, tool: tool.tool }), digest)[0]
    if (refused && !this.ownerWroteAfter(refused as unknown as ActionRow))
      return this.refuse(row, refused as unknown as ActionRow, 'Your owner declined exactly this, or it expired. Do not ask again unless they write. Carry on without it.')
    const binding = this.host.binding(row, tool)
    if (!binding) return { text: 'This tool changed. Carry on without it.', isError: true }
    if (containsCredential(args)) return { text: 'This contains something that looks like a secret. It is never sent through a tool this way. Send it without that value.', isError: true }
    const exact = JSON.stringify(args)
    const review = reviewArguments(args, this.host.schema(tool))
    if (exact.length > ACTION_MAX_ARGUMENT_CHARS)
      return { text: 'These arguments exceed the 256,000-character limit for a complete review. Nothing was held or sent. Send less.', isError: true }
    const id = `action_${randomUUID()}`
    const messageId = `bm_${id}`
    this.host.store.db.transaction(() => {
      this.host.store.run(`INSERT INTO bot_actions(id, call_key, bot_id, activation_id, lane, kind, target_json, exec_args,
        args_json, args_digest, binding_json, card_json, status, message_id, expires_at, created_at)
        VALUES(?, ?, ?, ?, 'run', 'mcp', ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id, callKey, row.botId, row.id, JSON.stringify({ server: tool.server, tool: tool.tool }), exact, JSON.stringify(review.args), actionDigest(JSON.parse(exact)), JSON.stringify(binding), JSON.stringify({ hasHiddenValues: review.hasHiddenValues }), messageId,
      new Date(Date.parse(this.host.store.now()) + 48 * 3600_000).toISOString(), this.host.store.now())
      this.host.park(row)
      this.host.post(row, messageId, `${tool.serverName} · ${tool.tool}\n${review.hasHiddenValues ? 'Hidden values will be sent.\n' : ''}${JSON.stringify(review.args)}`)
    })
    this.host.held()
    return { text: 'This call is held for your owner. End your turn now.' }
  }
  /** The only status writer. Settlement clears executable arguments in the same statement. */
  transition(id: string, from: string, to: string, result?: BotMcpCallOutcome): boolean {
    return this.host.store.db.transaction(() => {
      const moved = this.host.store.run(`UPDATE bot_actions SET status = ?, exec_args = CASE WHEN ? THEN exec_args ELSE NULL END,
        result_json = ?, answered_at = CASE WHEN ? = 'open' THEN ? ELSE answered_at END,
        ran_at = CASE WHEN ? IN ('running', 'done') THEN ? ELSE ran_at END WHERE id = ? AND status = ?`,
      to, pending.has(to) ? 1 : 0, result ? JSON.stringify(boundedActionResult(result)) : null,
      from, this.host.store.now(), to, this.host.store.now(), id, from) > 0
      if (moved && ['declined', 'expired'].includes(to)) {
        const action = this.get(id)!
        this.host.store.run(`UPDATE bot_actions SET card_json = json_set(COALESCE(card_json, '{}'), '$.ownerSeq', ?, '$.noteSeq', ?) WHERE id = ?`,
          this.host.store.ownerLastWroteSeq(action.bot_id), Number(this.host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', action.bot_id, `cursor:action-note:${action.activation_id}`)?.value ?? 0), id)
      }
      if (moved && !pending.has(to)) {
        const action = this.get(id)!
        const row = this.host.store.activation(action.activation_id)
        this.host.store.run('UPDATE bot_messages SET text = ? WHERE id = ?', to === 'expired' ? 'Expired · not sent' : to === 'done' ? 'Sent' : to === 'uncertain' ? "Couldn't tell if it went through" : result?.toolReportedError ? 'The tool reported an error' : 'Not sent', action.message_id)
        if (row?.endReason === 'approval') this.host.store.moveActivation(row.id, ['blocked'], 'blocked', { endReason: 'approval_answered' })
        this.host.store.db.afterCommit(() => this.host.publish(action.message_id))
      }
      return moved
    })
  }

  private valid(action: ActionRow): BotActivationRow | undefined {
    const row = this.host.store.activation(action.activation_id)
    if (!row || !action.exec_args || action.exec_args.length > ACTION_MAX_ARGUMENT_CHARS || Date.parse(action.expires_at) <= Date.parse(this.host.store.now())) return undefined
    try {
      const args: unknown = JSON.parse(action.exec_args)
      if (containsCredential(args) || actionDigest(args) !== action.args_digest) return undefined
      const review = reviewArguments(args, this.host.schema(JSON.parse(action.target_json)))
      if (action.args_json !== '"[forgotten]"' && (canonicalJson(JSON.parse(action.args_json)) !== canonicalJson(review.args)
        || Boolean(JSON.parse(action.card_json ?? '{}').hasHiddenValues) !== review.hasHiddenValues)) return undefined
      const binding = this.host.binding(row, JSON.parse(action.target_json))
      return binding && canonicalJson(binding) === canonicalJson(JSON.parse(action.binding_json)) ? row : undefined
    } catch { return undefined }
  }

  assertRunning(id: string): void {
    const action = this.get(id)
    if (!action || action.status !== 'running' || !this.valid(action)) throw changed()
  }
  async answer(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }): Promise<{ status: string }> {
    if (!this.host.enabled()) throw new BotActionChanged('Asks first is not available while its switch is off.')
    await this.host.refresh()
    const action = this.get(input.actionId)
    if (action && ['open', 'approved'].includes(action.status) && Date.parse(action.expires_at) <= Date.parse(this.host.store.now())) {
      this.expireDue()
      throw new BotActionChanged('This call expired. Nothing was sent.')
    }
    if (action && input.answer === 'send' && this.host.store.registry(action.bot_id)?.pausedReason === 'owner') throw new BotActionChanged('Resume this bot before sending.')
    if (!action || action.status !== 'open' || action.args_digest !== input.digest || !this.valid(action)) throw changed()
    if (input.answer === 'not_now') {
      this.host.store.db.transaction(() => {
        if (!this.transition(action.id, 'open', 'declined', { text: 'Your owner chose not to send this: carry on without it and say what you skipped.' })) throw changed()
        this.host.ownerAnswered(this.host.store.activation(action.activation_id)!)
      })
      this.finish(action)
      return { status: 'declined' }
    }
    this.host.store.db.transaction(() => {
      if (!this.transition(action.id, 'open', 'approved')) throw changed()
      this.host.ownerAnswered(this.host.store.activation(action.activation_id)!)
    })
    await this.runApproved(action.id)
    return { status: this.get(action.id)!.status }
  }
  private async runApproved(id: string): Promise<void> {
    const action = this.get(id)
    if (!action || action.status !== 'approved') return
    if (this.host.store.registry(action.bot_id)?.pausedReason === 'owner') {
      this.transition(id, 'approved', 'withdrawn', { text: 'This bot was paused by its owner. Nothing was sent; carry on without it when resumed.' })
      this.finish(action)
      return
    }
    const row = this.valid(action)
    if (!row) {
      if (Date.parse(action.expires_at) > Date.parse(this.host.store.now()) && !this.host.obsolete(action)) return
      this.transition(id, 'approved', Date.parse(action.expires_at) <= Date.parse(this.host.store.now()) ? 'expired' : 'withdrawn', { text: 'This changed since you saw it. Nothing was sent; carry on without it.' })
      this.finish(action)
      return
    }
    // Separate autocommits: a restart can distinguish approved from a call that may have reached the server.
    if (!action.exec_args || !this.transition(id, 'approved', 'running')) return
    this.executing.add(id)
    try {
      const result = await this.host.execute(row, JSON.parse(action.target_json), JSON.parse(action.exec_args))
      // A transport failure can have happened after the server acted. Never promise that retrying is safe.
      this.transition(id, 'running', result.isError ? result.callState ?? 'uncertain' : 'done', result)
    } catch (error) {
      this.transition(id, 'running', error instanceof BotActionChanged ? 'failed' : 'uncertain', { text: error instanceof BotActionChanged ? error.message : 'It could not be confirmed whether this went through: check before trying again.' })
    } finally {
      this.executing.delete(id)
    }
    this.finish(action)
  }
  private finish(action: ActionRow): void {
    const row = this.host.store.activation(action.activation_id)
    if (!row) return
    this.host.settled(row)
  }
  async retryApproved(): Promise<void> {
    if (!this.host.enabled()) return
    for (const action of this.host.store.all("SELECT id FROM bot_actions WHERE status = 'approved'"))
      await this.runApproved(String(action.id))
  }
  async reconcile(): Promise<void> {
    if (!this.host.enabled()) return
    this.expireDue()
    const interrupted = this.host.store.all("SELECT id FROM bot_actions WHERE status IN ('running', 'approved')")
    await this.host.refresh()
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
