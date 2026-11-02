import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pullRequestIdentityKey,
  sameLinkedPullRequest,
  type LineCommentRead,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestIdentity,
  type PullRequestWatchEnd,
  type PullRequestWatchMode,
  type PullRequestWatchStatus,
  type ThreadPullRequestLink
} from '../../shared/pullRequests'
import type { Thread } from '../../shared/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { RunStore } from '../run/RunStore'
import { currentStopGeneration } from '../run/stopGeneration'
import type { CodeHost } from './CodeHost'
import { PullRequestReadError } from './GitHubCodeHost'
import {
  advanceWatchReads,
  changeIds,
  changeKinds,
  completeDelivery,
  cutoffMs,
  dropPendingDeliveries,
  evaluatePullRequestWatch,
  formatPullRequestNotice,
  hostTimestamp,
  initialWatchState,
  prepareDeliveries,
  reconcileDue,
  watchEndedLine,
  type WatchState
} from './pullRequestWatch'

/** A refusal with a code the daemon turns into its own error type. */
export class PullRequestWatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PullRequestWatchError'
  }
}

export const WATCH_SIDECAR_FILE = 'pull-request-watch.json'
/** Watches one profile runs at once; each polls, so the number is bounded. */
export const MAX_WATCHED_THREADS = 50
const MIN_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 600_000
const TICK_MS = 15_000
/** Distinct pull requests read in one tick; the rest stay due and go first in the next. */
const MAX_READS_PER_TICK = 8
/** Requests to the host (a pull request read, a page of line comments) one tick may make; the rest wait for the next. */
const MAX_REQUESTS_PER_TICK = 30
const RATE_LIMIT_PAUSE_MS = 10 * 60_000
const SIGNED_OUT_PAUSE_MAX_MS = 30 * 60_000
const READ_FAILURE_LIMIT = 8
const NOT_FOUND_LIMIT = 3

/** What a watch keeps on disk next to the thread: its state and when it reads next. */
interface Sidecar {
  version: 1
  /** `off` keeps the record so the next watch continues the revision and no id is ever written twice. */
  mode: PullRequestWatchMode
  pr: PullRequestIdentity
  watchRevision: number
  /** The thread's stop generation when the watch was turned on; a higher one means a Stop reached the thread. */
  stopGeneration: number
  state: WatchState
  nextAt: string
  intervalMs: number
  /** A rate limit or a sign-out is being waited out until then. */
  pausedUntil: string | null
  /** When the pull request was last asked about: a run's end cannot bring the next read closer than the interval floor. */
  lastReadAt?: string | null
  ended: { reason: PullRequestWatchEnd; at: string } | null
}

export interface PullRequestWatchDeps {
  threads: {
    getThread(id: string): Thread | undefined
    getThreadDir(id: string): string
    listAllThreads(): Thread[]
    updateThreadMeta(id: string, partial: { pullRequest?: ThreadPullRequestLink }, opts?: { touch?: boolean }): Thread
  }
  codeHost: CodeHost
  /** The folder `gh` runs in for this thread: its project's checkout, which names the same repository as every worktree. */
  folderFor(threadId: string): string | null
  /** False once the thread is in the trash or being purged. */
  isAvailable(threadId: string): boolean
  runStore(): RunStore | null
  /**
   * Writes a system line into the thread, once per `messageId`, and answers only after it is on disk: `delivered` when
   * it wrote it, `already` when the thread already held it. It throws when the line could not be saved.
   */
  notify(threadId: string, text: string, messageId: string): Promise<'delivered' | 'already'>
  /** Calls `listener` when a run of any thread ends; returns the unsubscribe function. */
  onRunEnd?(listener: (threadId: string) => void): () => void
  clock?: () => number
  minIntervalMs?: number
  maxIntervalMs?: number
  tickMs?: number
  maxReadsPerTick?: number
  maxRequestsPerTick?: number
}

interface Due {
  threadId: string
  folder: string
  pr: PullRequestIdentity
}

/**
 * Watches the pull requests of the threads that asked, and tells the thread when checks finish or a review or comment
 * arrives. It only notifies: it never starts a turn, so nothing runs on the person's code or repository without them.
 * Bounded: one read per pull request however many threads watch it, at most `maxReadsPerTick` pull requests per tick, a floor of a minute per thread that doubles while quiet up to ten, a
 * pause for a rate limit or a sign-out, and an end after repeated failures. Each thread's progress is a sidecar file;
 * a notice is delivered through three steps (record, write, complete) so that a restart at any point repeats and loses nothing.
 */
