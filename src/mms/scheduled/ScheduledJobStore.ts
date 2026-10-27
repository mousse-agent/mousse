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
  ScheduledJobWebhookTrigger,
  ScheduledOccurrenceResult,
  ScheduledWebhookDelivery,
  ScheduledWebhookDeliveryOutcome
} from '../../shared/types'
import { atomicWriteJsonSync } from '../data/AtomicFs'
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
import { isPermissionMode, normalizePermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { computeNextRun } from './computeNextRun'
import { withFileLock } from './fileLock'
import { permissionAboveCeiling } from './jobPermission'
import {
  ReceiptsUnreadableError,
  appendDelivery,
  readDeliveries,
  readReceipts,
  readTriggerPayload,
  removeJobTriggerFiles,
  removeTriggerPayload,
  resetReceipts,
  sweepTriggerPayloads,
  updateDelivery,
  writeReceipts,
  writeTriggerPayload
} from './webhookFiles'

export const TICKER_INTERVAL_MS = 60_000

/** A webhook request's timestamp may differ from the daemon's clock by this much (seconds), either way. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300
/** Signature-valid requests one job accepts per minute; further ones are answered 429. */
export const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60
/** A receipt is kept while its timestamp could still pass the freshness check, plus a minute of clock slack. */
const WEBHOOK_RECEIPT_RETENTION_S = WEBHOOK_TIMESTAMP_TOLERANCE_S + 60
/**
 * Receipts one job keeps at most. A receipt is never dropped while its timestamp can still pass the freshness
 * check: at the cap the job refuses new requests instead (see `saturatedUntil`).
 */
const MAX_WEBHOOK_RECEIPTS = 2000
/** A refusal of the same kind is logged at most this often per job, so a flood cannot churn the log file. */
const REFUSAL_LOG_INTERVAL_MS = 1000

const WEBHOOK_OCCURRENCE_PREFIX = 'webhook:'

export function webhookOccurrenceKey(occurrenceId: string): string {
  return WEBHOOK_OCCURRENCE_PREFIX + occurrenceId
}

/** The delivery an occurrence key names, or undefined for a timed or manual occurrence. */
export function webhookIdOfOccurrence(occurrenceKey: string | undefined): string | undefined {
  return occurrenceKey?.startsWith(WEBHOOK_OCCURRENCE_PREFIX) ? occurrenceKey.slice(WEBHOOK_OCCURRENCE_PREFIX.length) : undefined
}

/** What the store did with a signature-verified webhook request (the listener maps it to an HTTP status). */
export type WebhookTriggerResult =
  | { kind: 'accepted'; occurrenceId: string }
  | { kind: 'unknown' }
  | { kind: 'replay' | 'rate_limited' | 'running' | 'pending' | 'paused' }
  /** The replay record cannot be read: nothing is accepted until it is repaired. */
  | { kind: 'unavailable' }

/** The log outcome of an occurrence that ended, and whether the run it had (if any) is the reason. */
function deliveryOutcomeOf(result: ScheduledOccurrenceResult, hadRun: boolean): { outcome: ScheduledWebhookDeliveryOutcome; error?: string } {
  if (result.status === 'ok') return { outcome: 'completed' }
  if (result.status === 'uncertain') return { outcome: 'uncertain', error: result.error }
  return { outcome: hadRun ? 'failed' : 'dispatch_failed', error: result.error }
}

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
  Pick<ScheduledJobRunRecord, 'threadId' | 'runId' | 'queueItemId' | 'selection' | 'mode' | 'permissionMode' | 'workspace' | 'missingPlaceholders'>
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
    pendingTrigger: job.pendingTrigger,
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
    pendingTrigger: runtime?.pendingTrigger,
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
  private onJobRemoved: ((job: ScheduledJob) => void) | null = null
  /** When a refusal of each kind was last written to a job's log (`<jobId>:<outcome>`). */
  private readonly lastRefusalLogAt = new Map<string, number>()

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

  /** Called after a job is gone for good (deleted, or its repeat was spent), so its webhook secret can be removed too. */
  setJobRemovedHandler(handler: ((job: ScheduledJob) => void) | null): void {
    this.onJobRemoved = handler
  }

  private notifyJobRemoved(job: ScheduledJob): void {
    removeJobTriggerFiles(this.homeDir, job.id)
    try {
      this.onJobRemoved?.(job)
    } catch {
      /* best effort: a secret left behind belongs to a job that no longer exists and verifies nothing */
    }
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

  /**
   * Writes the runtime file, durably (the file and its folder are synced before the rename is trusted). Every
   * replacement of it goes through here, so a crash cannot lose what an earlier acknowledged write recorded, such
   * as a webhook delivery waiting to start.
   */
  private saveRuntimeDurably(jobs: ScheduledJob[]): void {
    const runtimeMap: Record<string, ScheduledJobRuntime> = {}
    for (const job of jobs) runtimeMap[job.id] = extractRuntime(job)
    atomicWriteJsonSync(join(this.homeDir, 'scheduled', 'jobs-runtime.json'), runtimeMap)
  }

  private saveJobs(jobs: ScheduledJob[]): void {
    // A job paused while its run was in flight settles as paused once the run's claim is gone.
    for (const job of jobs) {
      if (job.state === 'scheduled' && job.pausedAt && !job.enabled && !job.runClaim) job.state = 'paused'
    }
    const definitions = jobs.map((job) => jobToDefinition(job))
    this.config.updateScheduledSection({ jobs: definitions })
    this.saveRuntimeDurably(jobs)
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.listJobs().find((job) => job.id === id)
  }

  createJob(input: CreateScheduledJobInput): ScheduledJob {
    const now = new Date().toISOString()
    const nextRunAt = computeNextRun(input.schedule)
    const tooWide = permissionAboveCeiling(input.permissionMode, input.permissionCeiling)
    if (tooWide) throw new Error(tooWide)
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
      permissionMode: input.permissionMode,
      permissionCeiling: input.permissionCeiling,
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
      // However an edit of the mode or ceiling arrives, a job's mode never exceeds its ceiling. (A job the file
      // already holds out of range is not made un-editable for other changes; the run narrows it anyway.)
      if ('permissionMode' in patch || 'permissionCeiling' in patch) {
        const tooWide = permissionAboveCeiling(updated.permissionMode, updated.permissionCeiling)
        if (tooWide) throw new Error(tooWide)
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

  /**
   * Gives every job that has no permission ceiling one (jobs saved before ceilings existed). `ceilingFor` says
   * what a job's creator is taken to have held: the mode threads start in, or the target thread's mode. A job
   * it cannot answer for gets `ask`. Jobs that already have a ceiling are not touched, so this is safe to run
   * on every start. Returns how many jobs it stamped.
   */
  stampMissingPermissionCeilings(ceilingFor: (job: ScheduledJob) => PermissionMode): number {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      let stamped = 0
      for (const job of jobs) {
        if (isPermissionMode(job.permissionCeiling)) continue
        let ceiling: PermissionMode
        try {
          ceiling = normalizePermissionMode(ceilingFor(job))
        } catch {
          ceiling = 'ask'
        }
        job.permissionCeiling = ceiling
        stamped += 1
      }
      if (stamped > 0) this.saveJobs(jobs)
      return stamped
    })
  }

  deleteJob(id: string): boolean {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const next = jobs.filter((job) => job.id !== id)
      if (next.length === jobs.length) return false
      this.saveJobs(next)
      const removed = jobs.find((job) => job.id === id)
      if (removed) this.notifyJobRemoved(removed)
      return true
    })
  }

  // ── Webhook trigger ────────────────────────────────────────────────────

  /** Puts a webhook trigger on a job, or takes it off (`undefined`) and drops the delivery that was waiting. */
  setWebhookTrigger(id: string, trigger: ScheduledJobWebhookTrigger | undefined): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job) return null
      if (trigger && job.schedule.kind === 'once') throw new Error('A one-time job runs once and cannot have a webhook; use a manual job for a webhook-only trigger.')
      const dropped = trigger ? undefined : job.pendingTrigger
      // A new or rotated secret verifies no earlier signature, so the old replay record goes with it. This is also
      // how an unreadable replay record is repaired.
      if (trigger) resetReceipts(this.homeDir, job.id)
      job.trigger = trigger ? { webhook: trigger } : undefined
      if (dropped) job.pendingTrigger = undefined
      job.updatedAt = new Date().toISOString()
      this.saveJobs(jobs)
      if (dropped) {
        this.settleWebhookDelivery(job.id, webhookOccurrenceKey(dropped.occurrenceId), { outcome: 'dispatch_failed', error: 'Dropped: the webhook was disabled before the run started' })
      }
      return job
    })
  }

  /**
   * A webhook request whose signature has been verified. Under the jobs lock: a request already seen is a
   * replay; every other request consumes a durable receipt first (so a request answered 409 or 429 can never be
   * delivered later, and senders re-sign a retry with a fresh timestamp); then the rate limit, the job's
   * state and the single pending slot decide; an accepted delivery's payload and pending slot are on disk
   * before this returns.
   *
   * Receipts live in their own file, synced on every write. One that is there and unreadable is never treated as
   * empty: the request is refused (`unavailable`) until the file is repaired. A receipt is never dropped while its
   * timestamp could still verify; when the file is full of such receipts the job refuses requests, unrecorded,
   * until none of them could be replayed (`saturatedUntil`).
   */
  triggerFromWebhook(jobId: string, request: { ts: number; sig: string; body: Buffer; now?: number }): WebhookTriggerResult {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === jobId)
      // A job an agent created never takes a webhook (decision: no inbound trigger for agent-made jobs).
      if (!job?.trigger?.webhook || job.createdBy) return { kind: 'unknown' }

      const nowMs = request.now ?? Date.now()
      const nowSec = Math.floor(nowMs / 1000)
      const nowIso = new Date(nowMs).toISOString()
      const bodyBytes = request.body.length
      let record
      try {
        record = readReceipts(this.homeDir, job.id)
      } catch (error) {
        if (error instanceof ReceiptsUnreadableError) return { kind: 'unavailable' }
        throw error
      }
      const receipts = record.receipts.filter((receipt) => receipt.ts >= nowSec - WEBHOOK_RECEIPT_RETENTION_S)

      if (receipts.some((receipt) => receipt.sig === request.sig)) {
        this.logRefusal(job.id, 'replay', { receivedAt: nowIso, bodyBytes })
        return { kind: 'replay' }
      }
      if (record.saturatedUntil !== undefined && nowSec < record.saturatedUntil) {
        this.logRefusal(job.id, 'rate_limited', { receivedAt: nowIso, bodyBytes, error: 'Too many requests are recorded; none is accepted for a few minutes' })
        return { kind: 'rate_limited' }
      }
      if (receipts.length >= MAX_WEBHOOK_RECEIPTS) {
        // This request cannot be recorded, so it must not be deliverable later: refuse everything until a request
        // with any timestamp it could have carried is stale.
        writeReceipts(this.homeDir, job.id, { receipts, saturatedUntil: nowSec + 2 * WEBHOOK_TIMESTAMP_TOLERANCE_S + 60 })
        this.logRefusal(job.id, 'rate_limited', { receivedAt: nowIso, bodyBytes, error: 'Too many requests are recorded; none is accepted for a few minutes' })
        return { kind: 'rate_limited' }
      }
      receipts.push({ ts: request.ts, sig: request.sig, at: nowMs })
      // The receipt is durable before any answer, whatever the answer is.
      writeReceipts(this.homeDir, job.id, { receipts })
      const refuse = (kind: 'rate_limited' | 'running' | 'pending' | 'paused', error?: string): WebhookTriggerResult => {
        this.logRefusal(job.id, kind, { receivedAt: nowIso, bodyBytes, ...(error ? { error } : {}) })
        return { kind }
      }

      if (receipts.filter((receipt) => receipt.at > nowMs - 60_000).length > WEBHOOK_RATE_LIMIT_PER_MINUTE) return refuse('rate_limited')
      if (job.state === 'running' || job.runClaim) return refuse('running', 'The job is running')
      if (job.pendingOccurrence) {
        return refuse('running', job.pendingOccurrence.state === 'queued' ? 'The job has a run waiting in a queue' : 'The job has a run in progress')
      }
      if (job.pendingTrigger) return refuse('pending', 'Another delivery is waiting to start')
      if (!job.enabled || job.state === 'paused') return refuse('paused', 'The job is paused')

      const occurrenceId = uuidv4()
      // The payload is stored before the slot that names it: a slot never points at a file that is not there.
      writeTriggerPayload(this.homeDir, { occurrenceId, jobId: job.id, receivedAt: nowIso, bodyBytes, body: request.body.toString('utf-8') })
      job.pendingTrigger = { occurrenceId, receivedAt: nowIso }
      try {
        this.saveRuntimeDurably(jobs)
      } catch (error) {
        removeTriggerPayload(this.homeDir, job.id, occurrenceId)
        throw error
      }
      this.logDelivery(job.id, { occurrenceId, receivedAt: nowIso, outcome: 'accepted', bodyBytes })
      return { kind: 'accepted', occurrenceId }
    })
  }

  /**
   * A request that failed verification, for the job's log. Called after the answer has gone out. The per-job
   * throttle is checked first, outside the jobs lock, so a flood costs a map lookup, not file work.
   */
  recordWebhookRejection(jobId: string, outcome: 'rejected_signature' | 'too_large', bodyBytes: number): void {
    if (!this.refusalLogDue(jobId, outcome)) return
    try {
      withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
        const job = this.listJobs().find((entry) => entry.id === jobId)
        if (!job?.trigger?.webhook) return
        this.logDelivery(job.id, { outcome, receivedAt: new Date().toISOString(), bodyBytes })
      })
    } catch {
      /* the log is a courtesy; the request was refused either way */
    }
  }

  /** The job's delivery log, newest first. */
  listWebhookDeliveries(jobId: string): ScheduledWebhookDelivery[] {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      return this.getJob(jobId) ? readDeliveries(this.homeDir, jobId) : []
    })
  }

  /**
   * The request body a webhook delivery stored, as text: `undefined` when the payload is gone. Only the body is
   * kept; the request's headers are never stored.
   */
  readWebhookBody(jobId: string, occurrenceId: string): string | undefined {
    return readTriggerPayload(this.homeDir, jobId, occurrenceId)?.body
  }

  /** Removes stored payloads nothing references any more (called about once a day). Returns how many files went. */
  sweepWebhookPayloads(now = Date.now()): number {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      return sweepTriggerPayloads(this.homeDir, {
        jobIds: new Set(jobs.map((job) => job.id)),
        now,
        isReferenced: (jobId, occurrenceId) => {
          const job = jobs.find((entry) => entry.id === jobId)
          if (!job) return false
          const key = webhookOccurrenceKey(occurrenceId)
          return job.pendingTrigger?.occurrenceId === occurrenceId
            || job.runClaim?.webhookOccurrenceId === occurrenceId
            || job.pendingOccurrence?.occurrenceKey === key
        }
      })
    })
  }

  private logDelivery(jobId: string, row: ScheduledWebhookDelivery): void {
    try {
      appendDelivery(this.homeDir, jobId, row)
    } catch {
      /* the log is not the delivery: the request is already durable */
    }
  }

  /** True when a refusal of this kind for this job may be written now; records that it was. */
  private refusalLogDue(jobId: string, outcome: ScheduledWebhookDeliveryOutcome): boolean {
    const key = `${jobId}:${outcome}`
    const at = Date.now()
    if (at - (this.lastRefusalLogAt.get(key) ?? 0) < REFUSAL_LOG_INTERVAL_MS) return false
    this.lastRefusalLogAt.set(key, at)
    return true
  }

  private logRefusal(jobId: string, outcome: ScheduledWebhookDeliveryOutcome, row: Omit<ScheduledWebhookDelivery, 'outcome'>): void {
    if (!this.refusalLogDue(jobId, outcome)) return
    this.logDelivery(jobId, { ...row, outcome })
  }

  /** Moves a webhook delivery's log row to `result`; an ended delivery's stored payload goes with it. */
  private settleWebhookDelivery(
    jobId: string,
    occurrenceKey: string | undefined,
    result: { outcome: ScheduledWebhookDeliveryOutcome; error?: string },
    options: { keepPayload?: boolean; missingPlaceholders?: string[] } = {}
  ): void {
    const occurrenceId = webhookIdOfOccurrence(occurrenceKey)
    if (!occurrenceId) return
    try {
      updateDelivery(this.homeDir, jobId, occurrenceId, {
        ...result,
        ...(options.missingPlaceholders?.length ? { missingPlaceholders: options.missingPlaceholders } : {})
      })
    } catch {
      /* the log is a courtesy */
    }
    if (!options.keepPayload) removeTriggerPayload(this.homeDir, jobId, occurrenceId)
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
      const droppedDeliveries: Array<{ jobId: string; occurrenceId: string }> = []

      for (const job of jobs) {
        // A delivery that was accepted and then the job was paused does not run later, when it is stale.
        if (job.pendingTrigger && (!job.enabled || job.state === 'paused') && job.state !== 'running' && !job.runClaim) {
          droppedDeliveries.push({ jobId: job.id, occurrenceId: job.pendingTrigger.occurrenceId })
          job.pendingTrigger = undefined
          dirty = true
        }
        if (!job.enabled || job.state === 'paused' || job.state === 'running' || job.runClaim) continue
        // A job this process is already running is not claimed again: the caller would drop the claim.
        if (options.skipJobIds?.has(job.id)) continue
        // A bounded start (catch-up after downtime): the rest stay due for the next tick.
        if (options.limit !== undefined && due.length >= options.limit) break
        // One outstanding occurrence per job, held until its run is terminal.
        if (job.pendingOccurrence) continue
        // A verified webhook delivery is due whatever the job's own timer says, and does not move that timer.
        if (job.pendingTrigger) {
          const { occurrenceId } = job.pendingTrigger
          job.pendingTrigger = undefined
          job.state = 'running'
          job.runClaim = { ...newRunClaim(webhookOccurrenceKey(occurrenceId)), webhookOccurrenceId: occurrenceId }
          due.push({ ...job, runClaim: { ...job.runClaim } })
          dirty = true
          continue
        }
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
      for (const { jobId, occurrenceId } of droppedDeliveries) {
        this.settleWebhookDelivery(jobId, webhookOccurrenceKey(occurrenceId), { outcome: 'dispatch_failed', error: 'Dropped: the job was paused before the run started' })
      }

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
    // Whether the occurrence ever had a run decides if a webhook delivery "failed" or "never dispatched".
    const hadRun = Boolean(details?.runId ?? job.runClaim?.runId ?? job.pendingOccurrence?.runId ?? (existing >= 0 ? history[existing].runId : undefined))
    if (existing >= 0) history[existing] = { ...history[existing], ...record, runAt: history[existing].runAt }
    else history.push(record)
    job.runHistory = history.slice(-20)
    job.lastRunAt = nowIso
    job.lastStatus = result.status
    job.lastError = result.status === 'ok' ? undefined : result.error
    job.runClaim = undefined
    job.pendingOccurrence = undefined
    job.updatedAt = nowIso

    // A webhook delivery ends with its occurrence: its log row gets the outcome and its payload is deleted.
    const webhook = webhookIdOfOccurrence(occurrenceKey) !== undefined
    if (webhook) this.settleWebhookDelivery(job.id, occurrenceKey, deliveryOutcomeOf(result, hadRun), { missingPlaceholders: details?.missingPlaceholders })

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
        if (index >= 0) {
          jobs.splice(index, 1)
          this.notifyJobRemoved(job)
        }
        return
      }
    }
    const wasPaused = job.state === 'paused'
    // A delivery does not move the job's own timer: an interval or cron job keeps its cadence.
    if (webhook) {
      if (!wasPaused) job.state = 'scheduled'
      return
    }
    const nextRunAt = computeNextRun(job.schedule, nowIso)
    job.nextRunAt = nextRunAt
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
      this.settleWebhookDelivery(job.id, claim.occurrenceKey, { outcome: 'queued' }, { keepPayload: true, missingPlaceholders: details?.missingPlaceholders })
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
      const webhook = webhookIdOfOccurrence(claim.occurrenceKey) !== undefined
      if (webhook) {
        // A delivery never moves the job's own timer.
        job.state = 'scheduled'
      } else if (job.schedule.kind === 'once') {
        job.enabled = false
        job.state = 'error'
        job.nextRunAt = null
      } else {
        job.nextRunAt = computeNextRun(job.schedule, now)
        job.state = job.nextRunAt ? 'scheduled' : job.schedule.kind === 'manual' ? 'scheduled' : 'error'
      }
      job.updatedAt = now
      this.saveJobs(jobs)
      this.settleWebhookDelivery(id, claim.occurrenceKey, { outcome: claim.runId ? 'failed' : 'dispatch_failed', error: reason })
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
    const deliveriesToSettle: Array<{ jobId: string; occurrenceKey: string | undefined; hadRun: boolean; error?: string }> = []
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

      if (webhookIdOfOccurrence(claim?.occurrenceKey) !== undefined) {
        // A delivery never moves the job's own timer; its log row and stored payload end with the claim.
        job.state = 'scheduled'
        deliveriesToSettle.push({ jobId: job.id, occurrenceKey: claim?.occurrenceKey, hadRun: Boolean(claim?.runId), error: record.error })
      } else if (job.schedule.kind === 'once') {
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
    for (const { jobId, occurrenceKey, hadRun, error } of deliveriesToSettle) {
      this.settleWebhookDelivery(jobId, occurrenceKey, { outcome: hadRun ? 'failed' : 'dispatch_failed', error })
    }
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
      if (job.pendingTrigger) return true
      if (!job.nextRunAt) return false
      return new Date(job.nextRunAt).getTime() <= now.getTime()
    }).length
  }
}
