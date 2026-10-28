import type { NodeId } from '../../../shared/net'
import { ROUTED_TERMINALS_PER_NODE } from '../../../shared/bridge/routed'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { RoutedTerminalsPort } from '../../protocol/routedTerminalsPort'
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
  /** A person on this computer stopped it. */
  | 'owner_stopped'
  | 'blocked'
  | 'terminal_off'
  /** The owner's switch for other computers went off. */
  | 'setting_off'
  /** The device lost "Works on threads", or was revoked. */
  | 'access_lost'
  /** Net or Bridge was turned off, or the profile closed. */
  | 'net_off'
  /** The device had no connection to this computer for the grace period. */
  | 'device_away'
  /** The shell started, but the call that started it failed afterwards. */
  | 'create_failed'

interface Entry {
  node: NodeId
  threadId: string
  ptyId: string
  openedAt: number
  /** The newest input number taken; a number at or below it is a resend. */
  lastSeq: number
  /** Calls waiting for the number before theirs, by their own number. */
  waiting: Map<number, () => void>
  /** Input is applied one call at a time in the order the numbers were taken. */
  line: Promise<unknown>
  bytesIn: number
  bytesOut: number
  end?: TerminalEnd
}

/**
 * Input from one computer, in bytes. A shell reads what it is given without question, so a device that
 * floods one is held to a steady rate: typing and a large paste go through, a runaway loop does not. Input
 * over the rate waits (up to `TERMINAL_INPUT_WAIT_MS`) instead of being refused, so a paste stays whole and in order.
 */
export const TERMINAL_INPUT_BYTES_PER_SECOND = 256 * 1024
export const TERMINAL_INPUT_BURST_BYTES = 512 * 1024
export const TERMINAL_INPUT_CALLS_PER_SECOND = 100
export const TERMINAL_INPUT_BURST_CALLS = 200
export const TERMINAL_INPUT_WAIT_MS = 3000
/** How long a call waits for the number before its own, when calls arrive out of order. */
export const TERMINAL_GAP_WAIT_MS = 250
/**
 * A device whose connection to this computer has been gone this long has its terminals ended. A short drop
 * (a laptop lid, a link that comes back) keeps them; a shell does not outlive its device for good, because it
 * holds the thread's writer lease and the owner's turns for that thread wait for it.
 */
export const TERMINAL_AWAY_GRACE_MS = 10 * 60 * 1000
const AWAY_SWEEP_MS = 30 * 1000

export interface RoutedTerminalsOptions {
  services: Pick<MmsProfileServices, 'ptyManager'>
  audit: Pick<SqliteBridgeAudit, 'record' | 'countRead'>
  clock?: Pick<Clock, 'now'>
  /** Terminals one computer may have at once (default 4). */
  perNode?: number
  /** Whether a session with `node` is open now. Without it a device is never "away". */
  connected?: (node: NodeId) => boolean
  /** The name the owner knows a device by. */
  name?: (node: NodeId) => string
  awayMs?: number
  /** How often devices are checked for being away (default 30 s). */
  sweepMs?: number
}

