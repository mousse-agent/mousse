import { ROUTED_RUN_WAIT_MAX_MS } from '../../shared/bridge/routed'
import type { QueuedMessage } from '../../shared/types'
import { DomainRpcError } from '../protocol/domainRegistry'
import { followMessage, type Followed, type WatchTarget } from '../run/settle/follow'
import type { ThreadWatchRecord, ThreadWatches } from '../run/settle/ThreadWatches'
import { TERMINAL_RUN_STATUSES, type RunRecord } from '../run/types'
import type { RemoteTarget, RemoteWaitResult } from './RemoteLaunchedThreads'

/**
 * The settle notice for a thread this computer's agent launched on another computer (issue #1160, docs/plans/
 * agent-threads-architecture.md §4.2): a watch whose target is there (`thread_watches.target_node`) is followed through
 * the routed reads `thread_wait` already makes (`RemoteLaunchedThreads.follow`: `runs.wait`, or polling on an older
 * computer), plus `runs.list`, `runs.get` and `queue.list` to find where the message went. Nothing is written there and
 * nothing there knows a watch exists.
 *
 * - **Only watched threads.** One loop per active watch, started when the watch is made or when the service starts
 *   (a restart resumes from the watch alone). Nothing follows a launched thread nobody asked about.
 * - **Keyed on the message.** When the run it followed ends, the loop reads that computer's runs and queue and resolves
 *   them with the same `followMessage` as on one computer: a run a pause handed on, a queued message a person edited
 *   (its run cancelled, a fresh one `queue:<itemId>` when it drains), a steer handed back to the queue. The message is
 *   only as visible as those reads: the newest `RUNS_READ` runs and the queue as it is now.
 * - **Never a false end.** A computer that does not answer (offline, Bridge off here, slow) is asked again later, backing
 *   off up to `MAX_RETRY_MS`, until the watch's 24 hours end it. A computer that refuses this device, stops sharing its
 *   threads or is too old ends the watch once, with a notice that names it; so does the person turning agents on that
 *   computer off here, as it would refuse the launcher's own `thread_wait`.
 * - **Never in the way.** Each loop is its own promise; a failure is caught and waited out, and no loop holds anything
 *   another call needs.
 */

/** What a follow needs of the routed reads (`RemoteLaunchedThreads`). */
export interface RemoteWatchReads {
  follow(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RemoteWaitResult>
  readThread(target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, method: string, params: Record<string, unknown>, what: string, signal?: AbortSignal): Promise<unknown>
}

export interface RemoteSettleHost {
  /** The routed reads; undefined while this computer has no run engine attached. */
  reads(): RemoteWatchReads | undefined
  /**
   * The thread there as this computer knows it: for a thread its agents launched, the computer's name and the title the
   * launch recorded; for any other thread there, the computer's name from the device list and no title.
   */
  launched(node: string, remoteThreadId: string): { computer: string; title?: string } | undefined
  /** Why agents here may not work on that computer now (the person turned it off since); undefined when they may. */
  denial(node: string, computer: string): { code: string; message: string } | undefined
  /**
   * The count of agent messages in a row the watched send carried there: the least the run there counts (it takes the
   * larger of that and its own count), and what a notice carries when that run's count cannot be read.
   */
  sentHops(watcherRunId: string): number
  /** The first wait after a round that did not reach the computer (default 5 s); it doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
  /** How long a round waits while the work waits on a person and the notice is already sent (default 15 s). */
  needsInputRecheckMs?: number
}

/** What a remote notice says about the run, read when it was decided (kept in memory until it is delivered). */
export interface RemoteNoticeDetails {
  runId?: string
  error?: string
  hops: number
  resultText?: string
  /** The reply's full length when that computer cut it before sending it. */
  resultChars?: number
}

/** How the follower tells `SettleNotices` what it decided; both write the watch, then deliver. */
export interface RemoteSettleDecisions {
  needsInput(watchId: string, details: RemoteNoticeDetails): void
  ended(watchId: string, status: string, runId: string | null, details: RemoteNoticeDetails | undefined): void
}

/** Refusals that end a watch: that computer will not answer this device's reads, or agents here may not work there now. */
const ENDS_WATCH: ReadonlySet<string> = new Set(['computer_not_shared', 'computer_outdated', 'computer_not_allowed'])
/** Runs one read of that computer's runs takes: the message is followed among these. */
export const RUNS_READ = 30
/** One follow of the run lasts at most this long before the watch is read again (its expiry, a cancel). */
const FOLLOW_SLICE_MS = 10 * 60_000
/** Rounds of one watch are at least this far apart, so nothing spins on a computer that answers at once. */
const MIN_ROUND_MS = 1_000
const DEFAULT_RETRY_MS = 5_000
const DEFAULT_MAX_RETRY_MS = 5 * 60_000
const DEFAULT_NEEDS_INPUT_RECHECK_MS = 15_000

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const codeOf = (error: unknown): string => (error instanceof DomainRpcError ? error.code : String((error as { code?: unknown } | null)?.code ?? 'remote_error'))

/** Where a resolve found the message, and the runs it read (the run it ended in, for the notice). */
interface Located {
  followed: Followed
  queueItemId: string | null
  runs: RunRecord[]
}

export class RemoteSettleFollower {
  private readonly loops = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly wakers = new Set<() => void>()
  private stopped = false

