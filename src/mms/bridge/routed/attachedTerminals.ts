import { ROUTED_PTY_INPUT_MAX_CHARS, ROUTED_PTY_PASTE_MAX_BYTES } from '../../../shared/bridge/routed'
import { NetError, type NodeId, type StreamDescriptor } from '../../../shared/net'
import { qualifyId } from '../../../shared/threadRef'
import { PROJECT_SHELL_AGENT_ID } from '../../../shared/types'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { BridgeHub } from '../hub'
import type { ThreadDisplayUpdate } from '../remote/ThreadDisplayProjection'
import type { RoutedClient } from './RoutedClient'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The entity a terminal's stream is read as: the subject its records carry (`mousse:pty:<id>`). */
export const terminalEntity = (ptyId: string): string => `mousse:pty:${ptyId}`

/** How long a terminal's earlier output waits for the window to show it before it is delivered anyway. */
const INITIAL_OUTPUT_WAIT_MS = 1500
/** Output held back (while earlier output is fetched or the window is not ready) is delivered once it is this large. */
const HELD_MAX_CHARS = 1024 * 1024
const MAX_PART = Number.MAX_SAFE_INTEGER
const RETRIES = 3

/** What a terminal of another computer needs from the daemon around it. */
export interface AttachedTerminalsOptions {
  services: MmsProfileServices
  hub: BridgeHub
  client: RoutedClient
  /** Waits before a stream is attached again (default 1 s, times the attempt). */
  retryMs?: number
  /** How long a terminal's earlier output waits for its window before it is delivered anyway (default 1.5 s). */
  initialWaitMs?: number
}

interface Terminal {
  node: NodeId
  /** The thread's id on its own computer, and as windows here name it. */
  threadId: string
  qualified: string
  ptyId: string
  agentId: string
  handle?: { close(): void; descriptor: StreamDescriptor }
  attaching?: Promise<void>
  /** The newest piece of output handed to the windows: a piece at or before it is not delivered again. */
  last?: { sequence: number; part: number }
  /** While above zero, what the terminal says is kept and delivered, in order, when the last hold ends. */
  holds: number
  held: Array<() => void>
  heldChars: number
  /** Output from before the stream was attached, waiting for the window to be ready for it. */
  initial?: { data: string; sequence: number }
  initialTimer?: ReturnType<typeof setTimeout>
  exited: boolean
  dropped: boolean
  retries: number
  /** The newest input number taken for this terminal. Every call takes the next, so numbers never repeat and never go back. */
  seq: number
  /**
   * Whether this computer knows its numbers are the ones the owner counts: the terminal was opened here, or the owner
   * said where it is (`lastSeq`), or a number was accepted. Until then a "resend" answer means the numbers are stale.
   */
  verified: boolean
}

/**
 * The terminals this computer opened on others (or looked up there). Each is a stream only this computer
 * reads, which carries the terminal's output one record per chunk, in order. What it says is turned into
 * the events a local terminal would have given a window (`pty.data`, `pty.exit`), with the thread named
 * as windows here name it.
 *
 * - **Output.** A chunk keeps the terminal's own sequence number. A piece that was already delivered is
 *   not delivered again (a stream that is read again repeats what it had), and when this computer was
 *   away long enough to miss some, the missing output is fetched with `pty.outputSince` and delivered
 *   first, in order; if the owner no longer holds it, the terminal is cleared and its scrollback is
 *   written again.
 * - **Input.** Numbered calls. Each takes the next number of its terminal the moment the window makes it, and is
 *   sent without waiting for the one before: the numbers are the order, and the owner puts calls back in
 *   order. A lost reply is answered by sending the same number again, which the owner does not apply twice.
 *   The count is the owner's own: it starts at 0 for a terminal opened here, and at what the owner says
 *   (`lastSeq`) for one found later, so it never depends on a clock; an owner that says a number was already
 *   taken before any was accepted gets the call again under the next number. A paste too large for the owner's
 *   budget is refused whole, before any of it is sent.
 * - **End.** A terminal that ends, is stopped here, or is ended by the owner (its switch went off, the
 *   device was blocked) is told to the windows as `pty.exit`, and its stream is let go of.
 */
