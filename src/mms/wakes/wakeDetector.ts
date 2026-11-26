import type { BotWakeEvent, BotWakeFired } from '../../shared/bots/personal/wakes'
import { PR_WAKE_READ_MS, pullRequestWakeHappened, threadWakeOutcome, type WakePullRequestState, type WakeThreadState } from '../bots/wakeSources'

/**
 * The poll behind every wake that waits on an event, a thread agent's (`ThreadWakes`, kept in a JSON file and delivered
 * to the thread's inbox) and a personal bot's (`BotEngine`, kept in `bot_reminders` and delivered as a chat turn or a
 * work's continuation through `workWaiting`). Each keeps its own store and says a fired wake its own way; this is the
 * part they share:
 *
 * - a wake on a thread, or on an event of the store's own kind, is looked at the moment `check` is called, and never
 *   waits behind a pull request still being read. A check for one thread made by its run's end (`ended`) fires with
 *   that run's outcome, though the thread still shows the run live or its next run has already started;
 * - wakes on a pull request are read one after the other, each at most every `PR_WAKE_READ_MS` (timed by this
 *   computer's clock when its read started, whatever time the caller passed), and never twice at once, however checks
 *   overlap. Before each read the wake must still wait. What the read shows counts when the host's own time for it (the
 *   merge, the close, the last check to finish, the review) is at or before the wake's deadline, even if the read came
 *   later; after it, the wake gives up (`expire`). A read that gives no such time counts when the read started by the
 *   deadline. A store's own deadline delivery leaves a wake alone while its read is queued or under way (`isReading`);
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

/** A check made because a thread's run ended: that run's outcome, as its terminal event gave it. */
export interface WakeCheckOnly {
  threadId: string
  ended?: { status: string; endedAt?: string }
}

export interface WakeDetectorDeps<W extends WaitingWake> {
  /** The wakes waiting on an event now (those whose time passed are the store's own). */
  waiting(): readonly W[]
  /** How thread `threadId` stands for the one who set `wake`; undefined when it can't be read here. */
  threadState(wake: W, threadId: string): WakeThreadState | undefined
  /** A pull request of the person's projects; undefined when none can be read here. */
  pullRequestState(wake: W, repo: string, number: number): Promise<WakePullRequestState | { none: true } | { problem: string }> | undefined
  /** An event of the store's own kind (a bot's background command); undefined while it is still to come. */
  otherEvent?(wake: W): BotWakeFired | undefined
  /**
   * The wake's pull request was read after its deadline and shows nothing that happened by then: the store ends it its
   * own way (true when it did). Absent: the store's own timer ends it.
   */
  expire?(wake: W, now: number): boolean
  /** Fires the wake if it still waits; false when it no longer did (cancelled, stopped, fired). */
  fire(wake: W, fired: BotWakeFired, now: number): boolean
  now(): number
}

export class WakeDetector<W extends WaitingWake> {
  /** When each wake on a pull request last started reading it, by `deps.now`. */
  private readonly readAt = new Map<string, number>()
  /** Wakes whose pull request read is queued or under way, each with the batch that holds it: a batch frees only its own. */
  private readonly reading = new Map<string, object>()
  private closed = false

  constructor(private readonly deps: WakeDetectorDeps<W>) {}

  /** The wake no longer waits: its pull request's read time goes. */
  forget(id: string): void {
    this.readAt.delete(id)
  }

  /** Whether the wake's pull request read is queued or under way. */
  isReading(id: string): boolean {
    return this.reading.has(id)
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
    let fired = false
    const batch = {}
    const reads: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }> = []
    for (const wake of waiting) {
      const event = wake.event
      if (!event || (only && (event.kind !== 'thread' || event.threadId !== only.threadId))) continue
      if (event.kind === 'pr') {
        if (!this.reading.has(wake.id) && this.deps.now() - (this.readAt.get(wake.id) ?? Number.NEGATIVE_INFINITY) >= PR_WAKE_READ_MS) {
          this.reading.set(wake.id, batch)
          reads.push(wake as W & { event: typeof event })
        }
        continue
      }
      let happened: BotWakeFired | undefined
      try {
        happened = event.kind === 'thread' ? threadWakeOutcome(event, this.threadSeen(wake, event.threadId, only?.ended)) : this.deps.otherEvent?.(wake)
      } catch (error) {
        warn('a wake-up could not check its event; the next tick tries again', wake.id, error)
      }
      if (happened && this.fire(wake, happened, at)) fired = true
    }
    if (!reads.length) return Promise.resolve(fired)
    return this.read(reads, batch).then((read) => fired || read)
  }

  /**
   * How a wake sees its thread. Called for the run that just `ended`: that run is over, though the thread still shows it
   * live (its end is told before its turn lets go) or its next run has already started.
   */
  private threadSeen(wake: W, threadId: string, ended: WakeCheckOnly['ended']): WakeThreadState | undefined {
    const seen = this.deps.threadState(wake, threadId)
    if (!ended || !seen || (seen.state !== 'running' && seen.state !== 'idle')) return seen
    return { state: 'idle', ...(seen.title ? { title: seen.title } : {}), lastRun: { status: ended.status, ...(ended.endedAt ? { endedAt: ended.endedAt } : {}) } }
  }

  /** Reads each wake's pull request in turn, as of the moment its turn comes, and frees each reservation the batch holds. */
  private async read(wakes: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }>, batch: object): Promise<boolean> {
    const release = (id: string) => { if (this.reading.get(id) === batch) this.reading.delete(id) }
    let fired = false
    try {
      for (const wake of wakes) {
        if (this.closed) break
        try {
          // A wake cancelled, stopped or fired while an earlier one was read is not read.
          if (!this.stillWaiting(wake.id)) continue
          const startedAt = this.deps.now()
          this.readAt.set(wake.id, startedAt)
          const happened = pullRequestWakeHappened(wake.event, await this.deps.pullRequestState(wake, wake.event.repo, wake.event.number), wake.setAt)
          const deadline = Date.parse(wake.dueAt)
          // By the host's time for what happened; with none, by when the read started.
          if (happened && !((happened.at ?? startedAt) > deadline)) {
            if (this.fire(wake, happened.fired, this.deps.now())) fired = true
          } else if (this.deps.now() >= deadline && !this.closed && this.stillWaiting(wake.id)) {
            this.deps.expire?.(wake, this.deps.now())
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