  constructor(
    private readonly watches: ThreadWatches,
    private readonly host: RemoteSettleHost,
    private readonly decide: RemoteSettleDecisions,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Follows the watch unless a loop already does. */
  follow(watchId: string): void {
    if (this.stopped || this.loops.has(watchId)) return
    const controller = new AbortController()
    const done = this.run(watchId, controller.signal)
      .catch((error) => console.warn('a settle watch on another computer stopped following', { watchId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (this.loops.get(watchId)?.controller === controller) this.loops.delete(watchId)
      })
    this.loops.set(watchId, { controller, done })
  }

  /** Stops following one watch (it expired). */
  cancel(watchId: string): void {
    this.loops.get(watchId)?.controller.abort()
    this.loops.delete(watchId)
  }

  /** Cuts every wait between attempts short: the computers may answer now (Bridge came up). */
  wake(): void {
    for (const waker of [...this.wakers]) waker()
  }

  stop(): void {
    this.stopped = true
    for (const { controller } of this.loops.values()) controller.abort()
    this.loops.clear()
    this.wake()
  }

  /** The watches followed now (tests). */
  following(): string[] {
    return [...this.loops.keys()]
  }

  /** Waits for every loop to end (tests, after `stop`). */
  async settled(): Promise<void> {
    await Promise.all([...this.loops.values()].map((loop) => loop.done))
  }

  /** Waits `ms`, or less when the watch is cancelled or the computers may answer again. */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        this.wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      signal.addEventListener('abort', done, { once: true })
      this.wakers.add(done)
    })
  }