/** A slot for a terminal that is being started. */
export interface TerminalClaim {
  /** The shell exists: from now on it is the device's, and ends with the device's permission. */
  created(ptyId: string): void
  /** Why the device lost its right to this terminal while it was starting, if it did. */
  readonly cancelled: TerminalEnd | undefined
  /** The call went through. */
  finish(): void
  /** The call ended without finishing: a slot not used is given back, and a shell that was started is stopped. */
  abandon(): void
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

/**
 * The terminals other computers opened on this one: who opened each, and what to do when that computer may
 * no longer have it. A terminal here is a shell on this computer, so everything about it is kept in one
 * place:
 *
 * - **Ownership.** A device reads, types into, resizes and stops only the terminals it opened.
 * - **Limit.** At most four per computer; the slot is taken before the shell starts, so two calls made at
 *   once cannot both pass.
 * - **Input.** Numbered calls: each `(computer, terminal, number)` is applied once, in number order, and a
 *   resend of one that was already applied (a reply that got lost) is answered without typing it again.
 *   Calls may be sent without waiting for each reply; they are put back in order here. Held to a steady rate.
 * - **Ending.** A block, the device's terminal switch going off, the owner's switch going off, the device
 *   losing "Works on threads", Net or Bridge being turned off, and the device being away for the grace
 *   period end every terminal it opened. Each end is audited with the bytes that went in and out.
 */
export class RoutedTerminals implements RoutedTerminalsPort {
  private readonly entries = new Map<string, Entry>()
  private readonly claims = new Set<{ node: NodeId; ptyId?: string; cancelled?: TerminalEnd }>()
  private readonly buckets = new Map<NodeId, { bytes: number; calls: number; at: number }>()
  private readonly away = new Map<NodeId, number>()
  private readonly clock: Pick<Clock, 'now'>
  private readonly perNode: number
  private readonly onData: (payload: { ptyId: string; data: string }) => void
  private readonly onExit: (payload: { ptyId: string }) => void
  private sweepTimer?: ReturnType<typeof setInterval>

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
    if (options.connected) {
      this.sweepTimer = setInterval(() => this.sweep(), options.sweepMs ?? AWAY_SWEEP_MS)
      this.sweepTimer.unref?.()
    }
  }

