import {
  EDITOR_ASKS_PER_HOUR,
  EDITOR_ASK_AUDIT,
  EDITOR_ASK_COOLDOWN_MS,
  EDITOR_ASK_TTL_MS,
  EDITOR_ASK_WINDOW_MS,
  type EditorAskAnswerResult,
  type EditorAskReply,
  type EditorAskView
} from '../../../shared/bridge/editorAsk'
import { NetError, type NodeId } from '../../../shared/net'
import type { Clock } from '../../net/contracts'
import type { SqliteBridgeAudit } from '../../net/store/audit'
import type { SqliteNodePolicy } from '../../net/store/nodePolicy'
import type { EditorAsksPort } from '../../protocol/editorAsksPort'

/** Rows of the audit read back for one device to find its last "Not now" and its recent asks. */
const AUDIT_LOOKBACK = 200
/** A refusal of an ask is written to the audit at most once in this long for a device and kind. */
const REFUSAL_ROW_WINDOW_MS = 60_000

export interface EditorAsksOptions {
  /** What this computer lets each device do. Allow turns `editor` on here, as `bridge.policy` would. */
  policy: Pick<SqliteNodePolicy, 'get' | 'set' | 'onChange'>
  audit: Pick<SqliteBridgeAudit, 'record' | 'recent'>
  clock: Pick<Clock, 'now'>
  /** The name this computer knows a device by. */
  name(node: NodeId): string
  /** An ask reached a person: a desktop notice and the prompt in the windows of this computer. */
  onAsked(view: EditorAskView): void
  /** The list of waiting asks changed (answered, ran out, or the device was blocked); windows read it again. */
  onChanged(): void
}

/**
 * The asks other computers made of this one for editor connections. One ask per device waits at a time; a person
 * answers it with Allow (the switch goes on here) or Not now (a refusal is recorded and the same computer is told
 * so, without anyone being asked again, for a while). An ask changes nothing by itself, and it needs nothing
 * beyond the grant every routed call needs: a blocked device never gets here, and a device that is blocked
 * while its ask waits loses it. Every ask that reached a person, and its answer, is a row of the audit.
 */
export class EditorAsks implements EditorAsksPort {
  private readonly waiting = new Map<NodeId, { at: number; expiresAt: number }>()
  /** When a person last said "Not now" to each device in this run; the audit holds it across restarts. */
  private readonly declined = new Map<NodeId, number>()
  private readonly refusalRows = new Map<string, number>()
  private stop?: () => void

  constructor(private readonly options: EditorAsksOptions) {}

  /** Starts watching the policy: an ask is dropped when the device is blocked or its switch goes on by other means. */
  start(): void {
    this.stop ??= this.options.policy.onChange((event) => {
      if (!this.waiting.has(event.node)) return
      if (event.after.blocked || event.after.editor) {
        this.waiting.delete(event.node)
        this.options.onChanged()
      }
    })
  }

  close(): void {
    this.stop?.()
    this.stop = undefined
    this.waiting.clear()
  }

  ask(node: NodeId): EditorAskReply {
    const { policy, audit, clock } = this.options
    const now = clock.now()
    const held = policy.get(node)
    // The router refuses a blocked device before any handler runs; this keeps the rule where the ask is decided.
    if (held.blocked) throw new NetError('forbidden', undefined, { details: { reason: 'blocked' } })
    if (held.editor) return { state: 'already_on' }
    const waiting = this.waiting.get(node)
    if (waiting && waiting.expiresAt > now) return { state: 'pending', expiresAt: waiting.expiresAt }
    if (waiting) {
      this.waiting.delete(node)
      this.options.onChanged()
    }
    const rows = audit.recent(AUDIT_LOOKBACK, node)
    const declinedAt = Math.max(
      this.declined.get(node) ?? 0,
      ...rows.filter((row) => row.method === EDITOR_ASK_AUDIT.declined).map((row) => row.at)
    )
    if (declinedAt && now - declinedAt < EDITOR_ASK_COOLDOWN_MS) {
      this.refused(node, 'declined_recently', now)
      return { state: 'declined_recently', retryAt: declinedAt + EDITOR_ASK_COOLDOWN_MS }
    }
    const asks = rows
      .filter(
        (row) =>
          row.method === EDITOR_ASK_AUDIT.asked && row.kind === 'change' && now - row.at < EDITOR_ASK_WINDOW_MS
      )
      .map((row) => row.at)
      .sort((a, b) => a - b)
    if (asks.length >= EDITOR_ASKS_PER_HOUR) {
      this.refused(node, 'rate_limited', now)
      return { state: 'rate_limited', retryAt: asks[asks.length - EDITOR_ASKS_PER_HOUR] + EDITOR_ASK_WINDOW_MS }
    }
    const expiresAt = now + EDITOR_ASK_TTL_MS
    this.waiting.set(node, { at: now, expiresAt })
    audit.record({ node, method: EDITOR_ASK_AUDIT.asked, outcome: 'asked', kind: 'change' })
    try {
      this.options.onAsked({ node, name: this.options.name(node), at: now, expiresAt })
    } catch {
      // A notice that cannot be shown does not undo the ask: it stays in the audit and in Devices.
    }
    this.options.onChanged()
    return { state: 'asked', expiresAt }
  }

  /** The asks waiting for a person. */
  pending(): EditorAskView[] {
    const now = this.options.clock.now()
    const out: EditorAskView[] = []
    for (const [node, entry] of this.waiting) {
      if (entry.expiresAt <= now) {
        this.waiting.delete(node)
        continue
      }
      out.push({ node, name: this.options.name(node), at: entry.at, expiresAt: entry.expiresAt })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  /** A person on this computer answers the ask of `node`. Allow turns the switch on here; Not now is recorded. */
  answer(node: NodeId, allow: boolean): EditorAskAnswerResult {
    const { policy, audit, clock } = this.options
    const waiting = this.waiting.get(node)
    if (!waiting || waiting.expiresAt <= clock.now() || policy.get(node).blocked) {
      if (waiting) {
        this.waiting.delete(node)
        this.options.onChanged()
      }
      return { ok: false, reason: 'expired' }
    }
    this.waiting.delete(node)
    if (allow) {
      policy.set(node, { editor: true })
      audit.record({ node, method: EDITOR_ASK_AUDIT.allowed, outcome: 'ok', kind: 'change' })
    } else {
      this.declined.set(node, clock.now())
      audit.record({ node, method: EDITOR_ASK_AUDIT.declined, outcome: 'not_now', kind: 'refused' })
    }
    this.options.onChanged()
    return { ok: true, allowed: allow }
  }

  /** A refused ask is a row of its own, at most one a minute for each device and kind, so repeats cannot fill the audit. */
  private refused(node: NodeId, outcome: 'declined_recently' | 'rate_limited', now: number): void {
    const key = `${node}:${outcome}`
    const last = this.refusalRows.get(key)
    if (last !== undefined && now - last < REFUSAL_ROW_WINDOW_MS) return
    this.refusalRows.set(key, now)
    if (this.refusalRows.size > 256) this.refusalRows.clear()
    this.options.audit.record({ node, method: EDITOR_ASK_AUDIT.asked, outcome, kind: 'refused' })
  }
}
