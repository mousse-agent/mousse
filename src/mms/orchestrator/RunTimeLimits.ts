import type { RunTimeLimitRecords } from '../run/runTimeLimits'
import { TERMINAL_RUN_STATUSES, type RunRecord } from '../run/types'

/**
 * The running-time limit of a run on the computer that runs it (issue #685). An agent on another computer that starts a
 * subagent here with `maxMinutes` gives its run a limit (`run_time_limits`). Every tick adds the time since the last
 * one while the run is starting, running or finalizing and nothing in its thread or the subagents below it waits on a
 * person; time queued, paused for a usage limit or waiting for an answer does not count. The run is stopped once it
 * used its limit, with a message that says so.
 *
 * What was used is kept on each tick, so a restart loses at most one tick. A tick counts at most two tick lengths, so a
 * computer that slept or a clock that jumped adds nothing it did not run.
 */
export interface RunTimeLimitsDeps {
  records: RunTimeLimitRecords
  getRun(runId: string): RunRecord | null
  /** Whether something in the thread, or a subagent below it, waits on a person: a question or an approval. */
  waitingOnPerson(threadId: string): boolean
  /** Stops the run (and what it started) and records why. */
  stop(threadId: string, runId: string, message: string): Promise<void>
  /** How often the runs are read (default 15 s). */
  tickMs?: number
  now?: () => number
  log?(message: string, details: Record<string, unknown>): void
}

const COUNTED: ReadonlySet<string> = new Set(['starting', 'running', 'finalizing'])

/** The message a run stopped at its limit ends with. */
export function runTimeLimitMessage(limitMs: number): string {
  const minutes = Math.round(limitMs / 60_000)
  return `Stopped after its limit of ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} of running time.`
}

export class RunTimeLimits {
  private timer: ReturnType<typeof setTimeout> | undefined
  private passing: Promise<void> | undefined
  private closed = true
  /** When each run was last read, by run id; a run read for the first time counts from then. */
  private readonly lastAt = new Map<string, number>()
  /** Runs a stop was asked for, so a slow stop is not asked again on every tick. */
  private readonly stopping = new Set<string>()

  constructor(private readonly deps: RunTimeLimitsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get tickMs(): number {
    return this.deps.tickMs ?? 15_000
  }

  start(): void {
    this.closed = false
    this.schedule()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Gives `runId` a limit of `minutes` of running time. A retry of the same send keeps what the run used. */
  set(runId: string, threadId: string, minutes: number): void {
    this.deps.records.set(runId, threadId, minutes * 60_000)
    this.schedule()
  }

  private schedule(): void {
    if (this.closed || this.timer || this.passing) return
    if (!this.deps.records.has()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.passing = this.pass().finally(() => {
        this.passing = undefined
        this.schedule()
      })
    }, this.tickMs)
    this.timer.unref?.()
  }

  /** One tick over every run with a limit. Never throws. */
  async pass(): Promise<void> {
    const now = this.now()
    for (const limit of this.deps.records.list()) {
      try {
        const run = this.deps.getRun(limit.runId)
        if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
          this.deps.records.remove(limit.runId)
          this.lastAt.delete(limit.runId)
          this.stopping.delete(limit.runId)
          continue
        }
        const last = this.lastAt.get(limit.runId)
        this.lastAt.set(limit.runId, now)
        let used = limit.usedMs
        if (last !== undefined && COUNTED.has(run.status) && !this.deps.waitingOnPerson(limit.threadId)) {
          used += Math.min(Math.max(0, now - last), 2 * this.tickMs)
          this.deps.records.setUsed(limit.runId, used)
        }
        if (used >= limit.limitMs && !this.stopping.has(limit.runId)) {
          this.stopping.add(limit.runId)
          await this.deps.stop(limit.threadId, limit.runId, runTimeLimitMessage(limit.limitMs))
        }
      } catch (error) {
        this.stopping.delete(limit.runId)
        this.deps.log?.('a run at its running-time limit could not be stopped yet; it is tried again', { runId: limit.runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
