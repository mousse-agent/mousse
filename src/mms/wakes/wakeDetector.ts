import type { BotWakeEvent, BotWakeFired } from '../../shared/bots/personal/wakes'
import { PR_WAKE_READ_MS, pullRequestWakeHappened, threadWakeOutcome, type WakePullRequestState, type WakeThreadState } from '../bots/wakeSources'

/**
 * The poll behind every wake that waits on an event, a thread agent's (`ThreadWakes`, kept in a JSON file and delivered
 * to the thread's inbox) and a personal bot's (`BotEngine`, kept in `bot_reminders` and delivered as a chat turn or a
 * work's continuation through `workWaiting`). Each keeps its own store and says a fired wake its own way; this is the
 * part they share:
 *
 * - a wake on a thread, or on an event of the store's own kind, is looked at the moment `check` is called, and never
 *   waits behind a pull request still being read. A wake on a thread waits for the run that worked when it was set
 *   (`runId`): a check made by a run's end (`ended`) fires it with that run's outcome, though the thread still shows the
 *   run live or its next run has already started, and the end of any other run of the thread (a queued message taken
 *   back) leaves it waiting. A wake set just after its run ended fires at the next check, as the run is looked up;
 * - wakes on a pull request are read one after the other, each at most every `PR_WAKE_READ_MS` (timed by this
 *   computer's clock when its read started, whatever time the caller passed), and never twice at once, however checks
 *   overlap. Before each read the wake must still wait. What the read shows counts when the host's own time for it (the
 *   merge, the close, the last check to finish, the review) is at or before the wake's deadline, even if the read came
 *   later. A read that gives no such time counts when the read started by the deadline. A wake gives up (`expire`) only
 *   after a read shows what it waits for came after the deadline, or a read started from the deadline on shows nothing
 *   (or fails: it then gives up saying it couldn't look). A store's deadline hands a wake on a pull request to
 *   `atDeadline`, which reads it once more now, so a merge between the last read and the deadline still counts. A read
 *   that doesn't answer in `PR_WAKE_READ_TIMEOUT_MS` counts as failed and frees the wakes queued behind it;
 * - a wake is fired through its store's `fire`, which fires only one still waiting: a Stop or a cancel that lands while
 *   its pull request is read wins, and nothing resumes. A store that fails to fire one is logged, and the rest still go;
 * - after `close` nothing new starts: no check, and no read still queued.
 *
 * When a check runs stays with each store: thread wakes on their own timer, bots' on the bots' scheduler tick.
 */

/** A wake waiting on an event, as its store keeps it. */
export interface WaitingWake {
  id: string
  event: BotWakeEvent | null
  /** When it was set: the cutoff of an older review wake with no cursor from GitHub. */
  setAt: string
  /** When it gives up waiting (ISO). */
  dueAt: string
}

/** A read of a pull request that hasn't answered by then counts as failed: its wake, and those queued behind it, go on. */
export const PR_WAKE_READ_TIMEOUT_MS = 90_000

/** A check made because a thread's run ended: that run's outcome, as its terminal event gave it. */
export interface WakeCheckOnly {
  threadId: string
  ended?: { status: string; endedAt?: string; runId?: string }
}

export interface WakeDetectorDeps<W extends WaitingWake> {
  /** The wakes waiting on an event now (those whose time passed are the store's own). */
  waiting(): readonly W[]
  /**
   * How thread `threadId` stands for the one who set `wake`, for a wake waiting on run `runId`'s end (`wakeThreadState`);
   * undefined when it can't be read here.
   */
  threadState(wake: W, threadId: string, runId?: string): WakeThreadState | undefined
  /** A pull request of the person's projects; undefined when none can be read here. */
  pullRequestState(wake: W, repo: string, number: number): Promise<WakePullRequestState | { none: true } | { problem: string }> | undefined
  /** An event of the store's own kind (a bot's background command); undefined while it is still to come. */
  otherEvent?(wake: W): BotWakeFired | undefined
  /**
   * The wake's pull request was read after its deadline and shows nothing that happened by then (`expired`), or couldn't
   * be read then (`expired_unread`): the store ends it its own way (true when it did).
   */
  expire(wake: W, now: number, why: Extract<BotWakeFired, { kind: 'ended' }>): boolean
  /** Fires the wake if it still waits; false when it no longer did (cancelled, stopped, fired). */
  fire(wake: W, fired: BotWakeFired, now: number): boolean
  now(): number
}

