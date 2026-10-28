import type { NodeId } from '../../../shared/net'
import { ROUTED_TERMINALS_PER_NODE } from '../../../shared/bridge/routed'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { Clock } from '../../net/contracts'
import type { SqliteBridgeAudit } from '../../net/store/audit'
import { systemClock } from '../../net/clock'

/** Why a routed terminal ended; the audit keeps it. */
export type TerminalEnd =
  /** The shell ended by itself. */
  | 'exited'
  /** The device closed it (`pty.kill`). */
  | 'killed'
  | 'blocked'
  | 'terminal_off'
  /** The owner's switch for other computers went off. */
  | 'setting_off'
  /** The device lost "Works on threads", or was revoked. */
  | 'access_lost'

interface Entry {
  node: NodeId
  threadId: string
  ptyId: string
  /** The newest input number applied; a number at or below it is a resend. */
  lastSeq: number
  bytesIn: number
  bytesOut: number
  end?: TerminalEnd
}

/**
 * Input from one computer, in bytes. A shell reads what it is given without question, so a device that
 * floods one is held to a steady rate: typing and a large paste go through, a runaway loop does not.
 */
export const TERMINAL_INPUT_BYTES_PER_SECOND = 256 * 1024
export const TERMINAL_INPUT_BURST_BYTES = 512 * 1024
export const TERMINAL_INPUT_CALLS_PER_SECOND = 100
export const TERMINAL_INPUT_BURST_CALLS = 200

export interface RoutedTerminalsOptions {
  services: Pick<MmsProfileServices, 'ptyManager'>
  audit: Pick<SqliteBridgeAudit, 'record' | 'countRead'>
  clock?: Pick<Clock, 'now'>
  /** Terminals one computer may have at once (default 4). */
  perNode?: number
}

/**
 * The terminals other computers opened on this one: who opened each, and what to do when that computer may
 * no longer have it. A terminal here is a shell on this computer, so everything about it is kept in one
 * place:
 *
 * - **Ownership.** A device types into, resizes and stops only the terminals it opened. It may read the
 *   output of any terminal of a thread it is allowed into (that is the thread's own terminal list), but
 *   it has no hands on a terminal someone else opened.
 * - **Limit.** At most four per computer; the slot is taken before the shell starts, so two calls made at
 *   once cannot both pass.
 * - **Input.** Numbered calls: each `(computer, terminal, number)` is applied once, and a resend of one that
 *   was already applied (a reply that got lost) is answered without typing it again. Held to a steady rate.
 * - **Ending.** A block, the device's terminal switch going off, the owner's switch going off, or the device
 *   losing "Works on threads" ends every terminal it opened, at once. Each end is audited with the bytes that
 *   went in and out.
 */
export class RoutedTerminals {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<NodeId, number>()
  private readonly buckets = new Map<NodeId, { bytes: number; calls: number; at: number }>()
  private readonly clock: Pick<Clock, 'now'>
  private readonly perNode: number
  private readonly onData: (payload: { ptyId: string; data: string }) => void
  private readonly onExit: (payload: { ptyId: string }) => void

  constructor(private readonly options: RoutedTerminalsOptions) {
    this.clock = options.clock ?? systemClock
    this.perNode = options.perNode ?? ROUTED_TERMINALS_PER_NODE
    this.onData = ({ ptyId, data }) => {
      const entry = this.entries.get(ptyId)
      if (entry) entry.bytesOut += Buffer.byteLength(data)
    }
    this.onExit = ({ ptyId }) => this.closed(ptyId)
    options.services.ptyManager.on('data', this.onData)
    options.services.ptyManager.on('exit', this.onExit)
  }

  close(): void {
    this.options.services.ptyManager.off('data', this.onData)
    this.options.services.ptyManager.off('exit', this.onExit)
  }

  /** How many terminals `node` has open here, counting one that is starting. */
  count(node: NodeId): number {
    let count = this.pending.get(node) ?? 0
    for (const entry of this.entries.values()) if (entry.node === node) count++
    return count
  }

