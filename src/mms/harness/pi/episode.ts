import { GATE_REFUSALS } from './extension/messages'

/**
 * The writer episode of one Pi RPC attempt and its batch barrier (PR 2 §4 "Writer episode and
 * batch barrier").
 *
 * - The gate never takes the writer per call. The first allowed parent mutation opens one episode,
 *   which holds the turn's writer (`acquire`) until the episode closes after a drain.
 * - `authorized` holds every call the gate allowed until its `tool_execution_end`, the process exit
 *   (after the tree kill) or the abort drain, including calls allowed but not started yet.
 * - A delegation waits in `quiesce` until no parent mutation is authorized or running. While a
 *   delegation is authorized, the gate denies new parent mutations (`mousse_writer_yielded`): it
 *   denies rather than waits, because Pi preflights sibling calls before executing any of them.
 * - Delegation tools are registered sequential, so a batch with one runs in order and neither path
 *   normally triggers; the barrier holds if Pi's ordering ever does not.
 * - The engine never yields the writer to a child (`TaskWriterAuthority.delegate`) in PR 2.
 */

export type PiToolClass = 'read' | 'mutation' | 'delegation'

export type EpisodeDecision = { allow: true } | { allow: false; reason: string }

/** Why waiting delegations were rejected. */
export class EpisodeClosedError extends Error {
  constructor(readonly code: 'stopped' | 'interrupted', message: string) {
    super(message)
    this.name = 'EpisodeClosedError'
  }
}

export interface WriterEpisodeOptions {
  /**
   * Takes the turn's writer for the whole episode: called once, with a promise that settles when the
   * episode closes; resolves when the writer is held. Absent: the turn has no writer (no lease).
   */
  acquire?(released: Promise<void>): Promise<void>
}

interface Waiter {
  toolCallId: string
  resolve(): void
  reject(error: Error): void
}

export class WriterEpisode {
  private readonly authorized = new Map<string, PiToolClass>()
  private readonly waiters: Waiter[] = []
  private writer: Promise<void> | undefined
  private releaseWriter: (() => void) | undefined
  private closedBy: EpisodeClosedError | undefined
  private closed = false

  constructor(private readonly options: WriterEpisodeOptions = {}) {}

  /** The episode holds the writer (a parent mutation was allowed). */
  get open(): boolean {
    return this.writer !== undefined && !this.closed
  }

  /** Authorized calls not yet ended, by class. */
  pending(kind?: PiToolClass): number {
    let count = 0
    for (const value of this.authorized.values()) if (!kind || value === kind) count += 1
    return count
  }

  /** The gate's decision for an allowed call of `kind`; an allowed call enters the barrier. */
  async authorize(toolCallId: string, kind: PiToolClass): Promise<EpisodeDecision> {
    if (this.closedBy || this.closed) return { allow: false, reason: GATE_REFUSALS.denied }
    if (kind === 'mutation') {
      if (this.pending('delegation') > 0) return { allow: false, reason: GATE_REFUSALS.writerYielded }
      // Entered before the writer is awaited, so a delegation preflighted meanwhile waits for it.
      this.authorized.set(toolCallId, kind)
      try {
        await this.takeWriter()
      } catch (error) {
        this.authorized.delete(toolCallId)
        this.settle()
        return { allow: false, reason: error instanceof Error ? error.message : GATE_REFUSALS.denied }
      }
      if (this.closedBy) {
        this.authorized.delete(toolCallId)
        this.settle()
        return { allow: false, reason: GATE_REFUSALS.denied }
      }
      return { allow: true }
    }
    if (kind === 'delegation') this.authorized.set(toolCallId, kind)
    return { allow: true }
  }

  /** A call ended (`tool_execution_end`); it leaves the barrier. */
  ended(toolCallId: string): void {
    if (this.authorized.delete(toolCallId)) this.settle()
  }

  /**
   * Resolves when the delegation `toolCallId` may run: no parent mutation authorized or running.
   * Rejects when the episode was stopped or its process crashed, or when `signal` aborts.
   */
  quiesce(toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (this.closedBy) return Promise.reject(this.closedBy)
    if (this.authorized.get(toolCallId) !== 'delegation') return Promise.reject(new Error(GATE_REFUSALS.denied))
    if (this.pending('mutation') === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        toolCallId,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('The delegation was cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Stop: waiting delegations reject, nothing new is authorized. Running calls end through Pi's abort. */
  revoke(): void {
    this.fail(new EpisodeClosedError('stopped', 'The turn was stopped before the delegation could start'))
  }

  /**
   * The process is gone (after the tree kill): every entry leaves the barrier, waiting delegations
   * reject as interrupted, and the episode closes.
   */
  crashed(): void {
    this.fail(new EpisodeClosedError('interrupted', 'The agent stopped before the delegation could start'))
    this.authorized.clear()
    this.close()
  }

  /**
   * Closes the episode once every authorized call has ended (or the process is gone): the writer is
   * released exactly once. Later calls are refused.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.authorized.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.closedBy ?? new EpisodeClosedError('stopped', 'The turn ended before the delegation could start'))
    this.releaseWriter?.()
    this.releaseWriter = undefined
  }

  private fail(error: EpisodeClosedError): void {
    if (!this.closedBy) this.closedBy = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.closedBy)
  }

  private takeWriter(): Promise<void> {
    if (this.writer) return this.writer
    const acquire = this.options.acquire
    if (!acquire) {
      this.writer = Promise.resolve()
      return this.writer
    }
    const released = new Promise<void>((resolve) => {
      this.releaseWriter = resolve
    })
    this.writer = acquire(released)
    return this.writer
  }

  /** Releases delegations whose mutations all ended. */
  private settle(): void {
    if (this.pending('mutation') > 0) return
    for (const waiter of this.waiters.splice(0)) waiter.resolve()
  }
}