  private async run(watchId: string, signal: AbortSignal): Promise<void> {
    let failures = 0
    // A loop starts by finding the message: a restart may have missed a hand-off.
    let locate = true
    // The message waits in the queue for its run: the thread's next run is followed, then it is looked for again.
    let awaiting = false
    let lastRound = 0
    let lastReply: RemoteWaitResult | undefined
    while (!signal.aborted && !this.stopped) {
      const watch = this.watches.get(watchId)
      if (!watch || watch.state !== 'active' || !watch.targetNode) return
      const gap = this.now() - lastRound
      if (gap < MIN_ROUND_MS) await this.pause(MIN_ROUND_MS - gap, signal)
      if (signal.aborted) return
      lastRound = this.now()
      const target = { node: watch.targetNode, remoteThreadId: watch.targetThreadId, computer: this.host.launched(watch.targetNode, watch.targetThreadId)?.computer ?? 'that computer' }
      try {
        const denied = this.host.denial(target.node, target.computer)
        if (denied) throw new DomainRpcError(denied.code, denied.message)
        const reads = this.host.reads()
        if (!reads) throw new DomainRpcError('computer_offline', 'Connecting to your other computers is turned off on this computer.')
        if (locate) {
          const found = await this.locate(reads, target, watch, signal)
          locate = false
          if (found.followed.kind === 'ended') {
            await this.end(reads, target, watch, found, lastReply, signal)
            return
          }
          if (found.followed.runId !== watch.runId || found.queueItemId !== watch.queueItemId) this.watches.follow(watchId, found.followed.runId, found.queueItemId)
          awaiting = found.followed.kind === 'awaiting'
          lastReply = undefined
          continue
        }
        const reply = await reads.follow(target, {
          ...(!awaiting && watch.runId ? { runId: watch.runId } : {}),
          timeoutMs: awaiting ? ROUTED_RUN_WAIT_MAX_MS : FOLLOW_SLICE_MS,
          signal
        })
        failures = 0
        if (reply.callerEnded || signal.aborted) return
        if (reply.status === 'timeout') {
          // A run a pause handed on goes on in the run that continues it.
          if (!awaiting && reply.continuedFrom && reply.run?.runId && reply.run.runId !== watch.runId) this.watches.follow(watchId, reply.run.runId)
          if (awaiting) locate = true
          continue
        }
        if (reply.status === 'needs_input') {
          // The message's own run waits on a person there (a queued run is not the one asking).
          if (!awaiting && reply.run && reply.run.status !== 'queued') {
            if (reply.run.runId !== watch.runId) this.watches.follow(watchId, reply.run.runId)
            if (watch.needsInput === null) this.decide.needsInput(watchId, { runId: reply.run.runId, hops: await this.hopsOf(reads, target, watch, reply.run.runId, signal) })
          }
          if (awaiting) locate = true
          // It waits on a person: asked again a little later, not at once (the wait there answers at once meanwhile).
          await this.pause(this.host.needsInputRecheckMs ?? DEFAULT_NEEDS_INPUT_RECHECK_MS, signal)
          continue
        }
        // The run ended there (or the thread has nothing to wait for): where is the message now?
        lastReply = reply
        locate = true
      } catch (error) {
        if (signal.aborted) return
        const code = codeOf(error)
        if (ENDS_WATCH.has(code)) {
          const reason = isRecord((error as DomainRpcError).details) ? (error as DomainRpcError).details as Record<string, unknown> : {}
          this.decide.ended(watchId, `unreachable:${code}${typeof reason.reason === 'string' ? `:${reason.reason}` : ''}`, watch.runId, undefined)
          return
        }
        if (code === 'remote_thread_gone') {
          this.decide.ended(watchId, 'deleted', watch.runId, undefined)
          return
        }
        // The run is not that thread's any more: the message is looked for among its runs and queue.
        if (code === 'run_not_found') {
          locate = true
          continue
        }
        // Not reached, slow, or a hiccup: never an end. Asked again later, backing off.
        failures += 1
        const first = this.host.retryMs ?? DEFAULT_RETRY_MS
        await this.pause(Math.min(this.host.maxRetryMs ?? DEFAULT_MAX_RETRY_MS, first * 2 ** Math.min(failures - 1, 16)), signal)
      }
    }
  }

