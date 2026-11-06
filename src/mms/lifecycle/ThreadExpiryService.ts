import type { Thread } from '../../shared/types'

/**
 * Deletes threads whose expiry passed (`Thread.expiresAt`, issue #672), for good: the thread, its
 * subagents, worktree, checkpoints and attachments. Never to Settled, never to Recently deleted.
 *
 * - The time is absolute, so a pass at start deletes what expired while the daemon was not running.
 * - A thread with a run in progress waits for the run to end, unless it was set to stop it
 *   (`expiryStopsRun`). Questions and approvals waiting for an answer and open terminals are not a run: they end
 *   at expiry, so a run that waits on one ends too.
 * - Deleting can be refused for a while (other work running in the profile); the thread is tried again
 *   when a run ends and every minute, and in the meantime no turn starts in it (the orchestrator refuses).
 * - A delete that a crash cut short (trashed but not yet purged) is finished by the next pass.
 */
export interface ThreadExpiryDeps {
  listThreads(): readonly Thread[]
  /** Threads already in the trash or half purged whose expiry passed: a delete that did not finish. */
  unfinished(now: number): readonly string[]
  /** An active turn or run in the thread or any thread it owns. */
  runInProgress(threadId: string): boolean
  /** Stops every run in the thread and the threads it owns, and clears their queues. */
  stop(threadId: string): Promise<void>
  /** Ends what is not a run but would keep the thread from being deleted: pending questions, open terminals. */
  quiesce(threadId: string): Promise<void> | void
  /** Trash, then purge with the expiry's authority. Resumes a delete already under way. */
  deleteForGood(threadId: string): Promise<void>
  /** Called whenever a run ends; returns the unsubscribe. */
  onRunEnd(listener: (threadId: string) => void): () => void
  now?(): number
  log?(message: string, details: Record<string, unknown>): void
  timers?: {
    setTimeout(run: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
}

/** The longest a timer sleeps, so a clock change is noticed within this time. */
const MAX_SLEEP_MS = 60 * 60 * 1000
/** How soon an expired thread that could not be deleted yet is tried again. */
const RETRY_MS = 60 * 1000

export class ThreadExpiryService {
  private timer: unknown
  private running: Promise<void> | null = null
  private again = false
  private stopped = true
  private offRunEnd?: () => void
  /** Expired threads not deleted yet (waiting for a run, or refused for now). */
  private readonly waiting = new Set<string>()
  /** Threads whose last failure was logged, so a delete refused every minute is logged once. */
  private readonly reported = new Set<string>()

  constructor(private readonly deps: ThreadExpiryDeps) {}

  private get timers() {
    return this.deps.timers ?? { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Runs a pass now, then keeps the timer armed for the next expiry. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.offRunEnd = this.deps.onRunEnd((threadId) => {
      if (this.waiting.has(threadId) || this.waitingOwnerOf(threadId)) void this.pass()
    })
    void this.pass()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.offRunEnd?.()
    this.offRunEnd = undefined
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.timer = undefined
    await this.running?.catch(() => undefined)
  }

  /** An expiry was set, changed or removed: the timer follows the nearest one. */
  reschedule(): void {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    // An expiry that is already due (or a removed one) is handled by a pass now.
    const due = this.dueThreads(this.now())
    if (due.length) void this.pass()
    else this.arm()
  }

  /** Whether a subagent's run that ended belongs to a thread waiting to expire. */
  private waitingOwnerOf(threadId: string): boolean {
    const thread = this.deps.listThreads().find((entry) => entry.id === threadId)
    return Boolean(thread?.lineage && this.waiting.has(thread.lineage.rootThreadId))
  }

  /** Root threads (subagents follow their root) whose expiry passed. */
  private dueThreads(now: number): Thread[] {
    return this.deps.listThreads().filter((thread) => !thread.lineage && thread.expiresAt && Date.parse(thread.expiresAt) <= now)
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    const now = this.now()
    let next = now + MAX_SLEEP_MS
    for (const thread of this.deps.listThreads()) {
      if (thread.lineage || !thread.expiresAt) continue
      const at = Date.parse(thread.expiresAt)
      // One already due is waiting (a run, or a refusal) and is tried again on the retry below.
      if (Number.isFinite(at) && at > now && at < next) next = at
    }
    if (this.waiting.size) next = Math.min(next, now + RETRY_MS)
    const delay = Math.min(Math.max(next - now, 1000), MAX_SLEEP_MS)
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.pass()
    }, delay)
  }

  /**
   * One pass over every expired thread. A request while a pass runs makes it go round once more, and the
   * promise returned settles once no more passes are owed and the timer is armed again.
   */
  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      try {
        do {
          this.again = false
          await this.sweep()
        } while (this.again && !this.stopped)
      } finally {
        this.running = null
        this.arm()
      }
    })()
    this.running = run
    return run
  }

  private async sweep(): Promise<void> {
    const now = this.now()
    const due = this.dueThreads(now)
    const ids = new Set(due.map((thread) => thread.id))
    for (const id of this.deps.unfinished(now)) ids.add(id)
    // A thread no longer due (extended, removed, already gone) stops waiting.
    for (const id of [...this.waiting]) if (!ids.has(id)) this.waiting.delete(id)
    for (const id of ids) {
      if (this.stopped) return
      await this.expire(id, due.find((thread) => thread.id === id))
    }
  }

  private async expire(threadId: string, thread: Thread | undefined): Promise<void> {
    try {
      // Questions, approvals and terminals end at expiry, before anything waits: a run that waits for an answer
      // would otherwise keep the thread forever. Refused, that run ends, and the thread goes with it.
      if (thread) await this.deps.quiesce(threadId)
      // A listed thread may still be running; one in the trash has nothing running.
      if (thread && this.deps.runInProgress(threadId)) {
        if (!thread.expiryStopsRun) {
          this.waiting.add(threadId)
          return
        }
        await this.deps.stop(threadId)
        await this.deps.quiesce(threadId)
      }
      await this.deps.deleteForGood(threadId)
      this.waiting.delete(threadId)
      this.reported.delete(threadId)
    } catch (error) {
      this.waiting.add(threadId)
      if (!this.reported.has(threadId)) {
        this.reported.add(threadId)
        this.deps.log?.('an expired thread could not be deleted yet; it is tried again', { threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