  /**
   * Takes a slot for a terminal that is about to start. `adopt` records the terminal once it exists, `abandon`
   * gives the slot back when it did not start. Refused when the computer already has its terminals open.
   */
  claim(node: NodeId): { adopt(threadId: string, ptyId: string): void; abandon(): void } {
    if (this.count(node) >= this.perNode)
      throw new DomainRpcError(
        'terminal_limit',
        `This device already has ${this.perNode} terminals open here. Close one first.`,
        { limit: this.perNode }
      )
    this.pending.set(node, (this.pending.get(node) ?? 0) + 1)
    let settled = false
    const release = (): void => {
      if (settled) return
      settled = true
      const left = (this.pending.get(node) ?? 1) - 1
      if (left > 0) this.pending.set(node, left)
      else this.pending.delete(node)
    }
    return {
      adopt: (threadId, ptyId) => {
        release()
        this.entries.set(ptyId, { node, threadId, ptyId, lastSeq: 0, bytesIn: 0, bytesOut: 0 })
      },
      abandon: release
    }
  }

  /** Whether `node` opened this terminal, in this thread. */
  owns(node: NodeId, ptyId: string, threadId: string): boolean {
    const entry = this.entries.get(ptyId)
    return entry !== undefined && entry.node === node && entry.threadId === threadId
  }

  /** The terminal is being stopped by its device; its end is audited as a close by the device. */
  markKilled(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) entry.end ??= 'killed'
  }

  /**
   * Decides what a numbered input call does. `duplicate` is a number that was already applied (or is older
   * than one that was): it is answered and not applied again. Otherwise the number is taken, counted
   * against the device's rate, and the caller applies it. A call over the rate is refused `rate_limited`
   * and its number is not taken, so the caller may send it again a moment later.
   */
  admitInput(node: NodeId, ptyId: string, seq: number, bytes: number): 'apply' | 'duplicate' {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.node !== node)
      throw new DomainRpcError('pty_not_found', 'No such terminal in this thread', { id: ptyId })
    if (seq <= entry.lastSeq) return 'duplicate'
    this.spend(node, bytes)
    entry.lastSeq = seq
    entry.bytesIn += bytes
    return 'apply'
  }

  private spend(node: NodeId, bytes: number): void {
    const now = this.clock.now()
    let bucket = this.buckets.get(node)
    if (!bucket) {
      bucket = { bytes: TERMINAL_INPUT_BURST_BYTES, calls: TERMINAL_INPUT_BURST_CALLS, at: now }
      this.buckets.set(node, bucket)
    }
    const seconds = Math.max(0, now - bucket.at) / 1000
    bucket.at = now
    bucket.bytes = Math.min(
      TERMINAL_INPUT_BURST_BYTES,
      bucket.bytes + seconds * TERMINAL_INPUT_BYTES_PER_SECOND
    )
    bucket.calls = Math.min(
      TERMINAL_INPUT_BURST_CALLS,
      bucket.calls + seconds * TERMINAL_INPUT_CALLS_PER_SECOND
    )
    if (bucket.bytes < bytes || bucket.calls < 1)
      throw new DomainRpcError('rate_limited', 'Terminal input is arriving too fast. Slow down.')
    bucket.bytes -= bytes
    bucket.calls -= 1
  }

  /** Ends the terminals of `node` (or, without one, of every computer). Returns how many were stopped. */
  end(reason: TerminalEnd, node?: NodeId): number {
    return this.stop(reason, (entry) => node === undefined || entry.node === node)
  }

  /** Ends the terminals of every computer except those `granted` still allows. */
  endExcept(reason: TerminalEnd, granted: (node: NodeId) => boolean): number {
    return this.stop(reason, (entry) => !granted(entry.node))
  }

  private stop(reason: TerminalEnd, matches: (entry: Entry) => boolean): number {
    let stopped = 0
    for (const entry of [...this.entries.values()]) {
      if (!matches(entry)) continue
      entry.end ??= reason
      stopped++
      try {
        this.options.services.ptyManager.kill(entry.ptyId)
      } catch {
        // Already gone: the exit is audited when it is seen.
      }
    }
    return stopped
  }

  /** The terminal is gone, however it ended: one audit row says who, how and how much. */
  private closed(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    this.entries.delete(ptyId)
    const { audit } = this.options
    audit.record({
      node: entry.node,
      method: 'pty.close',
      thread: entry.threadId,
      outcome: `${entry.end ?? 'exited'}; in ${entry.bytesIn} B; out ${entry.bytesOut} B`,
      kind: 'change'
    })
    // What came out of a shell is what this computer sent the device: it counts as read.
    audit.countRead(entry.node, entry.bytesOut)
    if (this.entries.size === 0) this.buckets.clear()
  }
}