  /** Reads that computer's runs and queue and resolves where the message is, as `followMessage` does on one computer. */
  private async locate(reads: RemoteWatchReads, target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, watch: ThreadWatchRecord, signal: AbortSignal): Promise<Located> {
    const read = (method: string, params: Record<string, unknown>): Promise<unknown> => reads.readThread(target, method, params, 'following the thread for a settle notice', signal)
    const listed = await read('runs.list', { limit: RUNS_READ })
    const runs = (isRecord(listed) && Array.isArray(listed.runs) ? listed.runs : []).filter(isRecord) as unknown as RunRecord[]
    if (watch.runId && !runs.some((run) => run.runId === watch.runId)) {
      try {
        const got = await read('runs.get', { runId: watch.runId })
        if (isRecord(got) && isRecord(got.run)) runs.push(got.run as unknown as RunRecord)
      } catch (error) {
        if (codeOf(error) !== 'run_not_found') throw error
      }
    }
    const queue = await read('queue.list', {})
    const items = (isRecord(queue) && Array.isArray(queue.items) ? queue.items : []).filter(isRecord) as unknown as QueuedMessage[]
    const byId = (runId: string): RunRecord | undefined => runs.find((run) => run.runId === runId)
    const snapshot: WatchTarget = {
      getRun: (runId) => byId(runId) ?? null,
      continuationOf: (_threadId, runId) => runs.find((run) => run.outcome?.continuationOf === runId),
      queueRun: (_threadId, itemId) => runs.filter((run) => run.clientRequestId === `queue:${itemId}`).sort((a, b) => b.ordinal - a.ordinal)[0],
      queueItemForRun: (_threadId, runId) => items.find((item) => item.runId === runId && item.state !== 'claimed')?.id,
      queueItem: (_threadId, itemId) => items.find((item) => item.id === itemId),
      activeRun: () => runs.find((run) => run.status === 'starting' || run.status === 'running' || run.status === 'finalizing') ?? null
    }
    const queueItemId = watch.queueItemId ?? (watch.runId ? snapshot.queueItemForRun(watch.targetThreadId, watch.runId) ?? null : null)
    return { followed: followMessage(snapshot, watch.targetThreadId, watch.runId, queueItemId), queueItemId, runs }
  }

  /** The message's work ended there: its reply, error and count are read, then the watch ends. */
  private async end(reads: RemoteWatchReads, target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, watch: ThreadWatchRecord, found: Located, lastReply: RemoteWaitResult | undefined, signal: AbortSignal): Promise<void> {
    const followed = found.followed as Extract<Followed, { kind: 'ended' }>
    const run = followed.runId ? found.runs.find((entry) => entry.runId === followed.runId) : undefined
    let details: RemoteNoticeDetails | undefined
    if (run && TERMINAL_RUN_STATUSES.has(run.status) && followed.status !== 'removed') {
      let reply = lastReply?.status === 'finished' && lastReply.run?.runId === run.runId ? lastReply : undefined
      // The reply of a run the follow did not end on (a hand-off, a restart): one short wait on it, which answers at once.
      if (!reply) reply = await reads.follow(target, { runId: run.runId, timeoutMs: 1_000, signal }).catch(() => undefined)
      const text = reply?.status === 'finished' && reply.run?.runId === run.runId ? reply.resultText : undefined
      details = {
        runId: run.runId,
        ...(run.outcome?.error ? { error: String(run.outcome.error) } : {}),
        hops: Math.max(run.outcome?.agentHops ?? 0, this.host.sentHops(watch.watcherRunId)),
        ...(text !== undefined ? { resultText: text.endsWith('…') && reply?.resultChars ? text.slice(0, -1) : text } : {}),
        ...(reply?.resultChars ? { resultChars: reply.resultChars } : {})
      }
    }
    if (signal.aborted) return
    this.decide.ended(watch.watchId, followed.status, followed.runId, details)
  }

  /** The count of agent messages in a row of the run there, never below what the send carried. */
  private async hopsOf(reads: RemoteWatchReads, target: Pick<RemoteTarget, 'node' | 'computer' | 'remoteThreadId'>, watch: ThreadWatchRecord, runId: string, signal: AbortSignal): Promise<number> {
    const floor = this.host.sentHops(watch.watcherRunId)
    try {
      const got = await reads.readThread(target, 'runs.get', { runId }, 'following the thread for a settle notice', signal)
      const hops = isRecord(got) && isRecord(got.run) && isRecord(got.run.outcome) ? got.run.outcome.agentHops : undefined
      return Math.max(typeof hops === 'number' ? hops : 0, floor)
    } catch {
      return floor
    }
  }
}
