import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import type {
  CreateScheduledJobInput,
  JobSchedule,
  ScheduledJob,
  ScheduledJobRunClaim,
  ScheduledJobRunRecord
} from '../../shared/types'
import { jobToDefinition, type MousseConfigStore } from '../config/MousseConfigStore'
import type { ScheduledJobDefinition, ScheduledJobRuntime } from '../config/types'
import {
  getScheduledDir,
  getScheduledJobsLockPath,
  getScheduledJobsPath,
  getScheduledJobsRuntimePath,
  getScheduledTickerHeartbeatPath,
  getScheduledTickerSuccessPath
} from '../data/paths'
import {
  isOwnerLive,
  PROCESS_INSTANCE_ID
} from '../queue/processLiveness'
import { createLeaseToken } from '../queue/ThreadExecutionLease'
import { computeNextRun } from './computeNextRun'
import { withFileLock } from './fileLock'

export const TICKER_INTERVAL_MS = 60_000

function ensureScheduledDir(): void {
  mkdirSync(getScheduledDir(), { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureScheduledDir()
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

function atomicWriteEpoch(path: string): void {
  ensureScheduledDir()
  const tmpPath = join(getScheduledDir(), `.hb_${Date.now()}.tmp`)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, String(Date.now() / 1000))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

export function recordTickerHeartbeat(success = false): void {
  try {
    atomicWriteEpoch(getScheduledTickerHeartbeatPath())
    if (success) {
      atomicWriteEpoch(getScheduledTickerSuccessPath())
    }
  } catch {
    /* best effort */
  }
}

export function readTickerHeartbeat(): { heartbeatAt: string | null; successAt: string | null } {
  const readEpoch = (path: string): string | null => {
    try {
      if (!existsSync(path)) return null
      const raw = readFileSync(path, 'utf-8').trim()
      const epoch = Number(raw)
      if (Number.isNaN(epoch)) return null
      return new Date(epoch * 1000).toISOString()
    } catch {
      return null
    }
  }

  return {
    heartbeatAt: readEpoch(getScheduledTickerHeartbeatPath()),
    successAt: readEpoch(getScheduledTickerSuccessPath())
  }
}

function extractRuntime(job: ScheduledJob): ScheduledJobRuntime {
  return {
    state: job.state,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastError: job.lastError,
    pausedAt: job.pausedAt,
    pausedReason: job.pausedReason,
    runHistory: job.runHistory,
    runClaim: job.runClaim,
    repeat: job.repeat?.times
      ? { times: job.repeat.times, completed: job.repeat.completed ?? 0 }
      : undefined
  }
}

function mergeJob(definition: ScheduledJobDefinition, runtime?: ScheduledJobRuntime): ScheduledJob {
  const repeat =
    runtime?.repeat ??
    (definition.repeat?.times
      ? { times: definition.repeat.times, completed: definition.repeat.completed ?? 0 }
      : undefined)

  return {
    ...definition,
    state: runtime?.state ?? (definition.enabled ? 'scheduled' : 'paused'),
    // Preserve explicit null (e.g. interrupted one-shot) — do not recompute.
    nextRunAt:
      runtime && Object.prototype.hasOwnProperty.call(runtime, 'nextRunAt')
        ? (runtime.nextRunAt ?? null)
        : computeNextRun(definition.schedule),
    lastRunAt: runtime?.lastRunAt,
    lastStatus: runtime?.lastStatus,
    lastError: runtime?.lastError,
    pausedAt: runtime?.pausedAt,
    pausedReason: runtime?.pausedReason,
    runHistory: runtime?.runHistory ?? [],
    runClaim: runtime?.runClaim,
    repeat
  }
}

function newRunClaim(): ScheduledJobRunClaim {
  const now = new Date().toISOString()
  return {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: createLeaseToken(),
    claimedAt: now,
    heartbeatAt: now
  }
}

export class ScheduledJobStore {
  constructor(private readonly config: MousseConfigStore) {
    this.migrateLegacyRuntimeIfNeeded()
  }

  private migrateLegacyRuntimeIfNeeded(): void {
    const runtimePath = getScheduledJobsRuntimePath()
    if (existsSync(runtimePath)) return
    const jobsPath = getScheduledJobsPath()
    if (!existsSync(jobsPath)) return
    try {
      const jobs = JSON.parse(readFileSync(jobsPath, 'utf-8')) as ScheduledJob[]
      const runtime: Record<string, ScheduledJobRuntime> = {}
      for (const job of jobs) {
        runtime[job.id] = extractRuntime(job)
      }
      atomicWriteJson(runtimePath, runtime)
    } catch {
      /* ignore */
    }
  }

  private loadRuntimeMap(): Record<string, ScheduledJobRuntime> {
    const runtimePath = getScheduledJobsRuntimePath()
    if (!existsSync(runtimePath)) return {}
    try {
      return JSON.parse(readFileSync(runtimePath, 'utf-8')) as Record<string, ScheduledJobRuntime>
    } catch {
      return {}
    }
  }

  listJobs(): ScheduledJob[] {
    ensureScheduledDir()
    return withFileLock(getScheduledJobsLockPath(), () => {
      const definitions = this.config.getScheduledSection().jobs
      const runtimeMap = this.loadRuntimeMap()
      return definitions.map((definition) => mergeJob(definition, runtimeMap[definition.id]))
    })
  }

  private saveJobs(jobs: ScheduledJob[]): void {
    const definitions = jobs.map((job) => jobToDefinition(job))
    const runtimeMap: Record<string, ScheduledJobRuntime> = {}
    for (const job of jobs) {
      runtimeMap[job.id] = extractRuntime(job)
    }
    this.config.updateScheduledSection({ jobs: definitions })
    atomicWriteJson(getScheduledJobsRuntimePath(), runtimeMap)
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.listJobs().find((job) => job.id === id)
  }

  createJob(input: CreateScheduledJobInput): ScheduledJob {
    const now = new Date().toISOString()
    const nextRunAt = computeNextRun(input.schedule)
    const job: ScheduledJob = {
      id: uuidv4(),
      name: input.name.trim() || 'Scheduled job',
      prompt: input.prompt.trim(),
      schedule: input.schedule,
      enabled: true,
      state: nextRunAt ? 'scheduled' : 'completed',
      nextRunAt,
      threadId: input.threadId,
      projectId: input.projectId,
      createThread: input.createThread,
      repeat: input.repeat ? { times: input.repeat.times, completed: 0 } : undefined,
      runHistory: [],
      createdAt: now,
      updatedAt: now
    }

    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      jobs.push(job)
      this.saveJobs(jobs)
      return job
    })
  }

  updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      const updated: ScheduledJob = {
        ...jobs[index],
        ...patch,
        id: jobs[index].id,
        updatedAt: new Date().toISOString()
      }
      jobs[index] = updated
      this.saveJobs(jobs)
      return updated
    })
  }

  deleteJob(id: string): boolean {
    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      const next = jobs.filter((job) => job.id !== id)
      if (next.length === jobs.length) return false
      this.saveJobs(next)
      return true
    })
  }

  pauseJob(id: string, reason?: string): ScheduledJob | null {
    return this.updateJob(id, {
      enabled: false,
      state: 'paused',
      pausedAt: new Date().toISOString(),
      pausedReason: reason
    })
  }

  resumeJob(id: string): ScheduledJob | null {
    const job = this.getJob(id)
    if (!job) return null
    const nextRunAt = computeNextRun(job.schedule)
    return this.updateJob(id, {
      enabled: true,
      state: nextRunAt ? 'scheduled' : 'completed',
      pausedAt: undefined,
      pausedReason: undefined,
      nextRunAt
    })
  }

  triggerJob(id: string): ScheduledJob | null {
    return this.updateJob(id, {
      enabled: true,
      state: 'scheduled',
      pausedAt: undefined,
      pausedReason: undefined,
      nextRunAt: new Date().toISOString()
    })
  }

  /**
   * Atomically claim due jobs for execution. Each claimed job receives a durable
   * runClaim (pid + process instance + token). Live running claims are never stolen.
   */
  claimDueJobs(now = new Date()): ScheduledJob[] {
    return withFileLock(getScheduledJobsLockPath(), () => {
      // Reconcile dead running owners before taking new claims (same lock section).
      this.reconcileStaleRunningJobsUnlocked(now)

      const jobs = this.listJobs()
      const due: ScheduledJob[] = []

      for (const job of jobs) {
        if (!job.enabled || job.state === 'paused' || job.state === 'running') continue
        if (!job.nextRunAt) continue
        if (new Date(job.nextRunAt).getTime() > now.getTime()) continue
        job.state = 'running'
        job.runClaim = newRunClaim()
        due.push({ ...job, runClaim: { ...job.runClaim } })
      }

      if (due.length > 0) {
        this.saveJobs(jobs)
      }

      return due
    })
  }

  /**
   * True when job is running with a durable claim whose token exactly matches.
   * Used after external runner returns to fence stale finishers before side effects.
   */
  isRunClaimCurrent(id: string, claimToken: string | undefined): boolean {
    if (!claimToken) return false
    return withFileLock(getScheduledJobsLockPath(), () => {
      const job = this.listJobs().find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || !job.runClaim) return false
      return job.runClaim.token === claimToken
    })
  }

  /**
   * Finalize only a running job with a current durable claim and exact token.
   * Unclaimed / non-running jobs cannot be finalized (missing token never succeeds).
   * A stale owner finishing after reclaim must not overwrite the current owner result.
   */
  markJobRun(
    id: string,
    success: boolean,
    output?: string,
    error?: string,
    silent = false,
    claimToken?: string
  ): ScheduledJob | null {
    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      const job = jobs[index]
      // Require running + durable claim + exact token. No unclaimed finalization.
      if (job.state !== 'running' || !job.runClaim) return null
      if (!claimToken || job.runClaim.token !== claimToken) return null

      const now = new Date().toISOString()
      const record: ScheduledJobRunRecord = {
        runAt: now,
        status: success ? 'ok' : 'error',
        output: success ? output : undefined,
        error: success ? undefined : error,
        silent
      }

      job.lastRunAt = now
      job.lastStatus = success ? 'ok' : 'error'
      job.lastError = success ? undefined : error
      job.runHistory = [...(job.runHistory ?? []), record].slice(-20)
      job.runClaim = undefined

      if (job.repeat?.times) {
        job.repeat.completed = (job.repeat.completed ?? 0) + 1
        if (job.repeat.completed >= job.repeat.times) {
          jobs.splice(index, 1)
          this.saveJobs(jobs)
          return null
        }
      }

      const nextRunAt = computeNextRun(job.schedule, now)
      job.nextRunAt = nextRunAt

      if (!nextRunAt) {
        const kind = job.schedule.kind
        if (kind === 'once') {
          job.enabled = false
          job.state = 'completed'
        } else {
          job.state = 'error'
          job.lastError = job.lastError ?? 'Failed to compute next run'
        }
      } else {
        // Finalizing a running claim always returns to scheduled when a next run exists.
        job.state = 'scheduled'
      }

      job.updatedAt = now
      jobs[index] = job
      this.saveJobs(jobs)
      return job
    })
  }

  /**
   * Reconcile running jobs whose owner is dead/expired.
   * One-shot: state error, enabled false, lastStatus interrupted (no silent complete/rerun).
   * Recurring: schedule next normal occurrence. Never reclaims a live owner.
   */
  reconcileStaleRunningJobs(now = new Date()): ScheduledJob[] {
    return withFileLock(getScheduledJobsLockPath(), () => {
      return this.reconcileStaleRunningJobsUnlocked(now)
    })
  }

  /** Caller must already hold the scheduled-jobs file lock (or be in a reentrant section). */
  private reconcileStaleRunningJobsUnlocked(now = new Date()): ScheduledJob[] {
    const jobs = this.listJobs()
    const interrupted: ScheduledJob[] = []
    let dirty = false
    const nowIso = now.toISOString()

    for (const job of jobs) {
      if (job.state !== 'running') continue
      const claim = job.runClaim
      // Legacy running without claim, or dead owner → interrupt.
      if (claim && isOwnerLive(claim)) continue

      const record: ScheduledJobRunRecord = {
        runAt: nowIso,
        status: 'interrupted',
        error: claim
          ? 'Interrupted: scheduler owner process is no longer live'
          : 'Interrupted: running job had no durable owner claim'
      }
      job.lastRunAt = nowIso
      job.lastStatus = 'interrupted'
      job.lastError = record.error
      job.runHistory = [...(job.runHistory ?? []), record].slice(-20)
      job.runClaim = undefined

      if (job.schedule.kind === 'once') {
        // Non-idempotent side effects: do not complete and do not auto-rerun.
        job.enabled = false
        job.state = 'error'
        job.nextRunAt = null
        job.lastError =
          record.error +
          '. One-shot job was interrupted; re-enable via manual trigger to retry.'
      } else {
        const nextRunAt = computeNextRun(job.schedule, nowIso)
        job.nextRunAt = nextRunAt
        if (!nextRunAt) {
          job.state = 'error'
          job.lastError = job.lastError ?? 'Failed to compute next run after interrupt'
        } else {
          job.state = 'scheduled'
        }
      }
      job.updatedAt = nowIso
      interrupted.push({ ...job })
      dirty = true
    }

    if (dirty) this.saveJobs(jobs)
    return interrupted
  }

  recomputeNextRun(id: string, schedule?: JobSchedule): ScheduledJob | null {
    const job = this.getJob(id)
    if (!job) return null
    const nextSchedule = schedule ?? job.schedule
    const nextRunAt = computeNextRun(nextSchedule, job.lastRunAt)
    return this.updateJob(id, { schedule: nextSchedule, nextRunAt })
  }

  getDueCount(now = new Date()): number {
    return this.listJobs().filter((job) => {
      if (!job.enabled || job.state === 'paused' || job.state === 'running') return false
      if (!job.nextRunAt) return false
      return new Date(job.nextRunAt).getTime() <= now.getTime()
    }).length
  }
}