export class WakeDetector<W extends WaitingWake> {
  /** When each wake on a pull request last started reading it, by `deps.now`. */
  private readonly readAt = new Map<string, number>()
  /** Wakes whose pull request read is queued or under way, each with the batch that holds it: a batch frees only its own. */
  private readonly reading = new Map<string, object>()
  /** Wakes given up after a read past their deadline: their store ends them now, with no read again. */
  private readonly expired = new Set<string>()
  private closed = false

  constructor(private readonly deps: WakeDetectorDeps<W>) {}

  /** The wake no longer waits: its pull request's read time goes. */
  forget(id: string): void {
    this.readAt.delete(id)
    this.expired.delete(id)
  }

  /**
   * A store's deadline came for `wake`. A wake on a pull request is the detector's to end: true while its last read is
   * queued or under way (started now when none is), which fires it if what it waits for happened by the deadline, or
   * else gives it up (`expire`). False when the store ends it itself: not a wake on a pull request, one the detector has
   * given up already, or the detector is closed.
   */
  atDeadline(wake: W): boolean {
    if (this.closed || wake.event?.kind !== 'pr' || this.expired.has(wake.id)) return false
    if (this.reading.has(wake.id)) return true
    const batch = {}
    this.reading.set(wake.id, batch)
    void this.read([wake as W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }], batch)
    return true
  }

  /** Nothing new starts: later checks do nothing, and reads still queued are not made. */
  close(): void {
    this.closed = true
  }

  /**
   * Looks at every waiting wake on an event (or, with `only`, those waiting on that thread) and fires those whose event
   * happened or can no longer happen. Wakes on a thread are looked at before this returns; the promise settles once the
   * pull requests due a read were read. True when one fired. `now`: when a wake on a thread or the store's own event
   * fired (the scheduler's tick); pull request reads are timed by `deps.now` as each starts.
   */
  check(only?: WakeCheckOnly, now?: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const at = now ?? this.deps.now()
    let waiting: readonly W[]
    try {
      waiting = this.deps.waiting()
    } catch (error) {
      warn('wake-ups could not be checked; the next tick tries again', undefined, error)
      return Promise.resolve(false)
    }
    const ids = new Set(waiting.map((wake) => wake.id))
    for (const id of this.readAt.keys()) if (!ids.has(id) && !this.reading.has(id)) this.readAt.delete(id)
    for (const id of this.expired) if (!ids.has(id)) this.expired.delete(id)
    let fired = false
    const batch = {}
    const reads: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }> = []
    for (const wake of waiting) {
      const event = wake.event
      if (!event || (only && (event.kind !== 'thread' || event.threadId !== only.threadId))) continue
      if (event.kind === 'pr') {
        if (!this.reading.has(wake.id) && !this.expired.has(wake.id) && this.deps.now() - (this.readAt.get(wake.id) ?? Number.NEGATIVE_INFINITY) >= PR_WAKE_READ_MS) {
          this.reading.set(wake.id, batch)
          reads.push(wake as W & { event: typeof event })
        }
        continue
      }
      let happened: BotWakeFired | undefined
      try {
        happened = event.kind === 'thread' ? threadWakeOutcome(event, this.threadSeen(wake, event, only?.ended)) : this.deps.otherEvent?.(wake)
      } catch (error) {
        warn('a wake-up could not check its event; the next tick tries again', wake.id, error)
      }
      if (happened && this.fire(wake, happened, at)) fired = true
    }
    if (!reads.length) return Promise.resolve(fired)
    return this.read(reads, batch).then((read) => fired || read)
  }

  /**
   * How a wake sees its thread. Called for the run that just `ended`, when it is the one the wake waits for: that run is
   * over, though the thread still shows it live (its end is told before its turn lets go) or its next run has already
   * started. The end of another run of the thread leaves the wake to how its own run stands.
   */
  private threadSeen(wake: W, event: Extract<BotWakeEvent, { kind: 'thread' }>, ended: WakeCheckOnly['ended']): WakeThreadState | undefined {
    const seen = this.deps.threadState(wake, event.threadId, event.runId)
    if (ended && event.runId && ended.runId && ended.runId !== event.runId) return seen
    if (!ended || !seen || (seen.state !== 'running' && seen.state !== 'idle')) return seen
    return { state: 'idle', ...(seen.title ? { title: seen.title } : {}), lastRun: { status: ended.status, ...(ended.endedAt ? { endedAt: ended.endedAt } : {}) } }
  }

  /**
   * Reads each wake's pull request in turn, as of the moment its turn comes, and frees each reservation the batch holds.
   * A wake whose read started before its deadline, answered after it and shows nothing is read once more.
   */
  private async read(wakes: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }>, batch: object): Promise<boolean> {
    const release = (id: string) => { if (this.reading.get(id) === batch) this.reading.delete(id) }
    let fired = false
    try {
      for (const wake of wakes) {
        if (this.closed) break
        try {
          const deadline = Date.parse(wake.dueAt)
          for (let attempt = 0; attempt < 2; attempt++) {
            // A wake cancelled, stopped or fired while an earlier one was read is not read.
            if (this.closed || !this.stillWaiting(wake.id)) break
            const startedAt = this.deps.now()
            this.readAt.set(wake.id, startedAt)
            const state = await this.readPullRequest(wake)
            const happened = pullRequestWakeHappened(wake.event, state, wake.setAt)
            // By the host's time for what happened; with none, by when the read started.
            if (happened && !((happened.at ?? startedAt) > deadline)) {
              if (this.fire(wake, happened.fired, this.deps.now())) fired = true
              break
            }
            if (!(this.deps.now() >= deadline) || this.closed || !this.stillWaiting(wake.id)) break
            // What it waits for came after the deadline, or a read from the deadline on shows nothing: it gives up.
            if (happened || startedAt >= deadline) {
              this.expired.add(wake.id)
              const unread = !state || 'problem' in state || 'none' in state
              this.deps.expire(wake, this.deps.now(), { kind: 'ended', reason: unread ? 'expired_unread' : 'expired' })
              break
            }
          }
        } catch (error) {
          warn('a wake-up could not check its event; the next tick tries again', wake.id, error)
        } finally {
          release(wake.id)
        }
      }
    } finally {
      for (const wake of wakes) release(wake.id)
    }
    return fired
  }

  /** The wake's pull request; a read that throws, or doesn't answer in `PR_WAKE_READ_TIMEOUT_MS`, is a problem. */
  private async readPullRequest(wake: W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }): Promise<WakePullRequestState | { none: true } | { problem: string } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ problem: string }>((resolve) => {
      timer = setTimeout(() => resolve({ problem: 'the read took too long' }), PR_WAKE_READ_TIMEOUT_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.deps.pullRequestState(wake, wake.event.repo, wake.event.number))
          .catch((error: unknown) => ({ problem: error instanceof Error ? error.message : String(error) })),
        timeout
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private stillWaiting(id: string): boolean {
    return this.deps.waiting().some((wake) => wake.id === id)
  }

  /** The store fires the wake if it still waits; one that throws is logged and the others still go. */
  private fire(wake: W, fired: BotWakeFired, now: number): boolean {
    if (this.closed) return false
    try {
      if (!this.deps.fire(wake, fired, now)) return false
    } catch (error) {
      warn('a wake-up could not be fired; the next tick tries again', wake.id, error)
      return false
    }
    this.readAt.delete(wake.id)
    return true
  }
}

function warn(message: string, wakeId: string | undefined, error: unknown): void {
  console.warn(message, { ...(wakeId ? { wakeId } : {}), error: error instanceof Error ? error.message : String(error) })
}
