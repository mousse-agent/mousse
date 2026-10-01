import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { SchedulerStatus, ScheduledJob } from '../../shared/types'
import { join } from 'node:path'
import { isSilentOutput } from './computeNextRun'
import { FileLockBusyError, tryAcquireTickLock } from './fileLock'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import {
  ScheduledJobStore,
  TICKER_INTERVAL_MS,
  recordTickerHeartbeat,
  readTickerHeartbeat
} from './ScheduledJobStore'
import type { ScheduledJobIngress } from '../platform/MmsWorkflowChat'

export interface ScheduledJobRunner {
  runIsolated(
    prompt: string,
    ingress?: ScheduledJobIngress
  ): Promise<{ text: string; silent: boolean; error?: string; waiting?: boolean; transcriptWritten?: boolean }>
}

export class ScheduledJobService extends EventEmitter {
  private readonly lifecycle = new OwnedWorkBarrier()
  private shutdownPromise?: Promise<void>
  private ticker: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private runningJobIds = new Set<string>()
  /** Exact durable claims made by this service and not yet finalized. */
  private ownedRunClaims = new Map<string, string>()
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
    this.lifecycle.assertAccepting()
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

  /** Permanent profile teardown is separate from temporarily disabling scheduling. */
  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    this.stop()
  }

  getActiveCount(): number { return this.lifecycle.count }

  shutdown({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    if (this.shutdownPromise) return this.shutdownPromise
    const pending = this.lifecycle.waitForIdle(timeoutMs).then(() => {
      this.interruptOwnedRuns('Interrupted by profile shutdown before execution')
    })
    this.shutdownPromise = pending
    void pending.catch(() => { if (this.shutdownPromise === pending) this.shutdownPromise = undefined })
    return pending
  }

  listJobs(): ScheduledJob[] {
    return this.store.listJobs()
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.store.getJob(id)
  }

  createJob(input: Parameters<ScheduledJobStore['createJob']>[0]): ScheduledJob {
    this.lifecycle.assertAccepting()
    const job = this.store.createJob(input)
    this.emitUpdated()
    return job
  }

  updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.updateJob(id, patch)
    if (job) this.emitUpdated()
    return job
  }

  deleteJob(id: string): boolean {
    this.lifecycle.assertAccepting()
    const deleted = this.store.deleteJob(id)
    if (deleted) this.emitUpdated()
    return deleted
  }

  pauseJob(id: string, reason?: string): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.pauseJob(id, reason)
    if (job) this.emitUpdated()
    return job
  }

  resumeJob(id: string): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.resumeJob(id)
    if (job) this.emitUpdated()
    return job
  }

  triggerJob(id: string): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.triggerJob(id)
    if (job) this.emitUpdated()
    return job
  }

  /**
   * Status snapshot. Peer lock contention does not throw — preserves last known
   * counts and records lock-busy in lastTickError when needed.
   */
  getStatus(): SchedulerStatus {
    const persisted = readTickerHeartbeat(this.store.homeDir)
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
    if (this.stopped || this.lifecycle.stopping || this.tickInProgress) return
    try { await this.lifecycle.run('scheduled-tick', () => this.tickOwned()) }
    catch (error) { this.lastTickError = error instanceof Error ? error.message : String(error) }
  }

  private async tickOwned(): Promise<void> {
    if (this.stopped || this.tickInProgress) return

    const releaseTickLock = tryAcquireTickLock(join(this.store.homeDir, 'scheduled', '.tick.lock'))
    if (!releaseTickLock) return

    this.releaseTickLock = releaseTickLock
    this.tickInProgress = true
    try {
      if (this.stopped) return

      this.lastHeartbeatAt = new Date().toISOString()
      recordTickerHeartbeat(false, this.store.homeDir)

      const dueJobs = this.store.claimDueJobs()
      for (const job of dueJobs) {
        if (job.runClaim) this.ownedRunClaims.set(job.id, job.runClaim.token)
      }
      for (const job of dueJobs) {
        if (this.lifecycle.stopping) {
          if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted by profile shutdown before execution')
          continue
        }
        if (this.stopped) {
          if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted when scheduling stopped before execution')
          continue
        }
        await this.executeJob(job)
      }

      if (this.lifecycle.stopping) return
      this.lastSuccessAt = new Date().toISOString()
      this.lastTickError = null
      recordTickerHeartbeat(true, this.store.homeDir)
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
      const occurrenceAt = job.nextRunAt
      if (!occurrenceAt) throw new Error('Scheduled job occurrence is missing')
      const result = await this.runner.runIsolated(job.prompt, {
        jobId: job.id,
        occurrenceAt,
        threadId: job.threadId,
        projectId: job.projectId,
        createThread: job.createThread,
        jobName: job.name,
        resumeWaiting: job.runClaim?.resumedWaiting === true,
        onWorkflowPrepared: (invocationId) => {
          if (!claimToken || !this.store.markWorkflowClaim(job.id, claimToken, invocationId)) {
            throw new Error('Scheduled workflow claim was lost before admission')
          }
        }
      })

      // After external work: verify claim is still current before any side effects.
      if (!claimToken || !this.store.isRunClaimCurrent(job.id, claimToken)) {
        return
      }

      if (this.lifecycle.stopping) {
        this.interruptOwnedRun(job.id, claimToken, 'Interrupted by profile shutdown; external effects may have occurred')
        return
      }

      const silent = result.silent || isSilentOutput(result.text)
      const writeThread = !silent && !result.transcriptWritten

      if (writeThread && this.threadStore) {
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
        !result.error && !result.waiting,
        result.text,
        result.error,
        silent,
        claimToken,
        result.waiting ? 'waiting' : undefined
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (claimToken && this.store.isRunClaimCurrent(job.id, claimToken)) {
        if (this.lifecycle.stopping) this.interruptOwnedRun(job.id, claimToken, `Interrupted by profile shutdown: ${message}`)
        else this.store.markJobRun(job.id, false, undefined, message, false, claimToken)
      }
    } finally {
      try {
        if (claimToken && !this.store.isRunClaimCurrent(job.id, claimToken)) {
          this.ownedRunClaims.delete(job.id)
        }
      } catch {
        // Retain ownership; shutdown retries exact-token finalization after the tick.
      }
      this.runningJobIds.delete(job.id)
      this.emitUpdated()
    }
  }

  private interruptOwnedRun(jobId: string, claimToken: string, reason: string): void {
    const interrupted = this.store.interruptRun(jobId, claimToken, reason)
    if (interrupted || !this.store.isRunClaimCurrent(jobId, claimToken)) {
      this.ownedRunClaims.delete(jobId)
      return
    }
    throw new Error(`Scheduled claim remained active after interruption: ${jobId}`)
  }

  private interruptOwnedRuns(reason: string): void {
    const errors: unknown[] = []
    for (const [jobId, claimToken] of [...this.ownedRunClaims]) {
      try { this.interruptOwnedRun(jobId, claimToken, reason) }
      catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Failed to interrupt scheduled job claims')
  }
}
