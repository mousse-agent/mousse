import type { BotWakeEvent, BotWakeFired } from '../../shared/bots/personal/wakes'
import { PR_WAKE_READ_MS, pullRequestWakeOutcome, threadWakeOutcome, type WakePullRequestState, type WakeThreadState } from '../bots/wakeSources'

/**
 * The poll behind every wake that waits on an event, a thread agent's (`ThreadWakes`, kept in a JSON file and delivered
 * to the thread's inbox) and a personal bot's (`BotEngine`, kept in `bot_reminders` and delivered as a chat turn or a
 * work's continuation through `workWaiting`). Each keeps its own store and says a fired wake its own way; this is the
 * part they share:
 *
 * - one pass at a time; a pass asked for while one runs follows it, and a pass for one thread (its run just ended)
 *   looks only at the wakes waiting on that thread;
 * - what a wake's thread or pull request did by now (`threadWakeOutcome`, `pullRequestWakeOutcome`), a pull request
 *   read at most every `PR_WAKE_READ_MS` per wake, its read time dropped once the wake no longer waits;
 * - a wake is fired through its store's `fire`, which fires only one still waiting: a Stop or a cancel that lands while
 *   its pull request is read wins, and nothing resumes.
 *
 * When a pass runs stays with each store: thread wakes on their own timer, bots' on the bots' scheduler tick.
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
  /** Fires the wake if it still waits; false when it no longer did (cancelled, stopped, fired). */
  fire(wake: W, fired: BotWakeFired, now: number): boolean
  now(): number
}

export class WakeDetector<W extends WaitingWake> {
  /** When each wake on a pull request last read it. */
  private readonly readAt = new Map<string, number>()
  private passing: Promise<boolean> | undefined

  constructor(private readonly deps: WakeDetectorDeps<W>) {}

  /** The wake no longer waits: its pull request's read time goes. */
  forget(id: string): void {
    this.readAt.delete(id)
  }

  /**
   * Looks at every waiting wake on an event (or, with `only`, those waiting on that thread) and fires those whose event
   * happened or can no longer happen. True when one fired. `now`: the time it is looked at (the scheduler's).
   */
  check(only?: { threadId: string }, now?: number): Promise<boolean> {
    if (this.passing) return this.passing.then(() => this.check(only, now))
    const run = this.pass(only, now ?? this.deps.now()).catch((error: unknown) => {
      console.warn('wake-ups could not be checked; the next tick tries again', { error: error instanceof Error ? error.message : String(error) })
      return false
    }).finally(() => { if (this.passing === run) this.passing = undefined })
    this.passing = run
    return run
  }

  private async pass(only: { threadId: string } | undefined, now: number): Promise<boolean> {
    const waiting = this.deps.waiting()
    const ids = new Set(waiting.map((wake) => wake.id))
    for (const id of this.readAt.keys()) if (!ids.has(id)) this.readAt.delete(id)
    let fired = false
    for (const wake of waiting) {
      const event = wake.event
      if (!event || (only && (event.kind !== 'thread' || event.threadId !== only.threadId))) continue
      let happened: BotWakeFired | undefined
      try {
        happened = await this.outcome(wake, event, now)
      } catch (error) {
        console.warn('a wake-up could not check its event; the next tick tries again', { wakeId: wake.id, error: error instanceof Error ? error.message : String(error) })
      }
      // The store fires only a wake that still waits: one cancelled or stopped while its event was read stays so.
      if (happened && this.deps.fire(wake, happened, now)) {
        this.readAt.delete(wake.id)
        fired = true
      }
    }
    return fired
  }

  private async outcome(wake: W, event: BotWakeEvent, now: number): Promise<BotWakeFired | undefined> {
    if (event.kind === 'thread') return threadWakeOutcome(event, this.deps.threadState(wake, event.threadId))
    if (event.kind !== 'pr') return this.deps.otherEvent?.(wake)
    if (now - (this.readAt.get(wake.id) ?? 0) < PR_WAKE_READ_MS) return undefined
    this.readAt.set(wake.id, now)
    return pullRequestWakeOutcome(event, await this.deps.pullRequestState(wake, event.repo, event.number), wake.setAt)
  }
}
