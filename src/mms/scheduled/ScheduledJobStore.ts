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
import { join } from 'path'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'
import type {
  CreateScheduledJobInput,
  JobSchedule,
  ScheduledJob,
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
import { computeNextRun } from './computeNextRun'
import { withFileLock } from './fileLock'

export const TICKER_INTERVAL_MS = 60_000

function ensureScheduledDir(): void {
  mkdirSync(getScheduledDir(), { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureScheduledDir()
  const tmpPath = join(tmpdir(), `mousse-scheduled-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
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
    nextRunAt: runtime?.nextRunAt ?? computeNextRun(definition.schedule),
    lastRunAt: runtime?.lastRunAt,
    lastStatus: runtime?.lastStatus,
    lastError: runtime?.lastError,
    pausedAt: runtime?.pausedAt,
    pausedReason: runtime?.pausedReason,
    runHistory: runtime?.runHistory ?? [],
    repeat
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

  claimDueJobs(now = new Date()): ScheduledJob[] {
    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      const due: ScheduledJob[] = []

      for (const job of jobs) {
        if (!job.enabled || job.state === 'paused' || job.state === 'running') continue
        if (!job.nextRunAt) continue
        if (new Date(job.nextRunAt).getTime() > now.getTime()) continue
        job.state = 'running'
        due.push({ ...job })
      }

      if (due.length > 0) {
        this.saveJobs(jobs)
      }

      return due
    })
  }

  markJobRun(
    id: string,
    success: boolean,
    output?: string,
    error?: string,
    silent = false
  ): ScheduledJob | null {
    return withFileLock(getScheduledJobsLockPath(), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      const job = jobs[index]
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
      } else if (job.state !== 'paused') {
        job.state = 'scheduled'
      }

      job.updatedAt = now
      jobs[index] = job
      this.saveJobs(jobs)
      return job
    })
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
