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

/** A refusal of an ask is written to the audit at most once in this long for a device and kind. */
const REFUSAL_ROW_WINDOW_MS = 60_000

export interface EditorAsksOptions {
  /** What this computer lets each device do here. */
  policy: Pick<SqliteNodePolicy, 'get' | 'set' | 'onChange'>
  /** Rows are read by method and time (`since`), never by looking at the last rows of the device. */
  audit: Pick<SqliteBridgeAudit, 'record' | 'since'>
  clock: Pick<Clock, 'now'>
  /** How a person here tells the device apart: its name, made safe to show, with a short id when another shares it. */
  name(node: NodeId): string
  /** An ask reached a person: a desktop notice and the prompt in the windows of this computer. */
  onAsked(view: EditorAskView): void
  /** The list of waiting asks changed (answered, ran out, or the device was blocked); windows read it again. */
  onChanged(): void
  /** Whether the device is still on the roster with Works on threads. Read when a person answers. Default: yes. */
  stillAsking?(node: NodeId): Promise<boolean>
  /** Turns "Editor connections from this device" on, as `bridge.policy` does. Default: sets the policy. */
  allow?(node: NodeId): Promise<void>
}

/**
 * The asks other computers made of this one for editor connections. One ask per device waits at a time; a person
 * answers it with Allow (the switch goes on here) or Not now (a refusal is recorded and the same computer is told
 * so, without anyone being asked again, for a while). An ask changes nothing by itself, and it needs nothing
 * beyond the grant every routed call needs: a blocked device never gets here, and a device that is blocked
 * while its ask waits loses it. Every ask that reached a person, and its answer, is a row of the audit.
 *
 * The limits do not depend on a window of recent rows: each device has counters here (ask times, last "Not now")
 * and the audit is asked by method and time to fill them in after a restart.
 */
export class EditorAsks implements EditorAsksPort {
  private readonly waiting = new Map<NodeId, { at: number; expiresAt: number }>()
  /** When a person last said "Not now" to each device. */
  private readonly declined = new Map<NodeId, number>()
  /** When each device's asks reached a person. */
  private readonly asked = new Map<NodeId, number[]>()
  /** Devices whose counters were filled in from the audit since this run began. */
  private readonly seeded = new Set<NodeId>()
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

  /** The counters of a device, filled in from the audit the first time they are needed in this run. */
  private counters(node: NodeId, now: number): { declinedAt: number; asks: number[] } {
    if (!this.seeded.has(node)) {
      this.seeded.add(node)
      const { audit } = this.options
      const declined = audit.since(node, EDITOR_ASK_AUDIT.declined, now - EDITOR_ASK_COOLDOWN_MS, 1)[0]
      if (declined) this.declined.set(node, Math.max(this.declined.get(node) ?? 0, declined.at))
      const rows = audit
        .since(node, EDITOR_ASK_AUDIT.asked, now - EDITOR_ASK_WINDOW_MS, EDITOR_ASKS_PER_HOUR + 1)
        .filter((row) => row.kind === 'change')
        .map((row) => row.at)
      this.asked.set(node, [...new Set([...(this.asked.get(node) ?? []), ...rows])])
    }
    return {
      declinedAt: this.declined.get(node) ?? 0,
      asks: (this.asked.get(node) ?? []).filter((at) => now - at < EDITOR_ASK_WINDOW_MS).sort((a, b) => a - b)
    }
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
    const { declinedAt, asks } = this.counters(node, now)
    if (declinedAt && now - declinedAt < EDITOR_ASK_COOLDOWN_MS) {
      this.refused(node, 'declined_recently', now)
      return { state: 'declined_recently', retryAt: declinedAt + EDITOR_ASK_COOLDOWN_MS }
    }
    if (asks.length >= EDITOR_ASKS_PER_HOUR) {
      this.refused(node, 'rate_limited', now)
      return { state: 'rate_limited', retryAt: asks[asks.length - EDITOR_ASKS_PER_HOUR] + EDITOR_ASK_WINDOW_MS }
    }
    const expiresAt = now + EDITOR_ASK_TTL_MS
    this.waiting.set(node, { at: now, expiresAt })
    this.asked.set(node, [...asks, now])
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

  /** Drops the asks of devices that are no longer on the roster with Works on threads (a revoke, a lost grant). */
  async reconcile(): Promise<void> {
    const check = this.options.stillAsking
    if (!check) return
    let changed = false
    for (const node of [...this.waiting.keys()]) {
      const still = await check(node).catch(() => false)
      if (!still && this.waiting.delete(node)) changed = true
    }
    if (changed) this.options.onChanged()
  }

  /**
   * A person on this computer answers the ask of `node`. Allow checks again that the device is still on the roster
   * with Works on threads, then turns the switch on here as `bridge.policy` does; Not now is recorded.
   */
  async answer(node: NodeId, allow: boolean): Promise<EditorAskAnswerResult> {
    const { policy, audit, clock } = this.options
    const waiting = this.waiting.get(node)
    const gone = (): EditorAskAnswerResult => {
      if (this.waiting.delete(node)) this.options.onChanged()
      return { ok: false, reason: 'expired' }
    }
    if (!waiting || waiting.expiresAt <= clock.now() || policy.get(node).blocked) return gone()
    if (allow) {
      if (this.options.stillAsking && !(await this.options.stillAsking(node).catch(() => false))) return gone()
      // Someone else may have answered while the roster was read.
      if (this.waiting.get(node) !== waiting) return { ok: false, reason: 'expired' }
      try {
        if (this.options.allow) await this.options.allow(node)
        else policy.set(node, { editor: true })
      } catch {
        return gone()
      }
      this.waiting.delete(node)
      audit.record({ node, method: EDITOR_ASK_AUDIT.allowed, outcome: 'ok', kind: 'change' })
    } else {
      this.waiting.delete(node)
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
