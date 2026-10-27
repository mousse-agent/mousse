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
  ScheduledJobRunRecord,
  ScheduledOccurrenceResult
} from '../../shared/types'
import { TERMINAL_RUN_STATUSES, type RunStatus } from '../run/types'
import { jobToDefinition, type MousseConfigStore } from '../config/MousseConfigStore'
import type { ScheduledJobDefinition, ScheduledJobRuntime } from '../config/types'
import { WORKFLOW_UUID_PATTERN } from '../../shared/workflows'
import { getMousseHomeDir } from '../data/paths'
import {
  isOwnerLive,
  PROCESS_INSTANCE_ID
} from '../queue/processLiveness'
import { createLeaseToken } from '../queue/ThreadExecutionLease'
import { computeNextRun } from './computeNextRun'
import { withFileLock } from './fileLock'

export const TICKER_INTERVAL_MS = 60_000

/** The Run Engine run an occurrence is held by, as the scheduler reads it. */
export interface ScheduledRunView {
  status: RunStatus
  threadId: string
  /** The run's own error text, when it ended with one. */
  error?: string
}

/**
 * What the store asks the Run Engine about an admitted occurrence (the orchestrator builds it over
 * its engine). Without a probe no occurrence outlives its claim: a dead claim is interrupted as before.
 */
export interface ScheduledRunProbe {
  /** `unavailable`: no engine to ask, so the occurrence is left as it is. `absent`: the engine has no such run. */
  runStatus(runId: string): ScheduledRunView | 'absent' | 'unavailable'
  /** True while a queued run still has a `turn.start` effect or a queue item that will start it. */
  admissionPending(runId: string, threadId: string): boolean
  /** Cancels a queued run nothing can start; an already-terminal or stale run is left to the terminal mapping. */
  cancelOrphanedAdmission(runId: string): void
  /** The run an accepted deterministic send receipt names (a crash between the dispatch and the claim write). */
  receipt(clientRequestId: string): { runId: string; threadId: string } | undefined
}

/** Fields of a run record the runner knows once the occurrence has a thread and a run. */
export type ScheduledRunDetails = Partial<
  Pick<ScheduledJobRunRecord, 'threadId' | 'runId' | 'queueItemId' | 'selection' | 'mode' | 'workspace' | 'missingPlaceholders'>
>

export function scheduledReceiptId(jobId: string, occurrenceKey: string): string {
  return 'schedule:' + jobId + ':' + occurrenceKey
}

/** The occurrence outcome a terminal Run Engine run maps to. */
export function occurrenceResultOfRun(run: Pick<ScheduledRunView, 'status' | 'error'>): ScheduledOccurrenceResult {
  switch (run.status) {
    case 'completed':
      return { status: 'ok' }
    case 'failed':
      return { status: 'error', error: run.error ?? 'The run failed' }
    case 'uncertain':
      return { status: 'uncertain', error: run.error ?? 'The run ended uncertain; its effects may have occurred' }
    case 'interrupted':
      return { status: 'interrupted', error: run.error ?? 'Interrupted while running' }
    default:
      return { status: 'interrupted', error: run.error ?? 'Interrupted: removed before start' }
  }
}

