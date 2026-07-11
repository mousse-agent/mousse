import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { OrchestratorService } from '../orchestrator/OrchestratorService'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { SchedulerStatus, ScheduledJob } from '../../shared/types'
import { getScheduledTickLockPath } from '../data/paths'
import { isSilentOutput } from './computeNextRun'
import { tryAcquireTickLock } from './fileLock'
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
    void this.tick()
    this.ticker = setInterval(() => {
      void this.tick()
    }, TICKER_INTERVAL_MS)
    this.watchdog = setInterval(() => this.watchdogCheck(), TICKER_INTERVAL_MS)
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
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

  getStatus(): SchedulerStatus {
    const persisted = readTickerHeartbeat()
    const jobs = this.store.listJobs()
    const activeJobId =
      this.runningJobIds.size > 0 ? [...this.runningJobIds][0] : null

    return {
      running: this.ticker !== null,
      lastHeartbeatAt: this.lastHeartbeatAt ?? persisted.heartbeatAt,
      lastSuccessAt: this.lastSuccessAt ?? persisted.successAt,
      lastTickError: this.lastTickError,
      activeJobId,
      jobCount: jobs.length,
      dueCount: this.store.getDueCount()
    }
  }

  private emitUpdated(): void {
    this.emit('updated', this.store.listJobs())
    this.emit('status', this.getStatus())
  }

  private watchdogCheck(): void {
    if (!this.ticker) return

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
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) return

    const releaseTickLock = tryAcquireTickLock(getScheduledTickLockPath())
    if (!releaseTickLock) return

    this.tickInProgress = true
    try {
      this.lastHeartbeatAt = new Date().toISOString()
      recordTickerHeartbeat(false)

      const dueJobs = this.store.claimDueJobs()
      for (const job of dueJobs) {
        await this.executeJob(job)
      }

      this.lastSuccessAt = new Date().toISOString()
      this.lastTickError = null
      recordTickerHeartbeat(true)
    } catch (err) {
      this.lastTickError = err instanceof Error ? err.message : String(err)
    } finally {
      releaseTickLock()
      this.tickInProgress = false
      this.emit('status', this.getStatus())
    }
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    if (this.runningJobIds.has(job.id)) return
    this.runningJobIds.add(job.id)
    this.emit('status', this.getStatus())

    try {
      const result = await this.runner.runIsolated(job.prompt)
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
          const data = this.threadStore.loadThreadData(thread.id)
          data.messages.push({
            id: uuidv4(),
            role: 'assistant',
            content: result.text,
            timestamp: new Date().toISOString()
          })
          this.threadStore.saveThreadData(thread.id, data)
        } else if (job.threadId) {
          const data = this.threadStore.loadThreadData(job.threadId)
          data.messages.push({
            id: uuidv4(),
            role: 'assistant',
            content: `[Scheduled: ${job.name}]\n\n${result.text}`,
            timestamp: new Date().toISOString()
          })
          this.threadStore.saveThreadData(job.threadId, data)
        }
      }

      this.store.markJobRun(job.id, !result.error, result.text, result.error, silent)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.markJobRun(job.id, false, undefined, message)
    } finally {
      this.runningJobIds.delete(job.id)
      this.emitUpdated()
    }
  }
}