export class PullRequestWatchService extends EventEmitter {
  private readonly entries = new Map<string, Sidecar>()
  private readonly hostPaused = new Map<string, number>()
  /** Line comment pages already read in this tick, so threads with the same position share the request. */
  private pageReads = new Map<string, Promise<LineCommentRead>>()
  private requestsLeft = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private flight: Promise<void> | undefined
  private unsubscribe: (() => void) | undefined
  private stopped = false
  private nudged = false
  /** True until the first tick has run: a notice a restart cut off is replayed then, whatever its schedule. */
  private bootReplay = true
  private readonly clock: () => number
  private readonly minInterval: number
  private readonly maxInterval: number
  private readonly maxReads: number
  private readonly maxRequests: number

  constructor(private readonly deps: PullRequestWatchDeps) {
    super()
    this.clock = deps.clock ?? Date.now
    this.minInterval = deps.minIntervalMs ?? MIN_INTERVAL_MS
    this.maxInterval = deps.maxIntervalMs ?? MAX_INTERVAL_MS
    this.maxReads = deps.maxReadsPerTick ?? MAX_READS_PER_TICK
    this.maxRequests = deps.maxRequestsPerTick ?? MAX_REQUESTS_PER_TICK
  }

  /** Starts the timer (unref'd) and the first tick, which also replays any notice a restart cut off. */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, this.deps.tickMs ?? TICK_MS)
    this.timer.unref()
    this.unsubscribe = this.deps.onRunEnd?.((threadId) => this.onRunEnded(threadId))
    void this.tick()
  }

  /** Ends the timer and waits for the tick that is running. */
  stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    return this.flight ?? Promise.resolve()
  }

  /** Asks for a pass soon; several changes made together share it. */
  private nudge(): void {
    if (this.nudged || this.stopped) return
    this.nudged = true
    const timer = setTimeout(() => {
      this.nudged = false
      void this.tick()
    }, 0)
    timer.unref()
  }

  /** One pass over the watched threads. Calls while one runs join it. */
  tick(): Promise<void> {
    if (this.flight) return this.flight
    if (this.stopped) return Promise.resolve()
    const run = this.run().catch((error: unknown) => {
      console.warn('pull request watch tick failed', error instanceof Error ? error.message : String(error))
    })
    this.flight = run.finally(() => { this.flight = undefined })
    return this.flight
  }

  // Turning a watch on and off ------------------------------------------------------------------------------------

  /**
   * Sets the watch of a linked thread. Turning it on (from off or from an ended watch) starts a new one: a new cutoff and
   * an empty memory, so nothing that already happened is reported. Turning on a watch that runs keeps its memory.
   */
  setMode(threadId: string, mode: PullRequestWatchMode): PullRequestWatchStatus {
    const thread = this.deps.threads.getThread(threadId)
    if (!thread) throw new PullRequestWatchError('thread_not_found', 'Thread not found')
    const link = thread.pullRequest
    if (!link) throw new PullRequestWatchError('pull_request_not_linked', 'This thread has no pull request to watch.')
    const previous = this.load(threadId)
    const now = this.clock()
    if (mode === 'off') {
      // What was prepared but not yet delivered is withdrawn.
      if (previous) this.saveOrRefuse(threadId, { ...previous, mode: 'off', ended: null, state: dropPendingDeliveries(previous.state), watchRevision: previous.watchRevision + 1 })
      this.writeLinkWatch(threadId, 'off')
      return this.status(threadId)
    }
    if (mode !== 'notify') throw new PullRequestWatchError('invalid_params', 'Unknown watch mode')
    if (!(previous && previous.mode !== 'off' && !previous.ended) && this.activeCount() >= MAX_WATCHED_THREADS) {
      throw new PullRequestWatchError('too_many_watches', `At most ${MAX_WATCHED_THREADS} threads can watch a pull request at once. Turn another watch off first.`)
    }
    const pr: PullRequestIdentity = { host: link.host, nameWithOwner: link.nameWithOwner, number: link.number }
    const running = previous && previous.mode !== 'off' && !previous.ended && sameLinkedPullRequest(previous.pr, pr)
    const revision = (previous?.watchRevision ?? Math.floor(now / 1000)) + 1
    const next: Sidecar = running
      ? { ...previous, mode, watchRevision: revision }
      : {
          version: 1,
          mode,
          pr,
          watchRevision: revision,
          stopGeneration: this.stopGeneration(threadId),
          state: initialWatchState(now),
          nextAt: new Date(now).toISOString(),
          intervalMs: this.minInterval,
          pausedUntil: null,
          ended: null
        }
    this.saveOrRefuse(threadId, next)
    this.writeLinkWatch(threadId, mode)
    this.nudge()
    return this.status(threadId)
  }

  /** What a thread's watch is doing, for the side card. */
  status(threadId: string): PullRequestWatchStatus {
    const thread = this.deps.threads.getThread(threadId)
    const link = thread?.pullRequest
    const entry = this.load(threadId)
    const base = { threadId, viewer: null as string | null, host: link?.host ?? null }
    if (!entry || !link || !sameLinkedPullRequest(entry.pr, link)) return { ...base, mode: 'off', state: 'off', nextCheckAt: null, ended: null }
    if (entry.ended) return { ...base, mode: 'off', state: 'ended', nextCheckAt: null, ended: entry.ended }
    if (entry.mode === 'off') return { ...base, mode: 'off', state: 'off', nextCheckAt: null, ended: null }
    const paused = entry.pausedUntil !== null && Date.parse(entry.pausedUntil) > this.clock()
    return { ...base, mode: entry.mode, state: paused ? 'paused' : 'watching', nextCheckAt: entry.pausedUntil && paused ? entry.pausedUntil : entry.nextAt, ended: null }
  }

  /** A Stop reached these threads (the one stopped and every subagent below it): their watches end at once. */
  onStopped(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      if (!this.isWatched(threadId)) continue
      const entry = this.load(threadId)
      if (entry && entry.mode !== 'off' && !entry.ended) this.end(threadId, 'stopped')
    }
  }

  /** The link was removed or the thread settled or trashed: the watch ends with its line. */
  onEnded(threadId: string, reason: PullRequestWatchEnd): void {
    // An unlink has already cleared the link by now, so only the sidecar can say that the thread was watched.
    const entry = this.load(threadId)
    if (entry && entry.mode !== 'off' && !entry.ended) this.end(threadId, reason)
  }

  /** A run of the thread ended: the next read need not wait, and the interval starts over. */
  onRunEnded(threadId: string): void {
    if (!this.isWatched(threadId)) return
    const entry = this.load(threadId)
    if (!entry || entry.mode === 'off' || entry.ended) return
    // A run's end brings the next read forward, but never closer than the floor to the last one, however many runs end.
    const lastRead = Date.parse(entry.lastReadAt ?? '')
    const at = Math.max(this.clock(), Number.isNaN(lastRead) ? 0 : lastRead + this.minInterval)
    this.save(threadId, { ...entry, nextAt: new Date(at).toISOString(), intervalMs: this.minInterval })
    this.nudge()
  }

  // The tick -----------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    try {
      await this.pass()
    } finally {
      this.bootReplay = false
    }
  }

  private async pass(): Promise<void> {
    const now = this.clock()
    this.pageReads = new Map()
    this.requestsLeft = this.maxRequests
    const due: Due[] = []
    for (const thread of this.deps.threads.listAllThreads()) {
      const link = thread.pullRequest
      if (!link?.watch || link.watch === 'off') continue
      // A link an earlier version set to wake the agent now reads Notify.
      if ((link.watch as string) === 'act') this.writeLinkWatch(thread.id, 'notify')
      const entry = this.entryFor(thread.id, link)
      if (!entry || entry.mode === 'off' || entry.ended) continue
      const reason = this.ineligible(thread.id, entry)
      if (reason) {
        if (reason === 'off') continue
        this.end(thread.id, reason)
        continue
      }
      const waiting = Date.parse(entry.nextAt) > now || (entry.pausedUntil !== null && Date.parse(entry.pausedUntil) > now)
      // A notice a restart cut off goes out before anything is read: at the first tick whatever the schedule says, later
      // only when the thread is due, so a sink that keeps failing is retried on the same backoff as a read.
      if (entry.state.pending.length && (this.bootReplay || !waiting) && !(await this.replay(thread.id, entry.watchRevision))) continue
      const current = this.entries.get(thread.id)
      if (!current || current.watchRevision !== entry.watchRevision || current.mode === 'off' || current.ended) continue
      if (Date.parse(current.nextAt) > now) continue
      if (current.pausedUntil !== null && Date.parse(current.pausedUntil) > now) continue
      if ((this.hostPaused.get(current.pr.host.toLowerCase()) ?? 0) > now) continue
      const folder = this.deps.folderFor(thread.id)
      if (!folder) {
        // The project was removed: nothing can be read, and nothing will bring it back.
        this.end(thread.id, 'project_missing')
        continue
      }
      due.push({ threadId: thread.id, folder, pr: current.pr })
    }
    due.sort((a, b) => Date.parse(this.entries.get(a.threadId)!.nextAt) - Date.parse(this.entries.get(b.threadId)!.nextAt))
    const groups = new Map<string, Due[]>()
    for (const item of due) {
      const key = pullRequestIdentityKey(item.pr)
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    let reads = 0
    for (const members of groups.values()) {
      if (this.stopped || reads >= this.maxReads || this.requestsLeft <= 0) break
      const host = members[0].pr.host.toLowerCase()
      if (this.hostIsPaused(host)) continue
      reads++
      this.requestsLeft--
      const captured = new Map(members.map((member) => [member.threadId, this.entries.get(member.threadId)!.watchRevision]))
      let detail: PullRequestDetail | null = null
      let failure: unknown = null
      try {
        // One read serves every thread that watches this pull request.
        detail = await this.deps.codeHost.getPullRequestDetail(members[0].folder, members[0].pr.number, { force: true, lineComments: false })
        if (pullRequestIdentityKey(detail.identity) !== pullRequestIdentityKey(members[0].pr)) {
          throw new PullRequestReadError(`The project's repository is ${detail.identity.nameWithOwner}, not ${members[0].pr.nameWithOwner}, where this pull request is.`, 'not-found')
        }
      } catch (error) {
        failure = error
      }
      for (const member of members) {
        // A rate limit met by one thread of the group (or by the read itself) holds back the rest of it.
        if (this.stopped || this.hostIsPaused(host)) break
        await this.processMember(member, captured.get(member.threadId)!, detail, failure)
      }
    }
  }

  private async processMember(member: Due, revision: number, detail: PullRequestDetail | null, failure: unknown): Promise<void> {
    if (!this.current(member.threadId, revision)) return
    if (failure !== null || !detail) {
      this.readFailed(member.threadId, failure)
      return
    }
    const host = member.pr.host.toLowerCase()
    // Out of requests for this tick: the thread stays due and goes first in the next.
    if (this.requestsLeft <= 0 || this.hostIsPaused(host)) return
    const viewer = await this.deps.codeHost.viewerLogin(member.folder)
    if (!this.current(member.threadId, revision) || this.hostIsPaused(host)) return
    const entry = this.entries.get(member.threadId)!
    const state = entry.state
    const startedAt = this.clock()
    const identity = pullRequestIdentityKey(member.pr)
    let incremental: LineCommentRead | undefined
    let reconcile: LineCommentRead | undefined
    try {
      incremental = await this.readPages(`since|${identity}|${state.lineCursor.since}|${state.lineCursor.page}`, () => this.deps.codeHost.listLineCommentsSince(member.folder, member.pr, state.lineCursor))
      if (reconcileDue(state, startedAt) && this.requestsLeft > 0 && !this.hostIsPaused(host) && this.current(member.threadId, revision)) {
        const createdSince = hostTimestamp(cutoffMs(state.watchStartedAt) - 1000)
        reconcile = await this.readPages(`created|${identity}|${createdSince}|${state.reconcile.page}`, () => this.deps.codeHost.listLineCommentsCreatedSince(member.folder, member.pr, createdSince, state.reconcile.page))
      }
    } catch (error) {
      if (this.current(member.threadId, revision)) this.readFailed(member.threadId, error)
      return
    }
    // After the awaits: a Stop, an Off, an unlink or a settle that came meanwhile delivers nothing.
    if (!this.current(member.threadId, revision)) return
    const now = this.clock()
    const lineComments: PullRequestComment[] = [...(incremental?.comments ?? []), ...(reconcile?.comments ?? [])]
    const evaluated = evaluatePullRequestWatch(state, detail, lineComments, viewer, now)
    let next = advanceWatchReads(evaluated.next, { incremental, reconcile }, now)
    next = { ...next, readFailures: 0, notFound: 0 }
    const changed = evaluated.changes.length > 0
    // The baseline only records, so it does not count as a quiet read.
    const intervalMs = changed || state.baseline ? this.minInterval : Math.min(entry.intervalMs * 2, this.maxInterval)
    // One notice for everything that changed.
    const notices = changed ? [{ idPrefix: `pr-update:${member.threadId}:${entry.watchRevision}`, text: formatPullRequestNotice(evaluated.changes, detail), ids: changeIds(evaluated.changes) }] : []
    const prepared = prepareDeliveries(next, notices, now)
    // Step 1 must be on disk before the thread is written to: if it cannot be written, nothing is delivered and the read repeats.
    try {
      this.saveStrict(member.threadId, { ...entry, state: prepared.next, intervalMs, nextAt: new Date(now + intervalMs).toISOString(), pausedUntil: null, lastReadAt: new Date(startedAt).toISOString() })
    } catch (error) {
      if (this.current(member.threadId, revision)) this.readFailed(member.threadId, error)
      return
    }
    if (!(await this.replay(member.threadId, revision))) return
    if (changed) this.emit('updated', { threadId: member.threadId, number: detail.number, changes: changeKinds(evaluated.changes) })
    if (evaluated.ended && this.current(member.threadId, revision)) this.end(member.threadId, evaluated.ended)
  }

  // Delivery -----------------------------------------------------------------------------------------------------

  /**
   * Steps 2 and 3 of a delivery for every notice prepared and not yet complete: write it into the thread (idempotent by
   * the delivery id), then record its remarks as delivered. A thread that is no longer eligible drops them instead. False
   * when the write failed (counted as a read failure, so the watch backs off and ends after eight) or the watch changed.
   */
  private async replay(threadId: string, revision: number): Promise<boolean> {
    for (;;) {
      const entry = this.entries.get(threadId)
      if (!entry || entry.watchRevision !== revision) return false
      const delivery = entry.state.pending[0]
      if (!delivery) return true
      const reason = this.ineligible(threadId, entry)
      if (reason) {
        this.save(threadId, { ...entry, state: dropPendingDeliveries(entry.state) })
        if (reason !== 'off') this.end(threadId, reason)
        return false
      }
      try {
        await this.deps.notify(threadId, delivery.text, `msg:${delivery.deliveryId}`)
      } catch (error) {
        if (this.current(threadId, revision)) this.readFailed(threadId, error)
        return false
      }
      const after = this.entries.get(threadId)
      if (!after || after.watchRevision !== revision) return false
      const completed = completeDelivery(after.state, delivery.deliveryId)
      // The delivery must have left the queue, or this loop would never end.
      if (completed === after.state) return false
      // Step 3 is not acknowledged unless it is on disk. If it cannot be written the delivery stays prepared, nothing newer is
      // admitted behind it, and the next replay finds the sink already holds it and tries again.
      try {
        this.saveStrict(threadId, { ...after, state: completed })
      } catch (error) {
        if (this.current(threadId, revision)) this.readFailed(threadId, error)
        return false
      }
    }
  }

  // Failures and ends --------------------------------------------------------------------------------------------

  private readFailed(threadId: string, error: unknown): void {
    const entry = this.entries.get(threadId)
    if (!entry) return
    const now = this.clock()
    const kind = error instanceof PullRequestReadError ? error.kind : 'error'
    if (kind === 'rate-limited') {
      // Waiting it out is not a failure; every watch on the host waits.
      const until = now + RATE_LIMIT_PAUSE_MS
      this.hostPaused.set(entry.pr.host.toLowerCase(), until)
      for (const [id, other] of this.entries) {
        if (other.mode !== 'off' && !other.ended && other.pr.host.toLowerCase() === entry.pr.host.toLowerCase()) {
          this.save(id, { ...other, pausedUntil: new Date(until).toISOString(), nextAt: new Date(until).toISOString() })
        }
      }
      return
    }
    const state: WatchState = { ...entry.state }
    if (kind === 'not-found') state.notFound += 1
    else state.readFailures += 1
    if (kind === 'not-found' && state.notFound >= NOT_FOUND_LIMIT) {
      this.save(threadId, { ...entry, state })
      this.end(threadId, 'not_found')
      return
    }
    if (kind !== 'not-found' && state.readFailures >= READ_FAILURE_LIMIT) {
      this.save(threadId, { ...entry, state })
      this.end(threadId, kind === 'unauthenticated' || kind === 'not-github' || kind === 'gh-missing' ? 'signed_out' : 'read_failures')
      return
    }
    const signedOut = kind === 'unauthenticated' || kind === 'not-github' || kind === 'gh-missing'
    // A sign-out waits longer each time, up to half an hour; any other failure doubles the interval up to the cap.
    const intervalMs = signedOut ? Math.min(Math.max(entry.intervalMs * 2, RATE_LIMIT_PAUSE_MS), SIGNED_OUT_PAUSE_MAX_MS) : Math.min(entry.intervalMs * 2, this.maxInterval)
    const until = new Date(now + intervalMs).toISOString()
    this.save(threadId, { ...entry, state, intervalMs, nextAt: until, pausedUntil: signedOut ? until : null })
  }

  /** Ends the watch: nothing more is read, the link says it is off, and the thread gets a line that names why. */
  private end(threadId: string, reason: PullRequestWatchEnd): void {
    const entry = this.entries.get(threadId) ?? this.load(threadId)
    if (!entry) return
    const now = new Date(this.clock()).toISOString()
    this.save(threadId, { ...entry, ended: { reason, at: now }, state: dropPendingDeliveries(entry.state), watchRevision: entry.watchRevision + 1 })
    if (reason !== 'unlinked') this.writeLinkWatch(threadId, 'off')
    if (reason === 'trashed') return
    const line = watchEndedLine(reason, entry.pr.number)
    void this.deps.notify(threadId, line, `msg:pr-watch-ended:${threadId}:${entry.watchRevision}`).catch(() => undefined)
    this.emit('updated', { threadId, number: entry.pr.number, changes: [`ended:${reason}`] })
  }

  /** Why this watch may not deliver now, or null. `off` means it was turned off and is only to be skipped. */
  private ineligible(threadId: string, entry: Sidecar): PullRequestWatchEnd | 'off' | null {
    const thread = this.deps.threads.getThread(threadId)
    if (!thread || !this.deps.isAvailable(threadId)) return 'trashed'
    if (thread.settledAt) return 'settled'
    const link = thread.pullRequest
    if (!link || !sameLinkedPullRequest(link, entry.pr)) return 'unlinked'
    if (!link.watch || link.watch === 'off' || entry.mode === 'off') return 'off'
    // Any Stop that reached the thread, whichever entry point, raised its generation.
    if (this.stopGeneration(threadId) !== entry.stopGeneration) return 'stopped'
    return null
  }

  /** The entry is still the one a read began with and the thread may still receive. */
  private current(threadId: string, revision: number): boolean {
    const entry = this.entries.get(threadId)
    if (!entry || entry.watchRevision !== revision || entry.ended || entry.mode === 'off') return false
    const reason = this.ineligible(threadId, entry)
    if (reason === null) return true
    if (reason !== 'off') this.end(threadId, reason)
    return false
  }

  private stopGeneration(threadId: string): number {
    const store = this.deps.runStore()
    return store ? currentStopGeneration(store, threadId) : 0
  }

  /** Whether the thread's link says it is watched; cheap, so every run end and Stop can ask. */
  private isWatched(threadId: string): boolean {
    const watch = this.deps.threads.getThread(threadId)?.pullRequest?.watch
    return Boolean(watch && watch !== 'off')
  }

  private activeCount(): number {
    let count = 0
    for (const thread of this.deps.threads.listAllThreads()) {
      const watch = thread.pullRequest?.watch
      if (watch && watch !== 'off') count++
    }
    return count
  }

  // Storage ------------------------------------------------------------------------------------------------------

  /** The sidecar of a thread that is watched by its link: made new when it is missing, unreadable, or for another pull request. */
  private entryFor(threadId: string, link: ThreadPullRequestLink): Sidecar | undefined {
    const existing = this.load(threadId)
    if (existing && sameLinkedPullRequest(existing.pr, link)) return existing
    const now = this.clock()
    const fresh: Sidecar = {
      version: 1,
      mode: 'notify',
      pr: { host: link.host, nameWithOwner: link.nameWithOwner, number: link.number },
      watchRevision: (existing?.watchRevision ?? Math.floor(now / 1000)) + 1,
      stopGeneration: this.stopGeneration(threadId),
      state: initialWatchState(now),
      nextAt: new Date(now).toISOString(),
      intervalMs: this.minInterval,
      pausedUntil: null,
      ended: null
    }
    this.save(threadId, fresh)
    return fresh
  }

  private path(threadId: string): string | null {
    try {
      return join(this.deps.threads.getThreadDir(threadId), WATCH_SIDECAR_FILE)
    } catch {
      return null
    }
  }

  private load(threadId: string): Sidecar | undefined {
    const cached = this.entries.get(threadId)
    if (cached) return cached
    const file = this.path(threadId)
    if (!file || !existsSync(file)) return undefined
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Sidecar
      if (value?.version !== 1 || !value.state || !value.pr) return undefined
      const current = notifyOnly(value)
      this.entries.set(threadId, current)
      return current
    } catch {
      return undefined
    }
  }

  /**
   * Writes the state, and only then makes it the state in memory: a write that fails throws and leaves the previous state.
   * Used wherever a failed write would break the handoff (before a delivery, after it, and when the person changes the watch).
   */
  private saveStrict(threadId: string, entry: Sidecar): void {
    const file = this.path(threadId)
    if (!file) throw new Error('The thread folder is not available to save the watch.')
    atomicWriteJsonSync(file, entry)
    this.entries.set(threadId, entry)
  }

  /** `saveStrict` for a change a person asked for: a refusal they can read when it cannot be saved. */
  private saveOrRefuse(threadId: string, entry: Sidecar): void {
    try {
      this.saveStrict(threadId, entry)
    } catch (error) {
      throw new PullRequestWatchError('watch_not_saved', `The watch could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Memory first, then the file, for what is only a schedule or a counter: a failed write is repeated by the next one. */
  private save(threadId: string, entry: Sidecar): void {
    this.entries.set(threadId, entry)
    const file = this.path(threadId)
    if (!file) return
    try {
      atomicWriteJsonSync(file, entry)
    } catch (error) {
      console.warn('pull request watch state could not be saved', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private hostIsPaused(host: string): boolean {
    return (this.hostPaused.get(host) ?? 0) > this.clock()
  }

  /** A page read shared by the threads of one tick that ask for the same position; every read spends requests from the tick's budget. */
  private async readPages(key: string, read: () => Promise<LineCommentRead>): Promise<LineCommentRead> {
    const shared = this.pageReads.get(key)
    if (shared) return shared
    const started = read().then((result) => {
      this.requestsLeft -= Math.max(1, result.pages ?? 1)
      return result
    })
    this.pageReads.set(key, started)
    try {
      return await started
    } catch (error) {
      this.pageReads.delete(key)
      throw error
    }
  }

  private writeLinkWatch(threadId: string, watch: PullRequestWatchMode): void {
    try {
      const link = this.deps.threads.getThread(threadId)?.pullRequest
      if (!link || link.watch === watch) return
      this.deps.threads.updateThreadMeta(threadId, { pullRequest: { ...link, watch } }, { touch: false })
    } catch {
      // The thread is being removed; nothing to show.
    }
  }
}

/**
 * A sidecar as a watch that only notifies keeps it. One an earlier version wrote for a watch that woke the agent reads as
 * Notify, and the wakes it had prepared are dropped. The remarks in them were not remembered yet, so the next read
 * reports them as a notice; a check result in them was already recorded as seen, so it is not reported again.
 */
function notifyOnly(entry: Sidecar): Sidecar {
  const legacy = entry as Omit<Sidecar, 'mode'> & { mode: string }
  if (legacy.mode !== 'act' && !entry.state.pending.some((delivery) => (delivery as { mode?: string }).mode === 'act')) return entry
  const pending = entry.state.pending.filter((delivery) => (delivery as { mode?: string }).mode !== 'act')
  return { ...entry, mode: legacy.mode === 'act' ? 'notify' : entry.mode, state: { ...entry.state, pending } }
}
