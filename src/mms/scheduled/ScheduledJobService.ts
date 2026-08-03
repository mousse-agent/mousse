import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { SchedulerStatus, ScheduledJob } from '../../shared/types'
import { getScheduledTickLockPath } from '../data/paths'
import { isSilentOutput } from './computeNextRun'
import { FileLockBusyError, tryAcquireTickLock } from './fileLock'
import {
  ScheduledJobStore,
  TICKER_INTERVAL_MS,
  recordTickerHeartbeat,
  readTickerHeartbeat
} from './ScheduledJobStore'

export interface ScheduledJobRunner {
  runIsolated(prompt: string): Promise<{ text: string; silent: boolean; error?: string }>
}

export class ScheduledJobService extends EventEmitter {
  private ticker: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private runningJobIds = new Set<string>()
  private lastTickError: string | null = null
  private lastHeartbeatAt: string | null = null
  private lastSuccessAt: string | null = null
  private tickInProgress = false
  /** When true, future ticks are no-ops (stop does not wait for in-flight LLM). */
  private stopped = true
  /** Release fn for the tick lock held by the current tick, if any. */
  private releaseTickLock: (() => void) | null = null
  /** Last successfully observed job counts (survive peer lock contention on status). */
  private lastJobCount = 0
  private lastDueCount = 0

  constructor(
    private runner: ScheduledJobRunner,
    private store: ScheduledJobStore,
    private threadStore?: ThreadDataStore,
    private projectManager?: ProjectManager
  ) {
    super()
  }

  start(): void {
    if (this.ticker) return
    this.stopped = false
    // Crash recovery: dead running owners → interrupted before first tick claims.
    try {
      this.store.reconcileStaleRunningJobs()
    } catch {
      /* best-effort; tick will retry under lock */
    }
    void this.tick()
    this.ticker = setInterval(() => {
      void this.tick()
    }, TICKER_INTERVAL_MS)
    this.watchdog = setInterval(() => this.watchdogCheck(), TICKER_INTERVAL_MS)
  }

  /**
   * Stop scheduling future ticks. Does not resume in-flight external LLM calls;
   * the current tick releases the tick lock in its finally. Jobs interrupted by
   * process death are reconciled on next start.
   */
  stop(): void {
    this.stopped = true
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    if (!this.tickInProgress && this.releaseTickLock) {
      try {
        this.releaseTickLock()
      } catch {
        /* ignore */
      }
      this.releaseTickLock = null
    }
  }

  listJobs(): ScheduledJob[] {
    return this.store.listJobs()
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.store.getJob(id)
  }

  createJob(input: Parameters<ScheduledJobStore['createJob']>[0]): ScheduledJob {
    const job = this.store.createJob(input)
    this.emitUpdated()
    return job
  }

  updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
    const job = this.store.updateJob(id, patch)
    if (job) this.emitUpdated()
    return job
  }

  deleteJob(id: string): boolean {
    const deleted = this.store.deleteJob(id)
    if (deleted) this.emitUpdated()
    return deleted
  }

  pauseJob(id: string, reason?: string): ScheduledJob | null {
    const job = this.store.pauseJob(id, reason)
    if (job) this.emitUpdated()
    return job
  }

  resumeJob(id: string): ScheduledJob | null {
    const job = this.store.resumeJob(id)
    if (job) this.emitUpdated()
    return job
  }

  triggerJob(id: string): ScheduledJob | null {
    const job = this.store.triggerJob(id)
    if (job) this.emitUpdated()
    return job
  }

  /**
   * Status snapshot. Peer lock contention does not throw — preserves last known
   * counts and records lock-busy in lastTickError when needed.
   */
  getStatus(): SchedulerStatus {
    const persisted = readTickerHeartbeat()
    const activeJobId =
      this.runningJobIds.size > 0 ? [...this.runningJobIds][0] : null

    try {
      const jobs = this.store.listJobs()
      this.lastJobCount = jobs.length
      this.lastDueCount = this.store.getDueCount()
      return {
        running: this.ticker !== null && !this.stopped,
        lastHeartbeatAt: this.lastHeartbeatAt ?? persisted.heartbeatAt,
        lastSuccessAt: this.lastSuccessAt ?? persisted.successAt,
        lastTickError: this.lastTickError,
        activeJobId,
        jobCount: this.lastJobCount,
        dueCount: this.lastDueCount
      }
    } catch (err) {
      if (err instanceof FileLockBusyError) {
        if (!this.lastTickError) {
          this.lastTickError = `Scheduler status lock busy: ${err.message}`
        }
        return {
          running: this.ticker !== null && !this.stopped,
          lastHeartbeatAt: this.lastHeartbeatAt ?? persisted.heartbeatAt,
          lastSuccessAt: this.lastSuccessAt ?? persisted.successAt,
          lastTickError: this.lastTickError,
          activeJobId,
          jobCount: this.lastJobCount,
          dueCount: this.lastDueCount
        }
      }
      throw err
    }
  }

  private emitUpdated(): void {
    try {
      this.emit('updated', this.store.listJobs())
    } catch (err) {
      if (err instanceof FileLockBusyError) {
        this.lastTickError = `Scheduler update lock busy: ${err.message}`
      } else {
        throw err
      }
    }
    try {
      this.emit('status', this.getStatus())
    } catch {
      // getStatus is fail-soft for lock busy; never reject tick finally.
    }
  }

  private watchdogCheck(): void {
    if (this.stopped || !this.ticker) return

    try {
      const status = this.getStatus()
      const heartbeatAt = status.lastHeartbeatAt
      if (!heartbeatAt) return

      const ageMs = Date.now() - new Date(heartbeatAt).getTime()
      if (ageMs > TICKER_INTERVAL_MS * 2 + 5000) {
        this.lastTickError = `Scheduler heartbeat stale (${Math.round(ageMs / 1000)}s)`
        this.emit('status', this.getStatus())
        if (!this.tickInProgress) {
          void this.tick()
        }
      }
    } catch {
      /* never crash the watchdog */
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) return

    const releaseTickLock = tryAcquireTickLock(getScheduledTickLockPath())
    if (!releaseTickLock) return

    this.releaseTickLock = releaseTickLock
    this.tickInProgress = true
    try {
      if (this.stopped) return

      this.lastHeartbeatAt = new Date().toISOString()
      recordTickerHeartbeat(false)

      const dueJobs = this.store.claimDueJobs()
      for (const job of dueJobs) {
        if (this.stopped) break
        await this.executeJob(job)
      }

      this.lastSuccessAt = new Date().toISOString()
      this.lastTickError = null
      recordTickerHeartbeat(true)
    } catch (err) {
      this.lastTickError = err instanceof Error ? err.message : String(err)
    } finally {
      this.tickInProgress = false
      try {
        releaseTickLock()
      } catch {
        /* ignore */
      }
      if (this.releaseTickLock === releaseTickLock) {
        this.releaseTickLock = null
      }
      try {
        this.emit('status', this.getStatus())
      } catch {
        /* never reject the tick promise from status emission */
      }
    }
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    if (this.runningJobIds.has(job.id)) return
    this.runningJobIds.add(job.id)
    this.emitUpdated()
    const claimToken = job.runClaim?.token

    try {
      const result = await this.runner.runIsolated(job.prompt)

      // After external work: verify claim is still current before any side effects.
      if (!claimToken || !this.store.isRunClaimCurrent(job.id, claimToken)) {
        return
      }

      const silent = result.silent || isSilentOutput(result.text)

      if (!silent && this.threadStore) {
        if (job.createThread) {
          const projectPath = job.projectId
            ? this.projectManager?.getProject(job.projectId)?.path
            : undefined
          const thread = this.threadStore.createThread(
            `Scheduled: ${job.name}`,
            job.projectId,
            projectPath
          )
          this.threadStore.mutateThreadData(thread.id, (current) => ({
            messages: [
              ...current.messages,
              {
                id: uuidv4(),
                role: 'assistant',
                content: result.text,
                timestamp: new Date().toISOString()
              }
            ]
          }))
        } else if (job.threadId) {
          this.threadStore.mutateThreadData(job.threadId, (current) => ({
            messages: [
              ...current.messages,
              {
                id: uuidv4(),
                role: 'assistant',
                content: `[Scheduled: ${job.name}]\n\n${result.text}`,
                timestamp: new Date().toISOString()
              }
            ]
          }))
        }
      }

      this.store.markJobRun(
        job.id,
        !result.error,
        result.text,
        result.error,
        silent,
        claimToken
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (claimToken && this.store.isRunClaimCurrent(job.id, claimToken)) {
        this.store.markJobRun(job.id, false, undefined, message, false, claimToken)
      }
    } finally {
      this.runningJobIds.delete(job.id)
      this.emitUpdated()
    }
  }
}