function ensureScheduledDir(directory: string): void {
  mkdirSync(directory, { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureScheduledDir(dirname(path))
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

function atomicWriteEpoch(path: string): void {
  ensureScheduledDir(dirname(path))
  const tmpPath = join(dirname(path), `.hb_${process.pid}_${Date.now()}.tmp`)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, String(Date.now() / 1000))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

export function recordTickerHeartbeat(success = false, homeDir = getMousseHomeDir()): void {
  try {
    atomicWriteEpoch(join(homeDir, 'scheduled', 'ticker_heartbeat'))
    if (success) {
      atomicWriteEpoch(join(homeDir, 'scheduled', 'ticker_last_success'))
    }
  } catch {
    /* best effort */
  }
}

export function readTickerHeartbeat(homeDir = getMousseHomeDir()): { heartbeatAt: string | null; successAt: string | null } {
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
    heartbeatAt: readEpoch(join(homeDir, 'scheduled', 'ticker_heartbeat')),
    successAt: readEpoch(join(homeDir, 'scheduled', 'ticker_last_success'))
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
    pendingOccurrence: job.pendingOccurrence,
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
    pendingOccurrence: runtime?.pendingOccurrence,
    repeat
  }
}

function newRunClaim(occurrenceKey: string): ScheduledJobRunClaim {
  const now = new Date().toISOString()
  return {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: createLeaseToken(),
    claimedAt: now,
    heartbeatAt: now,
    occurrenceKey
  }
}

/** The thread and run a claim had recorded, for the run record of an interrupted claim. */
function claimRecordFields(claim: ScheduledJobRunClaim | undefined): Partial<ScheduledJobRunRecord> {
  if (!claim) return {}
  return {
    ...(claim.occurrenceKey ? { occurrenceKey: claim.occurrenceKey } : {}),
    ...(claim.threadId ? { threadId: claim.threadId } : {}),
    ...(claim.runId ? { runId: claim.runId } : {})
  }
}

/** A clock-free job stays scheduled with no next run; every other kind without a next run has ended. */
function stateWithoutNextRun(job: ScheduledJob): ScheduledJob['state'] {
  if (job.schedule.kind === 'manual') return 'scheduled'
  return job.schedule.kind === 'once' ? 'completed' : 'error'
}

export class ScheduledJobStore {
  readonly homeDir: string
  private probe: ScheduledRunProbe | null = null
  private onOrphanedThread: ((orphan: { jobId: string; threadId: string; runId?: string }) => void) | null = null

  constructor(private readonly config: MousseConfigStore) {
    this.homeDir = config.getHomeDir()
    this.migrateLegacyRuntimeIfNeeded()
  }

  /** Lets occurrences outlive their claim: the Run Engine decides when one is over. */
  setRunProbe(probe: ScheduledRunProbe | null): void {
    this.probe = probe
  }

  /** Called after a claim that never reached a run is interrupted, with the thread it had chosen. */
  setOrphanedThreadHandler(handler: ((orphan: { jobId: string; threadId: string; runId?: string }) => void) | null): void {
    this.onOrphanedThread = handler
  }

  /** The Run Engine run of an occurrence, or `unavailable` when there is no probe or engine to ask. */
  probeRun(runId: string): ScheduledRunView | 'absent' | 'unavailable' {
    return this.probe ? this.probe.runStatus(runId) : 'unavailable'
  }

  private notifyOrphanedThread(jobId: string, claim: Pick<ScheduledJobRunClaim, 'threadId' | 'runId'> | undefined): void {
    if (!claim?.threadId || !this.onOrphanedThread) return
    try {
      this.onOrphanedThread({ jobId, threadId: claim.threadId, runId: claim.runId })
    } catch {
      /* best effort: an empty per-run thread left behind is harmless */
    }
  }

  private migrateLegacyRuntimeIfNeeded(): void {
    const runtimePath = join(this.homeDir, 'scheduled', 'jobs-runtime.json')
    if (existsSync(runtimePath)) return
    const jobsPath = join(this.homeDir, 'scheduled', 'jobs.json')
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
    const runtimePath = join(this.homeDir, 'scheduled', 'jobs-runtime.json')
    if (!existsSync(runtimePath)) return {}
    try {
      return JSON.parse(readFileSync(runtimePath, 'utf-8')) as Record<string, ScheduledJobRuntime>
    } catch {
      return {}
    }
  }

  listJobs(): ScheduledJob[] {
    ensureScheduledDir(join(this.homeDir, 'scheduled'))
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const definitions = this.config.getScheduledSection().jobs
      const runtimeMap = this.loadRuntimeMap()
      return definitions.map((definition) => mergeJob(definition, runtimeMap[definition.id]))
    })
  }

  private saveJobs(jobs: ScheduledJob[]): void {
    // A job paused while its run was in flight settles as paused once the run's claim is gone.
    for (const job of jobs) {
      if (job.state === 'scheduled' && job.pausedAt && !job.enabled && !job.runClaim) job.state = 'paused'
    }
    const definitions = jobs.map((job) => jobToDefinition(job))
    const runtimeMap: Record<string, ScheduledJobRuntime> = {}
    for (const job of jobs) {
      runtimeMap[job.id] = extractRuntime(job)
    }
    this.config.updateScheduledSection({ jobs: definitions })
    atomicWriteJson(join(this.homeDir, 'scheduled', 'jobs-runtime.json'), runtimeMap)
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
      state: nextRunAt || input.schedule.kind === 'manual' ? 'scheduled' : 'completed',
      nextRunAt,
      threadId: input.threadId,
      projectId: input.projectId,
      createThread: input.createThread,
      selection: input.selection,
      mode: input.mode,
      workspace: input.workspace,
      createdBy: input.createdBy,
      accessCap: input.accessCap,
      repeat: input.repeat ? { times: input.repeat.times, completed: 0 } : undefined,
      runHistory: [],
      createdAt: now,
      updatedAt: now
    }

    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      jobs.push(job)
      this.saveJobs(jobs)
      return job
    })
  }

  updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      const updated: ScheduledJob = {
        ...jobs[index],
        ...patch,
        id: jobs[index].id,
        updatedAt: new Date().toISOString()
      }
      // A schedule edit that adds or removes the clock moves the next run with it.
      if (patch.schedule && !('nextRunAt' in patch) && (patch.schedule.kind === 'manual') !== (jobs[index].schedule.kind === 'manual')) {
        updated.nextRunAt = computeNextRun(patch.schedule)
        if (updated.state !== 'paused' && updated.state !== 'running') updated.state = updated.nextRunAt || patch.schedule.kind === 'manual' ? 'scheduled' : 'completed'
      }
      jobs[index] = updated
      this.saveJobs(jobs)
      return updated
    })
  }

  deleteJob(id: string): boolean {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const next = jobs.filter((job) => job.id !== id)
      if (next.length === jobs.length) return false
      this.saveJobs(next)
      return true
    })
  }

  pauseJob(id: string, reason?: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const running = this.getJob(id)?.state === 'running'
      // A running job keeps its running state and claim: the run in flight must be able to finish. It
      // settles as paused when it ends (`saveJobs`), and no further occurrence is claimed meanwhile.
      return this.updateJob(id, {
        enabled: false,
        ...(running ? {} : { state: 'paused' as const }),
        pausedAt: new Date().toISOString(),
        pausedReason: reason
      })
    })
  }

  resumeJob(id: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.getJob(id)
      if (!job) return null
      const nextRunAt = computeNextRun(job.schedule)
      return this.updateJob(id, {
        enabled: true,
        // A running job stays running until its claim is finalized.
        ...(job.state === 'running' ? {} : { state: nextRunAt || job.schedule.kind === 'manual' ? 'scheduled' as const : 'completed' as const }),
        pausedAt: undefined,
        pausedReason: undefined,
        ...(job.state === 'running' ? {} : { nextRunAt })
      })
    })
  }

  /**
   * Makes a job due now. A job that is running, or whose occurrence is admitted and not finished, is
   * returned as it is: the occurrence in flight is neither restarted nor queued behind itself.
   */
  triggerJob(id: string): ScheduledJob | null {
    const current = this.getJob(id)
    if (current?.state === 'running' || current?.runClaim || current?.pendingOccurrence) return current
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
  claimDueJobs(now = new Date(), options: { limit?: number; skipJobIds?: ReadonlySet<string> } = {}): ScheduledJob[] {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      // Reconcile dead running owners before taking new claims (same lock section).
      this.reconcileStaleRunningJobsUnlocked(now)

      const jobs = this.listJobs()
      const due: ScheduledJob[] = []
      // An occurrence whose run ended (or can never start) is released before its job is considered.
      const released: Array<{ jobId: string; threadId: string; runId: string }> = []
      let dirty = this.reconcilePendingOccurrences(jobs, now.toISOString(), released)

      for (const job of jobs) {
        if (!job.enabled || job.state === 'paused' || job.state === 'running' || job.runClaim) continue
        // A job this process is already running is not claimed again: the caller would drop the claim.
        if (options.skipJobIds?.has(job.id)) continue
        // A bounded start (catch-up after downtime): the rest stay due for the next tick.
        if (options.limit !== undefined && due.length >= options.limit) break
        // One outstanding occurrence per job, held until its run is terminal.
        if (job.pendingOccurrence) continue
        if (!job.nextRunAt) continue
        if (new Date(job.nextRunAt).getTime() > now.getTime()) continue
        const resumedWaiting = job.lastStatus === 'waiting'
        job.state = 'running'
        job.runClaim = { ...newRunClaim(job.nextRunAt), ...(resumedWaiting ? { resumedWaiting: true } : {}) }
        due.push({ ...job, runClaim: { ...job.runClaim } })
        dirty = true
      }

      if (dirty) {
        this.saveJobs(jobs)
      }
      // A released occurrence whose run produced nothing (never started, removed) leaves an empty per-run thread.
      for (const { jobId, threadId, runId } of released) this.notifyOrphanedThread(jobId, { threadId, runId })

      return due
    })
  }

  /**
   * Releases the occurrences whose Run Engine run is over. The engine, not the queue, says when an
   * occurrence ends: an item consumed at input acceptance is gone from the queue while its run is
   * still going. Returns true when a job changed. Caller holds the jobs lock.
   */
  private reconcilePendingOccurrences(jobs: ScheduledJob[], nowIso: string, released: Array<{ jobId: string; threadId: string; runId: string }>): boolean {
    const probe = this.probe
    if (!probe) return false
    let dirty = false
    for (const job of [...jobs]) {
      const pending = job.pendingOccurrence
      if (!pending) continue
      const release = (result: ScheduledOccurrenceResult): void => {
        this.applyOccurrenceResult(jobs, job, pending.occurrenceKey, result, nowIso)
        released.push({ jobId: job.id, threadId: pending.threadId, runId: pending.runId })
        dirty = true
      }
      const view = probe.runStatus(pending.runId)
      if (view === 'unavailable') continue
      if (view === 'absent') {
        release({ status: 'interrupted', error: 'Interrupted: removed before start' })
        continue
      }
      if (view.status === 'queued') {
        if (probe.admissionPending(pending.runId, pending.threadId)) continue
        // Nothing can start this run (a crash between the admission and its effect or queue item):
        // cancel it, and a run that is already terminal or was written by another epoch maps as usual.
        probe.cancelOrphanedAdmission(pending.runId)
        const after = probe.runStatus(pending.runId)
        if (after === 'unavailable' || (after !== 'absent' && !TERMINAL_RUN_STATUSES.has(after.status))) continue
        const result: ScheduledOccurrenceResult = after === 'absent' || after.status === 'cancelled'
          ? { status: 'interrupted', error: 'Interrupted: never started' }
          : occurrenceResultOfRun(after)
        release(result)
        continue
      }
      if (!TERMINAL_RUN_STATUSES.has(view.status)) {
        if (pending.state !== 'running') {
          pending.state = 'running'
          dirty = true
        }
        continue
      }
      release(occurrenceResultOfRun(view))
    }
    return dirty
  }

  /**
   * Ends an occurrence in `jobs`: its run record gets the outcome (a new record when the occurrence
   * had none), the repeat is spent and the next run is computed. May remove the job from `jobs`
   * (a spent repeat). Caller saves.
   */
  private applyOccurrenceResult(
    jobs: ScheduledJob[],
    job: ScheduledJob,
    occurrenceKey: string | undefined,
    result: ScheduledOccurrenceResult,
    nowIso: string,
    details?: ScheduledRunDetails
  ): void {
    const record: ScheduledJobRunRecord = {
      runAt: nowIso,
      status: result.status,
      output: result.status === 'ok' ? result.text : undefined,
      error: result.status === 'ok' ? undefined : result.error,
      silent: result.silent,
      ...(occurrenceKey ? { occurrenceKey } : {}),
      ...details
    }
    const history = [...(job.runHistory ?? [])]
    let existing = -1
    if (occurrenceKey) {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].occurrenceKey === occurrenceKey && history[index].status === 'queued') { existing = index; break }
      }
    }
    if (existing >= 0) history[existing] = { ...history[existing], ...record, runAt: history[existing].runAt }
    else history.push(record)
    job.runHistory = history.slice(-20)
    job.lastRunAt = nowIso
    job.lastStatus = result.status
    job.lastError = result.status === 'ok' ? undefined : result.error
    job.runClaim = undefined
    job.pendingOccurrence = undefined
    job.updatedAt = nowIso

    // A run that did not finish cleanly is never retried on its own: a one-shot job stays for a manual retry.
    if ((result.status === 'interrupted' || result.status === 'uncertain') && job.schedule.kind === 'once') {
      job.enabled = false
      job.state = 'error'
      job.nextRunAt = null
      return
    }
    if (job.repeat?.times) {
      job.repeat.completed = (job.repeat.completed ?? 0) + 1
      if (job.repeat.completed >= job.repeat.times) {
        const index = jobs.indexOf(job)
        if (index >= 0) jobs.splice(index, 1)
        return
      }
    }
    const nextRunAt = computeNextRun(job.schedule, nowIso)
    job.nextRunAt = nextRunAt
    const wasPaused = job.state === 'paused'
    if (!nextRunAt) {
      if (job.schedule.kind === 'once') job.enabled = false
      if (job.schedule.kind !== 'manual' && job.schedule.kind !== 'once') job.lastError = job.lastError ?? 'Failed to compute next run'
      if (!wasPaused) job.state = stateWithoutNextRun(job)
    } else if (!wasPaused) {
      job.state = 'scheduled'
    }
  }

  /**
   * An admitted run ended. A held claim keeps the result until it is finalized (the run can end before
   * `markQueuedOccurrence` runs); an admitted occurrence is released and recorded. Every daemon over the
   * profile home runs the end-of-turn hook, so this is idempotent: an occurrence already released is a no-op.
   */
  completeOccurrence(id: string, occurrenceKey: string, result: ScheduledOccurrenceResult, details?: ScheduledRunDetails): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job) return null
      if (job.state === 'running' && job.runClaim?.occurrenceKey === occurrenceKey) {
        job.runClaim.settledResult = result
        this.saveJobs(jobs)
        return job
      }
      if (job.pendingOccurrence?.occurrenceKey !== occurrenceKey) return null
      this.applyOccurrenceResult(jobs, job, occurrenceKey, result, new Date().toISOString(), details)
      this.saveJobs(jobs)
      return jobs.includes(job) ? job : null
    })
  }

  /** The claim records the thread the occurrence chose, so a restart can find (or discard) it. */
  markClaimThread(id: string, claimToken: string, threadId: string): boolean {
    return this.updateClaim(id, claimToken, (claim) => { claim.threadId = threadId })
  }

  /** The claim records the run its admission created, before anything starts. */
  markOccurrenceAdmitted(id: string, claimToken: string, runId: string): boolean {
    return this.updateClaim(id, claimToken, (claim) => { claim.runId = runId })
  }

  private updateClaim(id: string, claimToken: string, write: (claim: ScheduledJobRunClaim) => void): boolean {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || job.runClaim?.token !== claimToken) return false
      write(job.runClaim)
      this.saveJobs(jobs)
      return true
    })
  }

  /**
   * The occurrence was admitted and is not finished: it waits behind a busy thread (`queueItemId`) or an
   * existing run is being observed. The claim ends with a `queued` record, the job returns to `scheduled`
   * without spending a repeat, and `pendingOccurrence` holds the job until the run is terminal. A result
   * that arrived before this call (a fast drain) is applied at once.
   */
  markQueuedOccurrence(id: string, claimToken: string, queueItemId?: string, details?: ScheduledRunDetails): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      const claim = job?.runClaim
      if (!job || !claim || job.state !== 'running' || claim.token !== claimToken) return null
      const threadId = claim.threadId ?? details?.threadId
      const runId = claim.runId ?? details?.runId
      if (!threadId || !runId) return null
      const now = new Date().toISOString()
      job.runHistory = [
        ...(job.runHistory ?? []),
        { runAt: now, status: 'queued' as const, occurrenceKey: claim.occurrenceKey, ...details, threadId, runId, ...(queueItemId ? { queueItemId } : {}) }
      ].slice(-20)
      job.pendingOccurrence = {
        occurrenceKey: claim.occurrenceKey,
        threadId,
        runId,
        ...(queueItemId ? { queueItemId } : {}),
        state: queueItemId ? 'queued' : 'admitted'
      }
      job.runClaim = undefined
      job.state = 'scheduled'
      job.updatedAt = now
      const settled = claim.settledResult
      if (settled) this.applyOccurrenceResult(jobs, job, claim.occurrenceKey, settled, now)
      this.saveJobs(jobs)
      return jobs.includes(job) ? job : null
    })
  }

  /**
   * True when job is running with a durable claim whose token exactly matches.
   * Used after external runner returns to fence stale finishers before side effects.
   */
  isRunClaimCurrent(id: string, claimToken: string | undefined): boolean {
    if (!claimToken) return false
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.listJobs().find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || !job.runClaim) return false
      return job.runClaim.token === claimToken
    })
  }

  markWorkflowClaim(id: string, claimToken: string, workflowInvocationId: string): boolean {
    if (!WORKFLOW_UUID_PATTERN.test(workflowInvocationId)) return false
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || job.runClaim?.token !== claimToken) return false
      job.runClaim.workflowInvocationId = workflowInvocationId
      job.updatedAt = new Date().toISOString()
      this.saveJobs(jobs)
      return true
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
    claimToken?: string,
    status?: 'ok' | 'error' | 'waiting',
    details?: ScheduledRunDetails
  ): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      const job = jobs[index]
      // Require running + durable claim + exact token. No unclaimed finalization.
      if (job.state !== 'running' || !job.runClaim) return null
      if (!claimToken || job.runClaim.token !== claimToken) return null

      const now = new Date().toISOString()
      const resultStatus = status ?? (success ? 'ok' : 'error')
      const occurrenceKey = job.runClaim.occurrenceKey

      if (resultStatus === 'waiting') {
        const record: ScheduledJobRunRecord = { runAt: now, status: 'waiting', output, silent }
        job.lastRunAt = now
        job.lastStatus = 'waiting'
        job.lastError = undefined
        job.runHistory = [...(job.runHistory ?? []), record].slice(-20)
        job.runClaim = undefined
        job.state = 'scheduled'
        job.updatedAt = now
        jobs[index] = job
        this.saveJobs(jobs)
        return job
      }

      // A turn that returned normally but whose run the engine ended failed, interrupted or uncertain (a
      // provider error, a Stop, a non-idempotent tool in flight) is recorded as the engine ended it, never as success.
      const settled = job.runClaim.settledResult
      const result: ScheduledOccurrenceResult = settled && settled.status !== 'ok'
        ? settled
        : { status: resultStatus, text: output, error, silent }
      // Finalizing a running claim always returns to scheduled when a next run exists.
      this.applyOccurrenceResult(jobs, job, occurrenceKey, result, now, details)
      this.saveJobs(jobs)
      return jobs.includes(job) ? job : null
    })
  }

  /** Finalize a live owner's cancelled claim without recording success or spending a repeat. */
  interruptRun(id: string, claimToken: string, reason: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || job.runClaim?.token !== claimToken) return null
      const now = new Date().toISOString()
      if (job.runClaim.workflowInvocationId && WORKFLOW_UUID_PATTERN.test(job.runClaim.workflowInvocationId)) {
        job.runClaim = undefined
        job.state = 'scheduled'
        job.lastStatus = 'waiting'
        job.lastError = undefined
        job.updatedAt = now
        this.saveJobs(jobs)
        return job
      }
      const claim = job.runClaim
      // An admitted occurrence is the engine's: its run ends on its own terms, not this claim's.
      if (this.holdAdmittedOccurrence(job, claim, now)) {
        this.saveJobs(jobs)
        return job
      }
      job.lastRunAt = now
      job.lastStatus = 'interrupted'
      job.lastError = reason
      job.runHistory = [...(job.runHistory ?? []), { runAt: now, status: 'interrupted' as const, error: reason, ...claimRecordFields(claim) }].slice(-20)
      job.runClaim = undefined
      if (job.schedule.kind === 'once') {
        job.enabled = false
        job.state = 'error'
        job.nextRunAt = null
      } else {
        job.nextRunAt = computeNextRun(job.schedule, now)
        job.state = job.nextRunAt ? 'scheduled' : job.schedule.kind === 'manual' ? 'scheduled' : 'error'
      }
      job.updatedAt = now
      this.saveJobs(jobs)
      // The claim never reached a run, so a per-run thread it created is still empty.
      if (!claim.runId) this.notifyOrphanedThread(id, claim)
      return job
    })
  }

  /**
   * Reconcile running jobs whose owner is dead/expired.
   * One-shot: state error, enabled false, lastStatus interrupted (no silent complete/rerun).
   * Recurring: schedule next normal occurrence. Never reclaims a live owner.
   */
  reconcileStaleRunningJobs(now = new Date()): ScheduledJob[] {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      return this.reconcileStaleRunningJobsUnlocked(now)
    })
  }

  /** Caller must already hold the scheduled-jobs file lock (or be in a reentrant section). */
  private reconcileStaleRunningJobsUnlocked(now = new Date()): ScheduledJob[] {
    const jobs = this.listJobs()
    const interrupted: ScheduledJob[] = []
    const orphans: Array<{ jobId: string; claim: ScheduledJobRunClaim | undefined }> = []
    let dirty = false
    const nowIso = now.toISOString()

    for (const job of jobs) {
      if (job.state !== 'running') continue
      const claim = job.runClaim
      // Legacy running without claim, or dead owner → interrupt.
      if (claim && isOwnerLive(claim)) continue

      if (claim?.workflowInvocationId && WORKFLOW_UUID_PATTERN.test(claim.workflowInvocationId)) {
        job.runClaim = undefined
        job.state = 'scheduled'
        job.lastStatus = 'waiting'
        job.lastError = undefined
        job.updatedAt = nowIso
        interrupted.push({ ...job })
        dirty = true
        continue
      }

      // A dead owner's claim that had admitted a run is not interrupted here: the Run Engine's own
      // recovery starts, interrupts or marks that run, and the occurrence ends with it.
      if (this.holdAdmittedOccurrence(job, claim, nowIso)) {
        dirty = true
        continue
      }

      const record: ScheduledJobRunRecord = {
        runAt: nowIso,
        status: 'interrupted',
        error: claim
          ? 'Interrupted: scheduler owner process is no longer live'
          : 'Interrupted: running job had no durable owner claim',
        ...claimRecordFields(claim)
      }
      orphans.push({ jobId: job.id, claim })
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
        if (!nextRunAt && job.schedule.kind !== 'manual') {
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
    // A claim that never reached a run leaves its empty per-run thread to be discarded.
    for (const { claim, jobId } of orphans) if (claim && !claim.runId) this.notifyOrphanedThread(jobId, claim)
    return interrupted
  }

  /**
   * A dead or shutting-down claim that had admitted a run (its `runId`, or one its deterministic send
   * receipt names) becomes a pending occurrence the Run Engine settles. False when nothing was admitted
   * or there is no engine to ask; the claim is then interrupted as before.
   */
  private holdAdmittedOccurrence(job: ScheduledJob, claim: ScheduledJobRunClaim | undefined, nowIso: string): boolean {
    const probe = this.probe
    if (!probe || !claim?.occurrenceKey) return false
    let runId = claim.runId
    let threadId = claim.threadId
    if (!runId) {
      const receipt = probe.receipt(scheduledReceiptId(job.id, claim.occurrenceKey))
      runId = receipt?.runId
      threadId = threadId ?? receipt?.threadId
    }
    if (!runId || !threadId) return false
    job.pendingOccurrence = {
      occurrenceKey: claim.occurrenceKey,
      threadId,
      runId,
      ...(claim.queueItemId ? { queueItemId: claim.queueItemId } : {}),
      state: 'admitted'
    }
    job.runHistory = [
      ...(job.runHistory ?? []),
      { runAt: nowIso, status: 'queued' as const, occurrenceKey: claim.occurrenceKey, threadId, runId, ...(claim.queueItemId ? { queueItemId: claim.queueItemId } : {}) }
    ].slice(-20)
    job.runClaim = undefined
    job.state = 'scheduled'
    job.updatedAt = nowIso
    return true
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
      if (!job.enabled || job.state === 'paused' || job.state === 'running' || job.pendingOccurrence) return false
      if (!job.nextRunAt) return false
      return new Date(job.nextRunAt).getTime() <= now.getTime()
    }).length
  }
}
