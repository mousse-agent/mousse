import type { BotWakeEvent, BotWakeFired } from '../../shared/bots/personal/wakes'
import { PR_WAKE_READ_MS, pullRequestWakeOutcome, threadWakeOutcome, type WakePullRequestState, type WakeThreadState } from '../bots/wakeSources'

/**
 * The poll behind every wake that waits on an event, a thread agent's (`ThreadWakes`, kept in a JSON file and delivered
 * to the thread's inbox) and a personal bot's (`BotEngine`, kept in `bot_reminders` and delivered as a chat turn or a
 * work's continuation through `workWaiting`). Each keeps its own store and says a fired wake its own way; this is the
 * part they share:
 *
 * - a wake on a thread, or on an event of the store's own kind, is looked at the moment `check` is called: a check for
 *   one thread (its run just ended) sees that run's end before another run can start, and never waits behind a pull
 *   request still being read;
 * - wakes on a pull request are read one after the other, each at most every `PR_WAKE_READ_MS` (timed from when its read
 *   started), and never twice at once; before each read the wake must still wait and its time must not have run out
 *   (`expire`), as of that moment;
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
   * Whether the wake's time ran out by `now`, looked at as its pull request's turn to be read comes: the store ends it
   * its own way and it is not read. Absent: the store's own timer ends it.
   */
  expire?(wake: W, now: number): boolean
  /** Fires the wake if it still waits; false when it no longer did (cancelled, stopped, fired). */
  fire(wake: W, fired: BotWakeFired, now: number): boolean
  now(): number
}

export class WakeDetector<W extends WaitingWake> {
  /** When each wake on a pull request last started reading it. */
  private readonly readAt = new Map<string, number>()
  /** Wakes whose pull request read is queued or under way. */
  private readonly reading = new Set<string>()
  private closed = false

  constructor(private readonly deps: WakeDetectorDeps<W>) {}

  /** The wake no longer waits: its pull request's read time goes. */
  forget(id: string): void {
    this.readAt.delete(id)
  }

  /** Nothing new starts: later checks do nothing, and reads still queued are not made. */
  close(): void {
    this.closed = true
  }

  /**
   * Looks at every waiting wake on an event (or, with `only`, those waiting on that thread) and fires those whose event
   * happened or can no longer happen. Wakes on a thread are looked at before this returns; the promise settles once the
   * pull requests due a read were read. True when one fired. `now`: the time it is looked at (the scheduler's).
   */
  check(only?: { threadId: string }, now?: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const startedAt = this.deps.now()
    const base = now ?? startedAt
    // The time as of now, on the caller's clock: reads late in the queue are timed when they happen.
    const clock = () => base + Math.max(0, this.deps.now() - startedAt)
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
    const reads: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }> = []
    for (const wake of waiting) {
      const event = wake.event
      if (!event || (only && (event.kind !== 'thread' || event.threadId !== only.threadId))) continue
      if (event.kind === 'pr') {
        if (!this.reading.has(wake.id) && clock() - (this.readAt.get(wake.id) ?? Number.NEGATIVE_INFINITY) >= PR_WAKE_READ_MS) {
          this.reading.add(wake.id)
          reads.push(wake as W & { event: typeof event })
        }
        continue
      }
      let happened: BotWakeFired | undefined
      try {
        happened = event.kind === 'thread' ? threadWakeOutcome(event, this.deps.threadState(wake, event.threadId)) : this.deps.otherEvent?.(wake)
      } catch (error) {
        warn('a wake-up could not check its event; the next tick tries again', wake.id, error)
      }
      if (happened && this.fire(wake, happened, clock())) fired = true
    }
    if (!reads.length) return Promise.resolve(fired)
    return this.read(reads, clock).then((read) => fired || read)
  }

  /** Reads each wake's pull request in turn, as of the moment its turn comes. */
  private async read(wakes: Array<W & { event: Extract<BotWakeEvent, { kind: 'pr' }> }>, clock: () => number): Promise<boolean> {
    let fired = false
    try {
      for (const [index, wake] of wakes.entries()) {
        if (this.closed) {
          for (const left of wakes.slice(index)) this.reading.delete(left.id)
          break
        }
        try {
          // A wake cancelled, stopped or fired while an earlier one was read is not read; one whose time ran out ends.
          if (!this.stillWaiting(wake.id)) continue
          const at = clock()
          if (this.deps.expire?.(wake, at)) continue
          this.readAt.set(wake.id, at)
          const happened = pullRequestWakeOutcome(wake.event, await this.deps.pullRequestState(wake, wake.event.repo, wake.event.number), wake.setAt)
          if (happened && this.fire(wake, happened, clock())) fired = true
        } catch (error) {
          warn('a wake-up could not check its event; the next tick tries again', wake.id, error)
        } finally {
          this.reading.delete(wake.id)
        }
      }
    } finally {
      for (const wake of wakes) this.reading.delete(wake.id)
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
