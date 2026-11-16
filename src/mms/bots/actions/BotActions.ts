import { randomUUID } from 'node:crypto'
import type { MousseSettings } from '../../../shared/settings'
import type { BotMcpTool } from '../../../shared/bots/personal/authority'
import type { BotActivationRow, BotStore } from '../store/BotStore'
import { canonicalJson, shortHash } from '../../integrations/revision'
import { maskMemoryCredentials } from '../memory/guard'
import type { ToolOutcome } from '../../run/mcp/appTools/types'

/** The sole feature-switch read. No UI sets it until the complete feature ships. */
export function botAsksFirst(settings?: Pick<MousseSettings, 'experimental'>): boolean {
  return settings?.experimental.botAsksFirst === true
}
export const actionDigest = (value: unknown): string => shortHash(canonicalJson(value), 64)
/** Mask before cutting, recursively: a cut must not split a credential before the mask sees it. */
export function maskedActionData(value: unknown): unknown {
  if (typeof value === 'string') return maskMemoryCredentials(value).slice(0, 32_000)
  if (Array.isArray(value)) return value.map(maskedActionData)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskMemoryCredentials(key), /^(authorization|password|secret|token|api[_-]?key)$/i.test(key) ? '[held back: looks like a secret]' : maskedActionData(item)]))
  return value
}
export interface ActionRow {
  id: string; call_key: string; bot_id: string; activation_id: string; status: string
  exec_args: string | null; args_digest: string; binding_json: string; target_json: string
  args_json: string; message_id: string; expires_at: string; result_json: string | null
}
interface Host {
  store: BotStore
  enabled(): boolean
  refresh(): Promise<void>
  park(row: BotActivationRow): void
  binding(row: BotActivationRow, tool: BotMcpTool): unknown | undefined
  post(row: BotActivationRow, id: string, text: string): void
  settled(row: BotActivationRow): void
  execute(row: BotActivationRow, tool: BotMcpTool, args: Record<string, unknown>): Promise<ToolOutcome>
}
const pending = new Set(['open', 'approved', 'running'])
export class BotActionChanged extends Error {}
const changed = () => new BotActionChanged('This changed since you saw it. Redraw the action.')
export class BotActions {
  constructor(private readonly host: Host) {}
  get(id: string): ActionRow | undefined { return this.host.store.get('SELECT * FROM bot_actions WHERE id = ?', id) as unknown as ActionRow | undefined }
  forWork(id: string): ActionRow | undefined {
    return this.host.store.get("SELECT * FROM bot_actions WHERE activation_id = ? ORDER BY rowid DESC LIMIT 1", id) as unknown as ActionRow | undefined
  }
  hold(row: BotActivationRow, dispatch: string, tool: BotMcpTool, args: Record<string, unknown>, toolCallId?: string): ToolOutcome {
    if (!toolCallId) return { text: 'This call cannot be held without its call id. Carry on without it.', isError: true }
    const callKey = JSON.stringify([row.id, dispatch, toolCallId])
    const existing = this.host.store.get('SELECT id FROM bot_actions WHERE call_key = ?', callKey)
    if (existing) return { text: 'This call is held for your owner. End your turn now.' }
    const binding = this.host.binding(row, tool)
    if (!binding) return { text: 'This tool changed. Carry on without it.', isError: true }
    const exact = JSON.stringify(args)
    const id = `action_${randomUUID()}`
    const messageId = `bm_${id}`
    this.host.store.db.transaction(() => {
      this.host.store.run(`INSERT INTO bot_actions(id, call_key, bot_id, activation_id, lane, kind, target_json, exec_args,
        args_json, args_digest, binding_json, status, message_id, expires_at, created_at)
        VALUES(?, ?, ?, ?, 'run', 'mcp', ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id, callKey, row.botId, row.id, JSON.stringify({ server: tool.server, tool: tool.tool }), exact, JSON.stringify(maskedActionData(args)), actionDigest(JSON.parse(exact)), JSON.stringify(binding), messageId,
      new Date(Date.parse(this.host.store.now()) + 48 * 3600_000).toISOString(), this.host.store.now())
      this.host.park(row)
      this.host.post(row, messageId, `Send this action?\n${JSON.stringify(maskedActionData(args))}`)
    })
    return { text: 'This call is held for your owner. End your turn now.' }
  }
  /** The only status writer. Settlement clears executable arguments in the same statement. */
  transition(id: string, from: string, to: string, result?: ToolOutcome): boolean {
    return this.host.store.db.transaction(() => {
      const moved = this.host.store.run(`UPDATE bot_actions SET status = ?, exec_args = CASE WHEN ? THEN exec_args ELSE NULL END,
        result_json = ?, answered_at = CASE WHEN ? = 'open' THEN ? ELSE answered_at END,
        ran_at = CASE WHEN ? = 'running' THEN ? ELSE ran_at END WHERE id = ? AND status = ?`,
      to, pending.has(to) ? 1 : 0, result ? JSON.stringify(maskedActionData(result)) : null,
      from, this.host.store.now(), to, this.host.store.now(), id, from) > 0
      if (moved && !pending.has(to)) {
        const action = this.get(id)!
        const row = this.host.store.activation(action.activation_id)
        this.host.store.run('UPDATE bot_messages SET text = ? WHERE id = ?', to === 'done' ? `Sent · ${this.host.store.now().slice(11, 16)}` : to === 'uncertain' ? "Couldn't tell if it went through" : 'Not sent', action.message_id)
        if (row?.endReason === 'approval') this.host.store.moveActivation(row.id, ['blocked'], 'blocked', { endReason: 'approval_answered' })
      }
      return moved
    })
  }

  private valid(action: ActionRow): BotActivationRow | undefined {
    const row = this.host.store.activation(action.activation_id)
    if (!row || !action.exec_args || actionDigest(JSON.parse(action.exec_args)) !== action.args_digest || Date.parse(action.expires_at) <= Date.parse(this.host.store.now())) return undefined
    const binding = this.host.binding(row, JSON.parse(action.target_json))
    return binding && canonicalJson(binding) === canonicalJson(JSON.parse(action.binding_json)) ? row : undefined
  }
  assertRunning(id: string): void {
    const action = this.get(id)
    if (!action || action.status !== 'running' || !this.valid(action)) throw changed()
  }
  async answer(input: { actionId: string; digest: string; answer: 'send' | 'not_now' }): Promise<{ status: string }> {
    if (!this.host.enabled()) throw changed()
    await this.host.refresh()
    const action = this.get(input.actionId)
    if (!action || action.status !== 'open' || action.args_digest !== input.digest || !this.valid(action)) throw changed()
    if (input.answer === 'not_now') {
      if (!this.transition(action.id, 'open', 'declined', { text: 'Your owner chose not to send this: carry on without it and say what you skipped.' })) throw changed()
      this.finish(action)
      return { status: 'declined' }
    }
    if (!this.transition(action.id, 'open', 'approved')) throw changed()
    await this.runApproved(action.id)
    return { status: this.get(action.id)!.status }
  }
  private async runApproved(id: string): Promise<void> {
    const action = this.get(id)
    if (!action || action.status !== 'approved') return
    const row = this.valid(action)
    if (!row) {
      this.transition(id, 'approved', Date.parse(action.expires_at) <= Date.parse(this.host.store.now()) ? 'expired' : 'withdrawn', { text: 'This changed since you saw it. Nothing was sent; carry on without it.' })
      this.finish(action)
      return
    }
    // Separate autocommits: a restart can distinguish approved from a call that may have reached the server.
    if (!action.exec_args || !this.transition(id, 'approved', 'running')) return
    try {
      const result = await this.host.execute(row, JSON.parse(action.target_json), JSON.parse(action.exec_args))
      // A transport failure can have happened after the server acted. Never promise that retrying is safe.
      this.transition(id, 'running', result.isError ? 'uncertain' : 'done', result.isError ? { ...result, text: `It could not be confirmed whether this went through: check before trying again.\n${result.text}` } : result)
    } catch {
      this.transition(id, 'running', 'uncertain', { text: 'It could not be confirmed whether this went through: check before trying again.' })
    }
    this.finish(action)
  }
  private finish(action: ActionRow): void {
    const row = this.host.store.activation(action.activation_id)
    if (!row) return
    this.host.settled(row)
  }
  async reconcile(): Promise<void> {
    if (!this.host.enabled()) return
    await this.host.refresh()
    for (const a of this.host.store.all("SELECT id FROM bot_actions WHERE status IN ('running', 'approved')")) {
      const action = this.get(String(a.id))!
      if (action.status === 'running') {
        if (this.transition(action.id, 'running', 'uncertain', { text: 'It could not be confirmed whether this went through: check before trying again.' })) this.finish(action)
      } else await this.runApproved(action.id)
    }
  }
}