export class AttachedTerminals {
  private readonly terminals = new Map<string, Terminal>()
  /** Streams being closed on the owner: one for the same terminal is not opened until it is done, or the close would catch it. */
  private readonly closing = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: AttachedTerminalsOptions) {}

  private key(node: NodeId, ptyId: string): string {
    return `${node}|${ptyId}`
  }

  /** Terminals that are attached or being, for tests and the device screens. */
  state(): Array<{ node: NodeId; ptyId: string; attached: boolean; exited: boolean }> {
    return [...this.terminals.values()].map((term) => ({
      node: term.node,
      ptyId: term.ptyId,
      attached: !!term.handle,
      exited: term.exited
    }))
  }

  /**
   * Starts reading a terminal's output, unless it already is. Never waits for the stream: the caller has what
   * it asked for, and the output follows. A stream that cannot be attached is looked into, and the terminal is
   * reported as ended if it is.
   */
  ensure(
    node: NodeId,
    threadId: string,
    ptyId: string,
    agentId?: string,
    lastSeq?: number,
    created = false
  ): void {
    if (this.closed) return
    const key = this.key(node, ptyId)
    let term = this.terminals.get(key)
    if (!term) {
      term = {
        node,
        threadId,
        qualified: qualifyId(node, threadId),
        ptyId,
        agentId: agentId ?? PROJECT_SHELL_AGENT_ID,
        holds: 0,
        held: [],
        heldChars: 0,
        exited: false,
        dropped: false,
        retries: 0,
        // A terminal this computer just opened counts from 0; one found alive counts from where the owner is.
        seq: lastSeq ?? 0,
        verified: lastSeq !== undefined || created === true
      }
      this.terminals.set(key, term)
    } else if (agentId && term.agentId === PROJECT_SHELL_AGENT_ID) term.agentId = agentId
    if (term.exited || term.handle || term.attaching) return
    void this.attach(term).catch(() => this.reconcile(term!))
  }

  /** The window stopped the terminal (or found it gone): nothing reads it any more. */
  forget(node: NodeId, ptyId: string): void {
    const term = this.terminals.get(this.key(node, ptyId))
    if (term) this.drop(term)
  }

  /** A session with `node` opened: the terminals read there that lost their stream are looked at again. */
  nodeOnline(node: NodeId): void {
    for (const term of this.terminals.values())
      if (term.node === node && !term.handle && !term.attaching && !term.exited) void this.reconcile(term)
  }

  close(): void {
    this.closed = true
    for (const term of [...this.terminals.values()]) this.drop(term, false)
  }

  // ------------------------------------------------------------------ the stream

  private attach(term: Terminal): Promise<void> {
    if (term.handle) return Promise.resolve()
    if (term.attaching) return term.attaching
    const { hub, client } = this.options
    term.attaching = (async () => {
      await this.closing.get(this.key(term.node, term.ptyId))
      const handle = await hub.attach(
        { nodeId: term.node, entityId: terminalEntity(term.ptyId) },
        (update) => this.onUpdate(term, update),
        // The stream ended (the link, or the owner stopped serving it): find out whether the terminal did.
        () => {
          term.handle = undefined
          void this.reconcile(term)
        },
        {
          room: 'terminal',
          open: async () => {
            const opened = await client.openStream(term.node, {
              kind: 'terminal',
              threadId: term.threadId,
              ptyId: term.ptyId
            })
            return { descriptor: opened.descriptor as StreamDescriptor, head: opened.head }
          }
        }
      )
      if (this.closed || term.dropped || term.exited) {
        handle.close()
        this.tellOwnerClosed(term)
        return
      }
      term.handle = handle
      term.retries = 0
    })().finally(() => {
      term.attaching = undefined
    })
    return term.attaching
  }

  private tellOwnerClosed(term: Terminal): void {
    if (this.closed) return
    const key = this.key(term.node, term.ptyId)
    const closing: Promise<void> = this.options.client
      .closeStream(term.node, { kind: 'terminal', threadId: term.threadId, ptyId: term.ptyId })
      .catch(() => undefined)
      .finally(() => {
        if (this.closing.get(key) === closing) this.closing.delete(key)
      })
    this.closing.set(key, closing)
  }

  private drop(term: Terminal, tell = true): void {
    term.dropped = true
    if (term.initialTimer) clearTimeout(term.initialTimer)
    term.initialTimer = undefined
    const held = term.handle
    held?.close()
    term.handle = undefined
    this.terminals.delete(this.key(term.node, term.ptyId))
    if (held && tell) this.tellOwnerClosed(term)
  }

  /**
   * The stream of a terminal went away: ask the owner whether the terminal is still there and still ours to read.
   * A computer that cannot be reached is waited for (`nodeOnline` comes back here); a terminal that is gone, or
   * that this device may no longer have (its switch went off, it was blocked), is reported ended.
   */
  private async reconcile(term: Terminal): Promise<void> {
    if (this.closed || term.dropped || term.exited || term.attaching) return
    let alive = false
    try {
      const read = await this.options.client.call(term.node, 'pty.isAlive', {
        threadId: term.threadId,
        ptyId: term.ptyId
      })
      alive = isRecord(read) && read.alive === true
    } catch (error) {
      if (
        error instanceof DomainRpcError &&
        ['computer_offline', 'deadline_exceeded', 'rate_limited', 'cancelled'].includes(error.code)
      )
        return
      if (error instanceof NetError && ['peer_offline', 'route_unreachable'].includes(error.code)) return
      // Refused (the switch is off, the device is blocked, the terminal is not there): it is over for this device.
      this.ended(term, null, 'terminated')
      return
    }
    if (!alive) return this.ended(term, null, 'terminated')
    if (term.retries >= RETRIES) return
    term.retries += 1
    const timer = setTimeout(
      () => {
        if (this.closed || term.dropped || term.exited || term.handle || term.attaching) return
        void this.attach(term).catch(() => this.reconcile(term))
      },
      (this.options.retryMs ?? 1000) * term.retries
    )
    timer.unref?.()
  }

  // ------------------------------------------------------------------ output

  private onUpdate(term: Terminal, update: ThreadDisplayUpdate): void {
    if (update.kind === 'snapshot') return this.onSnapshot(term, update.value)
    if (update.type === 'pty.data') return this.onData(term, update.data)
    const exit = update.data
    if (update.type === 'pty.exit' && isRecord(exit))
      this.emit(term, () =>
        this.ended(
          term,
          typeof exit.exitCode === 'number' ? exit.exitCode : null,
          typeof exit.signal === 'string' ? exit.signal : null
        )
      )
  }

  private onSnapshot(term: Terminal, value: unknown): void {
    if (!isRecord(value)) return
    const sequence = typeof value.sequence === 'number' ? value.sequence : 0
    const scrollback = typeof value.scrollback === 'string' ? value.scrollback : ''
    if (term.last === undefined) {
      // The first look at the terminal: what it printed before this was attached is its scrollback.
      term.last = { sequence, part: MAX_PART }
      if (scrollback) this.holdInitial(term, scrollback, sequence)
    } else if (sequence > term.last.sequence) {
      // This computer was away while the terminal went on: the output it missed comes first.
      void this.fill(term, sequence)
    }
    // Already over when it was attached: what it printed, then the end, without waiting for a window.
    if (value.alive === false) this.ended(term, null, null)
  }

  /** Output from before the stream was attached waits until the window has shown it is ready (it resizes), or a moment passes. */
  private holdInitial(term: Terminal, data: string, sequence: number): void {
    term.initial = { data, sequence }
    this.hold(term)
    term.initialTimer = setTimeout(() => this.release(term), this.options.initialWaitMs ?? INITIAL_OUTPUT_WAIT_MS)
    term.initialTimer.unref?.()
  }

  /** The window asked something of the terminal (it fitted it and resized it): it can take what was kept. */
  private release(term: Terminal): void {
    if (!term.initial) return
    const { data, sequence } = term.initial
    term.initial = undefined
    if (term.initialTimer) clearTimeout(term.initialTimer)
    term.initialTimer = undefined
    // Delivered first: everything held after it is later output.
    this.push(term, 'pty.data', { data, sequence })
    this.unhold(term)
  }

  private hold(term: Terminal): void {
    term.holds += 1
  }
  private unhold(term: Terminal): void {
    term.holds -= 1
    if (term.holds > 0) return
    const work = term.held.splice(0)
    term.heldChars = 0
    for (const run of work) run()
  }
  /** Runs `work` now, or, while something earlier is still to be delivered, after it. */
  private emit(term: Terminal, work: () => void, chars = 0): void {
    if (term.holds === 0) return work()
    term.held.push(work)
    term.heldChars += chars
    // A window that never asks does not make a terminal grow without bound.
    if (term.heldChars > HELD_MAX_CHARS && term.initial) this.release(term)
  }

  private onData(term: Terminal, value: unknown): void {
    if (!isRecord(value) || typeof value.data !== 'string' || typeof value.sequence !== 'number') return
    const sequence = value.sequence
    const part = typeof value.part === 'number' ? value.part : 0
    this.emit(
      term,
      () => {
        const last = term.last
        // Already delivered: a repeat after the stream was read again, or output the missing-output fetch brought.
        if (last && (sequence < last.sequence || (sequence === last.sequence && part <= last.part))) return
        term.last = { sequence, part }
        this.push(term, 'pty.data', { data: value.data as string, sequence })
      },
      (value.data as string).length
    )
  }

  /** Fetches what the terminal printed while this computer was away and delivers it before anything newer. */
  private async fill(term: Terminal, upTo: number): Promise<void> {
    const after = term.last?.sequence ?? 0
    this.hold(term)
    try {
      const got = await this.options.client.call(term.node, 'pty.outputSince', {
        threadId: term.threadId,
        ptyId: term.ptyId,
        afterSequence: after
      })
      if (!isRecord(got) || typeof got.sequence !== 'number') return
      if (got.gap === true && typeof got.scrollback === 'string') {
        // The owner no longer holds all of it: clear the terminal and write what it does hold.
        this.push(term, 'pty.data', { data: `\x1bc${got.scrollback}`, sequence: got.sequence })
      } else
        for (const chunk of Array.isArray(got.chunks) ? got.chunks : [])
          if (isRecord(chunk) && typeof chunk.data === 'string' && typeof chunk.sequence === 'number')
            this.push(term, 'pty.data', { data: chunk.data, sequence: chunk.sequence })
      term.last = { sequence: Math.max(got.sequence, upTo, term.last?.sequence ?? 0), part: MAX_PART }
    } catch {
      // The computer went away again; the next snapshot asks for it once more.
    } finally {
      this.unhold(term)
    }
  }

  private push(term: Terminal, type: 'pty.data' | 'pty.exit', data: Json): void {
    this.options.services.events.emit({
      channel: 'protocol:event',
      data: {
        type,
        data: { ...data, ptyId: term.ptyId, agentId: term.agentId, threadId: term.qualified },
        threadId: term.qualified
      }
    })
  }

  /** The terminal is over. Windows are told once, after everything it printed, and nothing reads it any more. */
  private ended(term: Terminal, exitCode: number | null, signal: string | null): void {
    if (term.exited) return
    term.exited = true
    if (term.initial) this.release(term)
    // Whatever was still waiting to be delivered comes before the end.
    const waiting = term.held.splice(0)
    term.holds = 0
    term.heldChars = 0
    for (const run of waiting) run()
    this.push(term, 'pty.exit', { exitCode, signal })
    this.drop(term)
  }

  // ------------------------------------------------------------------ input

  /**
   * Types into, or resizes, a terminal on `node`. The calls of one terminal go one at a time, in order, each
   * with its own number, and a long paste is cut into calls of at most `ROUTED_PTY_INPUT_MAX_CHARS`.
   */
  input(
    node: NodeId,
    threadId: string,
    ptyId: string,
    method: 'pty.write' | 'pty.resize',
    params: Json,
    options: { signal?: AbortSignal } = {}
  ): Promise<unknown> {
    if (
      method === 'pty.write' &&
      typeof params.data === 'string' &&
      Buffer.byteLength(params.data) > ROUTED_PTY_PASTE_MAX_BYTES
    )
      return Promise.reject(
        new DomainRpcError(
          'paste_too_large',
          `That is too much to paste into a terminal at once (the limit is ${ROUTED_PTY_PASTE_MAX_BYTES / 1024} KiB). Nothing was sent.`,
          { limit: ROUTED_PTY_PASTE_MAX_BYTES }
        )
      )
    this.ensure(node, threadId, ptyId)
    const term = this.terminals.get(this.key(node, ptyId))
    // Not tracked (the daemon is shutting down): nothing to number.
    if (!term) return Promise.reject(new DomainRpcError('cancelled', 'Mousse is shutting down.'))
    // A resize means the window mounted the terminal: what was kept for it can be shown.
    if (method === 'pty.resize') this.release(term)
    const pieces =
      method === 'pty.write' && typeof params.data === 'string'
        ? split(params.data, ROUTED_PTY_INPUT_MAX_CHARS)
        : [undefined]
    // The numbers are taken here, in the order the window made the calls, and the calls go out together.
    const sends = pieces.map((piece) =>
      this.sendNumbered(
        term,
        node,
        method,
        { ...params, ...(piece === undefined ? {} : { data: piece }) },
        ++term.seq,
        options.signal
      )
    )
    return Promise.allSettled(sends).then((settled) => {
      const failed = settled.find((one): one is PromiseRejectedResult => one.status === 'rejected')
      if (failed) throw failed.reason
      return (settled.at(-1) as PromiseFulfilledResult<unknown>).value
    })
  }

  /**
   * One numbered call. An answer of "already taken" for a number this computer never had accepted means its count
   * is behind the owner's (a restart that forgot it): the owner's `lastSeq` becomes the new floor and the call is
   * sent again under the next number. Once a number has been accepted, that answer is only a resend of a call
   * whose reply was lost, and the call is done.
   */
  private async sendNumbered(
    term: Terminal,
    node: NodeId,
    method: string,
    params: Json,
    seq: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    let number = seq
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await this.call(node, method, { ...params, seq: number }, signal)
      if (!isRecord(reply) || reply.duplicate !== true) {
        term.verified = true
        return reply
      }
      if (term.verified || typeof reply.lastSeq !== 'number') return reply
      term.seq = Math.max(term.seq, reply.lastSeq)
      number = ++term.seq
    }
    throw new DomainRpcError('terminal_out_of_step', 'This computer and the terminal could not agree on the order of input. Nothing was typed.')
  }

  private call(node: NodeId, method: string, params: Json, signal?: AbortSignal): Promise<unknown> {
    return this.options.client.call(node, method, params, signal ? { signal } : {})
  }
}

/** Cuts text into pieces of at most `size` characters, never between the two halves of one character. */
function split(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const pieces: string[] = []
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + size)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    pieces.push(text.slice(at, end))
    at = end
  }
  return pieces
}