  /**
   * Stops listening. A terminal still open ends first (with `net_off`, written to the audit), so turning Net or
   * Bridge off, or closing the profile, never leaves a device's shell running with no one to account for it, and
   * a count that starts again from zero is a true one.
   */
  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    await this.endAndWait('net_off')
    this.options.services.ptyManager.off('data', this.onData)
    this.options.services.ptyManager.off('exit', this.onExit)
  }

  // ------------------------------------------------------------------ who holds what

  holderOf(ptyId: string): { node: NodeId; name: string; openedAt: number } | undefined {
    const entry = this.entries.get(ptyId)
    return entry && { node: entry.node, name: this.options.name?.(entry.node) ?? 'another computer', openedAt: entry.openedAt }
  }

  opened(node: string, ptyId: string): boolean {
    return this.entries.get(ptyId)?.node === node
  }

  /** The terminal ids `node` has open, and the thread of each. */
  heldBy(node: NodeId): Array<{ ptyId: string; threadId: string }> {
    return [...this.entries.values()]
      .filter((entry) => entry.node === node)
      .map((entry) => ({ ptyId: entry.ptyId, threadId: entry.threadId }))
  }

  lastSeq(ptyId: string): number {
    return this.entries.get(ptyId)?.lastSeq ?? 0
  }

  /** How many terminals `node` has open here, counting one that is starting. */
  count(node: NodeId): number {
    let count = 0
    for (const claim of this.claims) if (claim.node === node && claim.ptyId === undefined) count++
    for (const entry of this.entries.values()) if (entry.node === node) count++
    return count
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

  /** A person on this computer is stopping it. */
  stoppedByOwner(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) entry.end ??= 'owner_stopped'
  }

  // ------------------------------------------------------------------ starting one

  /**
   * Takes a slot for a terminal that is about to start. Refused when the computer already has its terminals
   * open. A block (or anything else that ends the device's terminals) while the shell is still starting is
   * remembered: the shell is stopped the moment it exists, and is never handed back.
   */
  claim(node: NodeId, threadId: string, agentId: string): TerminalClaim {
    if (this.count(node) >= this.perNode)
      throw new DomainRpcError(
        'terminal_limit',
        `This device already has ${this.perNode} terminals open here. Close one first.`,
        { limit: this.perNode }
      )
    const claim: { node: NodeId; ptyId?: string; cancelled?: TerminalEnd } = { node }
    this.claims.add(claim)
    // What this thread already had, so a shell the call made but never reported (a listener of the shell's creation
    // failed before the call got its id) can still be found.
    const before = new Set(this.options.services.ptyManager.list(threadId).map((entry) => entry.ptyId))
    let finished = false
    return {
      created: (ptyId) => {
        claim.ptyId = ptyId
        this.entries.set(ptyId, {
          node,
          threadId,
          ptyId,
          openedAt: this.clock.now(),
          lastSeq: 0,
          waiting: new Map(),
          line: Promise.resolve(),
          bytesIn: 0,
          bytesOut: 0,
          ...(claim.cancelled ? { end: claim.cancelled } : {})
        })
        // The device lost its right while the shell was starting: it is stopped now, and never handed back.
        if (claim.cancelled) this.kill(ptyId)
      },
      get cancelled() {
        return claim.cancelled
      },
      finish: () => {
        finished = true
        this.claims.delete(claim)
      },
      abandon: () => {
        this.claims.delete(claim)
        // A shell exists, but the call that started it failed: no one was told its id, so it ends here.
        if (finished) return
        const strays = claim.ptyId
          ? [claim.ptyId]
          : this.options.services.ptyManager
              .list(threadId)
              .filter((entry) => entry.agentId === agentId && !before.has(entry.ptyId) && !this.entries.has(entry.ptyId))
              .map((entry) => entry.ptyId)
        for (const ptyId of strays) {
          let entry = this.entries.get(ptyId)
          if (!entry) {
            entry = {
              node,
              threadId,
              ptyId,
              openedAt: this.clock.now(),
              lastSeq: 0,
              waiting: new Map(),
              line: Promise.resolve(),
              bytesIn: 0,
              bytesOut: 0
            }
            this.entries.set(ptyId, entry)
          }
          entry.end ??= 'create_failed'
          this.kill(ptyId)
        }
      }
    }
  }

  // ------------------------------------------------------------------ input

  /**
   * Decides what a numbered input call does, and takes its place in line. A number at or below the newest one
   * taken is a resend, answered with where the owner is (`lastSeq`) and not applied. Otherwise the call takes its
   * number (waiting a moment for the number before it, if calls arrive out of order) and gets a way to apply
   * its input: `apply` runs after every earlier call has, waits for the device's rate if it must, and
   * refuses `rate_limited` only when the wait would be long.
   */
  async admitInput(
    node: NodeId,
    ptyId: string,
    seq: number
  ): Promise<
    | { duplicate: true; lastSeq: number }
    | { duplicate: false; apply<T>(bytes: number, work: () => Promise<T>): Promise<T> }
  > {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.node !== node)
      throw new DomainRpcError('pty_not_found', 'No such terminal in this thread', { id: ptyId })
    if (seq <= entry.lastSeq) return { duplicate: true, lastSeq: entry.lastSeq }
    if (seq > entry.lastSeq + 1) {
      // Calls sent one after the other arrive in order, but nothing promises it: the one before this waits its turn.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          entry.waiting.delete(seq)
          resolve()
        }, TERMINAL_GAP_WAIT_MS)
        timer.unref?.()
        entry.waiting.set(seq, () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (seq <= entry.lastSeq) return { duplicate: true, lastSeq: entry.lastSeq }
    }
    entry.lastSeq = seq
    // The call after this one may be waiting for it.
    const next = entry.waiting.get(seq + 1)
    if (next) {
      entry.waiting.delete(seq + 1)
      next()
    }
    const before = entry.line
    let done!: () => void
    entry.line = new Promise<void>((resolve) => (done = resolve))
    return {
      duplicate: false,
      apply: async (bytes, work) => {
        await before
        try {
          entry.bytesIn += bytes
          const wait = this.reserve(node, bytes)
          if (wait > 0) await sleep(wait)
          return await work()
        } finally {
          done()
        }
      }
    }
  }

  /**
   * Takes `bytes` (and a call) from the device's budget and says how long to wait before they are spendable.
   * A wait that would be long is refused instead, and nothing is taken.
   */
  private reserve(node: NodeId, bytes: number): number {
    const now = this.clock.now()
    let bucket = this.buckets.get(node)
    if (!bucket) {
      bucket = { bytes: TERMINAL_INPUT_BURST_BYTES, calls: TERMINAL_INPUT_BURST_CALLS, at: now }
      this.buckets.set(node, bucket)
    }
    const seconds = Math.max(0, now - bucket.at) / 1000
    bucket.at = now
    bucket.bytes = Math.min(TERMINAL_INPUT_BURST_BYTES, bucket.bytes + seconds * TERMINAL_INPUT_BYTES_PER_SECOND)
    bucket.calls = Math.min(TERMINAL_INPUT_BURST_CALLS, bucket.calls + seconds * TERMINAL_INPUT_CALLS_PER_SECOND)
    const needed = Math.max(
      (bytes - bucket.bytes) / TERMINAL_INPUT_BYTES_PER_SECOND,
      (1 - bucket.calls) / TERMINAL_INPUT_CALLS_PER_SECOND,
      0
    )
    const wait = Math.ceil(needed * 1000)
    if (wait > TERMINAL_INPUT_WAIT_MS)
      throw new DomainRpcError('rate_limited', 'Terminal input is arriving too fast for this computer to take it. Nothing of this part was typed.')
    bucket.bytes -= bytes
    bucket.calls -= 1
    return wait
  }

  // ------------------------------------------------------------------ ending

  /** Ends the terminals of `node` (or, without one, of every computer). Returns how many were stopped. */
  end(reason: TerminalEnd, node?: NodeId): number {
    return this.stop(reason, (candidate) => node === undefined || candidate === node)
  }

  /** Ends the terminals of every computer except those `granted` still allows. */
  endExcept(reason: TerminalEnd, granted: (node: NodeId) => boolean): number {
    return this.stop(reason, (candidate) => !granted(candidate))
  }

  /** Ends every terminal and waits until each is gone, with its end written to the audit. */
  async endAndWait(reason: TerminalEnd): Promise<void> {
    for (const claim of this.claims) claim.cancelled ??= reason
    const open = [...this.entries.values()]
    for (const entry of open) entry.end ??= reason
    await Promise.allSettled(
      open.map(async (entry) => {
        try {
          await this.options.services.ptyManager.killAndWait(entry.ptyId)
        } catch {
          // Already gone, or not stoppable: it is recorded as ended below, and the owner's own shutdown ends it.
        }
        this.closed(entry.ptyId)
      })
    )
  }

  /** Ends the terminals of devices that have been away from this computer for the grace period. */
  sweep(): number {
    const { connected } = this.options
    if (!connected) return 0
    const now = this.clock.now()
    const nodes = new Set([...this.entries.values()].map((entry) => entry.node))
    let ended = 0
    for (const node of [...this.away.keys()]) if (!nodes.has(node)) this.away.delete(node)
    for (const node of nodes) {
      if (connected(node)) {
        this.away.delete(node)
        continue
      }
      const since = this.away.get(node) ?? now
      this.away.set(node, since)
      if (now - since >= (this.options.awayMs ?? TERMINAL_AWAY_GRACE_MS)) {
        ended += this.end('device_away', node)
        this.away.delete(node)
      }
    }
    return ended
  }

  private stop(reason: TerminalEnd, matches: (node: NodeId) => boolean): number {
    let stopped = 0
    // A terminal that is still starting is stopped the moment its shell exists.
    for (const claim of this.claims) if (matches(claim.node)) claim.cancelled ??= reason
    for (const entry of [...this.entries.values()]) {
      if (!matches(entry.node)) continue
      entry.end ??= reason
      stopped++
      this.kill(entry.ptyId)
    }
    return stopped
  }

  private kill(ptyId: string): void {
    try {
      this.options.services.ptyManager.kill(ptyId)
    } catch {
      // Already gone: the exit is audited when it is seen.
    }
  }

  /** The terminal is gone, however it ended: one audit row says who, how and how much. */
  private closed(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    this.entries.delete(ptyId)
    for (const wake of entry.waiting.values()) wake()
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
