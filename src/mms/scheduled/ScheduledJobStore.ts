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
  ScheduledMissedRuns,
  ScheduledOccurrenceResult,
  ScheduledWebhookDelivery,
  ScheduledWebhookDeliveryOutcome,
  ScheduledEventLogEntry,
  ThreadEventKind
} from '../../shared/types'
import { THREAD_EVENT_KINDS } from '../../shared/types'
import { THREAD_EVENT_MIN_GAP_MS, threadEventOccurrenceKey, threadEventsOfOccurrence } from '../../shared/threadEvents'
import { DEFAULT_USAGE_LIMIT_PAUSE_CAP } from '../../shared/settings'
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
import { isPermissionMode, narrowPermissionMode, normalizePermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { agentJobExpiredReason, isExpired } from './agentJobLimits'
import { computeNextRun, nextOccurrenceAfter, occurrencesSince } from './computeNextRun'
import { botJobThreadGuard } from './botJobs'
import { withFileLock } from './fileLock'
import { isWorkflowPrompt, JobPermissionRefused, permissionAboveCeiling, type JobPermissionEdit } from './jobPermission'
import {
  ReceiptsUnreadableError,
  appendDelivery,
  hasTriggerPayload,
  keptPayloadIds,
  pruneTriggerPayloads,
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
import { requestRefusal, takesRequests } from '../../shared/requestTrigger'

export const TICKER_INTERVAL_MS = 60_000

/** What starting, resuming or enabling a draft is told: only Turn on makes a draft an automation. */
export const DRAFT_REFUSAL = 'It is a draft. Turn it on first.'

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
/** Pull request events a thread-event job remembers for "(why?)". */
const MAX_EVENT_LOG = 10
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
  // The delivery was consumed and did not run: the job's own timer is untouched, as for any delivery.
  return { outcome: hadRun ? 'failed' : 'dispatch_failed', error: result.error }
}

/** The Run Engine run an occurrence is held by, as the scheduler reads it. */
export interface ScheduledRunView {
  status: RunStatus
  threadId: string
  /** The run's own error text, when it ended with one. */
  error?: string
  /** A run that failed on a provider usage limit: when the limit resets. */
  usageLimitUntil?: string
}

/** Consecutive occurrences of a job that may wait for a usage limit before the next one is an error. */
export const SCHEDULED_USAGE_LIMIT_WAIT_CAP = DEFAULT_USAGE_LIMIT_PAUSE_CAP

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
  Pick<ScheduledJobRunRecord, 'threadId' | 'runId' | 'queueItemId' | 'selection' | 'mode' | 'permissionMode' | 'workspace' | 'missingPlaceholders' | 'agent' | 'missingKey'>
>

export function scheduledReceiptId(jobId: string, occurrenceKey: string): string {
  return 'schedule:' + jobId + ':' + occurrenceKey
}

/** The occurrence outcome a terminal Run Engine run maps to. */
export function occurrenceResultOfRun(run: Pick<ScheduledRunView, 'status' | 'error' | 'usageLimitUntil'>): ScheduledOccurrenceResult {
  switch (run.status) {
    case 'completed':
      return { status: 'ok' }
    case 'failed':
      // A usage limit is a wait for the reset, not a failure of the job.
      if (run.usageLimitUntil) return { status: 'waiting', retryAt: run.usageLimitUntil, error: run.error ?? 'The provider\'s usage limit was reached' }
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

function atomicWriteEpoch(path: string, at: Date = new Date()): void {
  ensureScheduledDir(dirname(path))
  const tmpPath = join(dirname(path), `.hb_${process.pid}_${Date.now()}.tmp`)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, String(at.getTime() / 1000))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

export function recordTickerHeartbeat(success = false, homeDir = getMousseHomeDir(), at: Date = new Date()): void {
  try {
    atomicWriteEpoch(join(homeDir, 'scheduled', 'ticker_heartbeat'), at)
    if (success) {
      atomicWriteEpoch(join(homeDir, 'scheduled', 'ticker_last_success'), at)
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

/** The fields an older build's save drops, kept aside for `restoreDroppedFields`. */
type KeptJobFields = Pick<ScheduledJob, 'bot' | 'draft' | 'keys' | 'tellMe' | 'agent' | 'cliName'>
const KEPT_FIELDS_FILE = 'jobs-kept.json'
/** What an older build pauses a bot's schedule with: the thread its job names does not exist. */
const GUARD_PAUSE = 'Its thread was deleted'

function keptFieldsOf(job: ScheduledJob): KeptJobFields {
  return {
    ...(job.bot ? { bot: job.bot } : {}),
    ...(job.draft ? { draft: job.draft } : {}),
    ...(job.keys?.length ? { keys: job.keys } : {}),
    ...(job.tellMe ? { tellMe: job.tellMe } : {}),
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.cliName ? { cliName: job.cliName } : {})
  }
}

/**
 * The run records of a job an agent created say so. Every record is saved through here, so a record written by any
 * path (a finished run, a queued occurrence, an interrupted claim) carries the label without each writer knowing.
 */
/**
 * The fields that pause a job. A running job keeps its running state and claim: the run in flight must be able to
 * finish. It settles as paused when it ends (`saveJobs`), and no further occurrence is claimed meanwhile.
 */
function pauseFields(job: ScheduledJob, reason?: string, resumeAt?: string): Partial<ScheduledJob> {
  return {
    enabled: false,
    ...(job.state === 'running' ? {} : { state: 'paused' as const }),
    pausedAt: new Date().toISOString(),
    pausedReason: reason,
    // A pause with an end resumes on its own then; a pause without one clears an earlier end.
    resumeAt
  }
}

/** The fields that resume a job from its schedule. A running job stays running until its claim is finalized. */
function resumeFields(job: ScheduledJob): Partial<ScheduledJob> {
  if (job.state === 'running') return { enabled: true, pausedAt: undefined, pausedReason: undefined, resumeAt: undefined }
  const nextRunAt = computeNextRun(job.schedule)
  return {
    enabled: true,
    state: nextRunAt || job.schedule.kind === 'manual' ? 'scheduled' : 'completed',
    pausedAt: undefined,
    pausedReason: undefined,
    resumeAt: undefined,
    nextRunAt
  }
}

function labelAgentRuns(job: ScheduledJob): ScheduledJob['runHistory'] {
  if (!job.createdBy) return job.runHistory
  return job.runHistory?.map((record) => (record.agentCreated ? record : { ...record, agentCreated: true as const }))
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
    resumeAt: job.resumeAt,
    waitingBehind: job.waitingBehind,
    botSkip: job.botSkip,
    runHistory: labelAgentRuns(job),
    runClaim: job.runClaim,
    pendingOccurrence: job.pendingOccurrence,
    pendingTrigger: job.pendingTrigger,
    pendingEvent: job.pendingEvent,
    lastEventRunAt: job.lastEventRunAt,
    eventLog: job.eventLog,
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
    resumeAt: runtime?.resumeAt,
    waitingBehind: runtime?.waitingBehind,
    botSkip: runtime?.botSkip,
    runHistory: runtime?.runHistory ?? [],
    runClaim: runtime?.runClaim,
    pendingOccurrence: runtime?.pendingOccurrence,
    pendingTrigger: runtime?.pendingTrigger,
    pendingEvent: runtime?.pendingEvent,
    lastEventRunAt: runtime?.lastEventRunAt,
    eventLog: runtime?.eventLog,
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
    ...(claim.missed ? { missed: claim.missed } : {}),
    ...(claim.threadId ? { threadId: claim.threadId } : {}),
    ...(claim.runId ? { runId: claim.runId } : {})
  }
}

/**
 * A gap this long between two scheduler ticks (one a minute) means the scheduler was not running: Mousse was closed,
 * or the computer off or asleep. A run this late is not one a busy tick delayed.
 */
export const MISSED_GRACE_MS = 5 * 60_000

/** When the scheduler was last down: from its last tick before the gap to its first tick after it. */
export interface SchedulerDowntime {
  from: string
  to: string
}

/**
 * The repeats a job missed while its computer was off, when the occurrence it is about to run is one of them: it fell
 * due while the scheduler was down (after its last tick before the gap, by the persisted heartbeat) and is more than a
 * few minutes late. They collapse into this one run, which runs once and says so ("Missed while offline"). A run a
 * busy scheduler delayed, however long, fell due while it was ticking and is never marked.
 */
export function missedWhileOffline(job: Pick<ScheduledJob, 'schedule'>, dueAt: string, now: Date, downtime?: SchedulerDowntime): ScheduledMissedRuns | undefined {
  if (job.schedule.kind === 'manual' || !downtime) return undefined
  const due = Date.parse(dueAt)
  if (!Number.isFinite(due) || now.getTime() - due <= MISSED_GRACE_MS) return undefined
  if (due <= Date.parse(downtime.from) || due > Date.parse(downtime.to)) return undefined
  return { count: occurrencesSince(job.schedule, dueAt, now), since: new Date(due).toISOString() }
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
    this.saveKeptFields(jobs)
  }

  /**
   * A copy of the fields an older build drops when it saves the jobs (its field list does not know them), in a file it
   * never writes. `restoreDroppedFields` puts them back when this build opens the profile again.
   */
  private saveKeptFields(jobs: ScheduledJob[]): void {
    const kept: Record<string, KeptJobFields> = {}
    for (const job of jobs) {
      const fields = keptFieldsOf(job)
      if (Object.keys(fields).length) kept[job.id] = fields
    }
    const path = join(this.homeDir, 'scheduled', KEPT_FIELDS_FILE)
    try {
      if (!Object.keys(kept).length && !existsSync(path)) return
      atomicWriteJsonSync(path, { version: 1, jobs: kept })
    } catch (error) {
      // The jobs themselves are saved; only the copy an older build's save could need is behind.
      console.warn('scheduled jobs: the copy of fields older builds drop could not be written', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * After a profile was opened by an older build that saved the jobs: puts back each job's fields that build dropped
   * (`bot`, `draft`, `keys`, `tellMe`, `agent`, `cliName`), from the copy this build keeps. A bot's schedule that build
   * paused because its guard thread does not exist ("Its thread was deleted") runs again. A field is put back only on
   * a job that has none of the kept ones, so an edit this build made is never undone. Returns the ids put back.
   */
  restoreDroppedFields(): string[] {
    const path = join(this.homeDir, 'scheduled', KEPT_FIELDS_FILE)
    if (!existsSync(path)) return []
    let kept: Record<string, KeptJobFields>
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: Record<string, KeptJobFields> }
      kept = parsed && typeof parsed.jobs === 'object' && parsed.jobs ? parsed.jobs : {}
    } catch {
      return []
    }
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const restored: string[] = []
      for (const job of jobs) {
        const fields = kept[job.id]
        if (!fields || typeof fields !== 'object') continue
        if (Object.keys(keptFieldsOf(job)).length) continue
        Object.assign(job, fields)
        if (fields.bot && job.threadId === botJobThreadGuard(fields.bot.botId) && job.pausedReason === GUARD_PAUSE) Object.assign(job, resumeFields(job))
        restored.push(job.id)
      }
      if (restored.length) this.saveJobs(jobs)
      return restored
    })
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.listJobs().find((job) => job.id === id)
  }

  /**
   * Adds a job. `options.id` keeps an id the job already had elsewhere (a bot's schedule moved from `bots.db`): a job
   * with that id already here is returned as it is, so a repeated move adds nothing. `options.nextRunAt` keeps the next
   * run it had there.
   */
  createJob(input: CreateScheduledJobInput, options: { id?: string; nextRunAt?: string | null; createdAt?: string } = {}): ScheduledJob {
    const now = new Date().toISOString()
    // A draft is stored, never enabled and never due: Turn on gives it its first next run.
    const nextRunAt = input.draft ? null : options.nextRunAt !== undefined ? options.nextRunAt : computeNextRun(input.schedule)
    // A mode with no ceiling to bound it gets the strictest ceiling, and the mode is brought down to it.
    const permissionCeiling = input.permissionCeiling ?? (input.permissionMode ? 'ask' : undefined)
    const permissionMode = input.permissionMode && !input.permissionCeiling ? narrowPermissionMode(input.permissionMode, 'ask') : input.permissionMode
    const tooWide = permissionAboveCeiling(permissionMode, permissionCeiling)
    if (tooWide) throw new JobPermissionRefused(tooWide)
    const job: ScheduledJob = {
      id: options.id ?? uuidv4(),
      name: input.name.trim() || 'Scheduled job',
      prompt: input.prompt.trim(),
      schedule: input.schedule,
      enabled: !input.draft && !input.paused,
      state: input.draft || input.paused ? 'paused' : nextRunAt || input.schedule.kind === 'manual' ? 'scheduled' : 'completed',
      nextRunAt,
      ...(input.paused ? { pausedAt: now, ...(input.paused.reason ? { pausedReason: input.paused.reason } : {}), ...(input.paused.until ? { resumeAt: input.paused.until } : {}) } : {}),
      threadId: input.threadId,
      projectId: input.projectId,
      createThread: input.createThread,
      selection: input.selection,
      ...(input.agent && !isWorkflowPrompt(input.prompt) ? { agent: { definitionId: input.agent.definitionId } } : {}),
      ...(input.bot ? { bot: { botId: input.bot.botId, scheduleId: input.bot.scheduleId, createdBy: input.bot.createdBy, ...(input.bot.model ? { model: input.bot.model } : {}) } } : {}),
      mode: input.mode,
      workspace: input.workspace,
      permissionMode,
      permissionCeiling,
      ...(input.tellMe ? { tellMe: input.tellMe } : {}),
      createdBy: input.createdBy,
      accessCap: input.accessCap,
      expiresAt: input.expiresAt,
      ...(input.keys?.length ? { keys: [...new Set(input.keys)] } : {}),
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.cliName ? { cliName: input.cliName } : {}),
      ...(input.threadEvent ? { trigger: { threadEvent: { threadId: input.threadEvent.threadId, number: input.threadEvent.number, events: [...input.threadEvent.events] } } } : {}),
      repeat: input.repeat ? { times: input.repeat.times, completed: 0 } : undefined,
      runHistory: [],
      createdAt: options.createdAt ?? now,
      updatedAt: now
    }

    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const existing = options.id ? jobs.find((entry) => entry.id === options.id) : undefined
      if (existing) return existing
      jobs.push(job)
      this.saveJobs(jobs)
      return job
    })
  }

  /**
   * Edits a job. `options.permissions` works out the job's mode and ceiling from the job as it is stored now, under
   * the lock, so two edits at once cannot write back a ceiling the other had just lowered.
   */
  updateJob(id: string, patch: Partial<ScheduledJob>, options?: { permissions?: (current: ScheduledJob) => JobPermissionEdit }): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const index = jobs.findIndex((job) => job.id === id)
      if (index === -1) return null

      // A draft never runs: nothing turns it on but Turn on, which clears `draft` in the same change.
      if (jobs[index].draft && patch.enabled === true && !('draft' in patch && patch.draft === undefined)) throw new Error(DRAFT_REFUSAL)
      let applied = patch
      if (options?.permissions) {
        const edit = options.permissions(jobs[index])
        if (!edit.ok) throw new JobPermissionRefused(edit.error)
        if (edit.changed) applied = { ...patch, permissionMode: edit.permissionMode, permissionCeiling: edit.permissionCeiling }
      }
      const updated: ScheduledJob = {
        ...jobs[index],
        ...applied,
        id: jobs[index].id,
        updatedAt: new Date().toISOString()
      }
      // However an edit arrives, a job's mode never exceeds its ceiling, and a mode with no ceiling gets the strictest. (A job the file already holds out of range is not made un-editable for other
      // changes; the run narrows it anyway.)
      if ('permissionMode' in applied || 'permissionCeiling' in applied || 'prompt' in applied) {
        if (updated.permissionMode && !updated.permissionCeiling) {
          updated.permissionCeiling = 'ask'
          updated.permissionMode = narrowPermissionMode(updated.permissionMode, 'ask')
        }
        const tooWide = permissionAboveCeiling(updated.permissionMode, updated.permissionCeiling)
        if (tooWide) throw new JobPermissionRefused(tooWide)
      }
      // A workflow runs itself: a prompt that becomes a workflow drops the saved agent.
      if (updated.agent && isWorkflowPrompt(updated.prompt)) delete updated.agent
      // A schedule edit that adds or removes the clock moves the next run with it.
      if (patch.schedule && !('nextRunAt' in patch) && (patch.schedule.kind === 'manual') !== (jobs[index].schedule.kind === 'manual')) {
        updated.nextRunAt = computeNextRun(patch.schedule)
        if (updated.state !== 'paused' && updated.state !== 'running') updated.state = updated.nextRunAt || patch.schedule.kind === 'manual' ? 'scheduled' : 'completed'
      }
      // An edit that turns the job off or on pauses or resumes it, unless the caller already set the pause fields
      // itself (`pauseJob`, `resumeJob`, `triggerJob`).
      if (patch.enabled !== undefined && patch.enabled !== jobs[index].enabled && !('pausedAt' in patch) && !('state' in patch)) {
        const fields = patch.enabled ? resumeFields(updated) : pauseFields(updated)
        if (patch.enabled && 'nextRunAt' in patch) delete fields.nextRunAt
        Object.assign(updated, fields)
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
      if (trigger && job.trigger?.threadEvent) throw new Error('It wakes on its pull request, so it takes no request URL.')
      const dropped = trigger ? undefined : job.pendingTrigger
      // A new or rotated secret verifies no earlier signature, so the old replay record goes with it. This is also
      // how an unreadable replay record is repaired.
      if (trigger) resetReceipts(this.homeDir, job.id)
      job.trigger = trigger ? { ...job.trigger, webhook: trigger } : job.trigger?.threadEvent ? { threadEvent: job.trigger.threadEvent } : undefined
      if (dropped) job.pendingTrigger = undefined
      job.updatedAt = new Date().toISOString()
      this.saveJobs(jobs)
      if (dropped) {
        this.settleWebhookDelivery(job.id, webhookOccurrenceKey(dropped.occurrenceId), { outcome: 'dispatch_failed', error: 'Dropped: the webhook was disabled before the run started' })
      }
      // Turned off: the payloads kept for Resend go (a run in flight already read its own); the log stays.
      if (!trigger) pruneTriggerPayloads(this.homeDir, job.id, new Set(this.referencedPayloads(job)))
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
      // A job an agent created takes no request until the person keeps it (Keep removes its end).
      if (!job?.trigger?.webhook || !takesRequests(job)) return { kind: 'unknown' }

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
      this.pruneKeptPayloads(job)
      return { kind: 'accepted', occurrenceId }
    })
  }

  /**
   * Resend (a person's choice): starts the job again with the payload an earlier delivery stored, as a new delivery in
   * its log. No signature is checked (the person asked, over the owner's protocol), and the request rules that protect
   * the URL do not apply; the job's own state does: one delivery at a time, never while paused or running.
   */
  resendWebhook(jobId: string, occurrenceId: string, now = Date.now()): { occurrenceId: string } {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === jobId)
      if (!job) throw new Error('This automation is gone.')
      if (!job.trigger?.webhook) throw new Error('It has no request URL now.')
      const refusal = requestRefusal(job)
      if (refusal) throw new Error(refusal)
      if (job.state === 'running' || job.runClaim || job.pendingOccurrence) throw new Error('It is running. Resend once the run ends.')
      if (job.pendingTrigger) throw new Error('Another request is waiting to start.')
      if (!job.enabled || job.state === 'paused') throw new Error('It is paused. Resume it first.')
      const stored = readTriggerPayload(this.homeDir, job.id, occurrenceId)
      if (!stored) throw new Error('That request is no longer stored.')
      const nowIso = new Date(now).toISOString()
      const next = uuidv4()
      writeTriggerPayload(this.homeDir, { occurrenceId: next, jobId: job.id, receivedAt: nowIso, bodyBytes: stored.bodyBytes, body: stored.body })
      job.pendingTrigger = { occurrenceId: next, receivedAt: nowIso }
      try {
        this.saveRuntimeDurably(jobs)
      } catch (error) {
        removeTriggerPayload(this.homeDir, job.id, next)
        throw error
      }
      this.logDelivery(job.id, { occurrenceId: next, receivedAt: nowIso, outcome: 'accepted', bodyBytes: stored.bodyBytes, resentFrom: occurrenceId })
      this.pruneKeptPayloads(job)
      return { occurrenceId: next }
    })
  }

  /**
   * Pull request events for a thread-event job (`ThreadEventTriggers` decided they are its own and not caused by its
   * own run). They wait in one pending slot until the rate limit allows a run (one per `minGapMs`, counted from the last
   * run events started), and a later event joins the slot. A paused job ignores them; `own` logs one that was ignored
   * because the job's own run caused it. Every outcome is logged for "(why?)". Returns what became of them.
   */
  queueThreadEvent(
    jobId: string,
    kinds: ThreadEventKind[],
    options: { now?: Date; minGapMs?: number; own?: string } = {}
  ): ScheduledEventLogEntry['outcome'] | 'unknown' {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === jobId)
      if (!job?.trigger?.threadEvent || !kinds.length) return 'unknown'
      const now = options.now ?? new Date()
      const nowIso = now.toISOString()
      const log = (entry: Omit<ScheduledEventLogEntry, 'at' | 'kinds'>): void => {
        job.eventLog = [...(job.eventLog ?? []), { at: nowIso, kinds, ...entry }].slice(-MAX_EVENT_LOG)
      }
      let outcome: ScheduledEventLogEntry['outcome']
      if (options.own) {
        outcome = 'own'
        log({ outcome, reason: options.own })
      } else if (!job.enabled || job.state === 'paused') {
        outcome = 'paused'
        log({ outcome })
      } else {
        const gap = options.minGapMs ?? THREAD_EVENT_MIN_GAP_MS
        const last = Date.parse(job.lastEventRunAt ?? '')
        const allowed = Number.isFinite(last) ? Math.max(now.getTime(), last + gap) : now.getTime()
        const pending = job.pendingEvent
        const dueAt = pending ? pending.dueAt : new Date(allowed).toISOString()
        job.pendingEvent = {
          kinds: THREAD_EVENT_KINDS.filter((kind) => kinds.includes(kind) || pending?.kinds.includes(kind)),
          firstAt: pending?.firstAt ?? nowIso,
          dueAt
        }
        // A run in flight holds the slot too: the events wait for it to end, then for the rate limit.
        const held = Date.parse(dueAt) > now.getTime() || job.state === 'running' || Boolean(job.runClaim) || Boolean(job.pendingOccurrence)
        outcome = held ? 'held' : 'started'
        log(held ? { outcome, until: dueAt } : { outcome })
      }
      job.updatedAt = nowIso
      this.saveRuntimeDurably(jobs)
      return outcome
    })
  }

  /** Whether a delivery's payload is still stored, so Resend can run it again. */
  hasWebhookPayload(jobId: string, occurrenceId: string): boolean {
    return hasTriggerPayload(this.homeDir, jobId, occurrenceId)
  }

  /** The occurrence ids a job's state still names: a delivery waiting, claimed or admitted. Caller holds the lock. */
  private referencedPayloads(job: ScheduledJob): string[] {
    return [job.pendingTrigger?.occurrenceId, job.runClaim?.webhookOccurrenceId, webhookIdOfOccurrence(job.pendingOccurrence?.occurrenceKey)]
      .filter((id): id is string => Boolean(id))
  }

  /** Keeps the payloads of the newest accepted deliveries (Resend) and of any delivery in flight; the rest go. */
  private pruneKeptPayloads(job: ScheduledJob): void {
    try {
      pruneTriggerPayloads(this.homeDir, job.id, new Set([...keptPayloadIds(this.homeDir, job.id), ...this.referencedPayloads(job)]))
    } catch {
      /* the daily sweep retries */
    }
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
          // A delivery in flight, or one of the newest the job keeps for Resend.
          return this.referencedPayloads(job).includes(occurrenceId) || (Boolean(job.trigger?.webhook) && keptPayloadIds(this.homeDir, jobId).has(occurrenceId))
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

  /**
   * Moves a webhook delivery's log row to `result`. Its stored payload stays for Resend while the delivery is among the
   * newest the job keeps (`MAX_KEPT_PAYLOADS`); a newer delivery prunes it.
   */
  private settleWebhookDelivery(
    jobId: string,
    occurrenceKey: string | undefined,
    result: { outcome: ScheduledWebhookDeliveryOutcome; error?: string },
    options: { missingPlaceholders?: string[] } = {}
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
  }

  /** Pauses a job, until a person resumes it or, with `resumeAt`, until then. */
  pauseJob(id: string, reason?: string, resumeAt?: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.getJob(id)
      if (!job) return null
      return this.updateJob(id, pauseFields(job, reason, resumeAt))
    })
  }

  resumeJob(id: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.getJob(id)
      if (!job) return null
      if (job.draft) throw new Error(DRAFT_REFUSAL)
      return this.updateJob(id, resumeFields(job))
    })
  }

  /**
   * Gives a job `days` more from now (a person's choice: an agent has no way to call this). A job that ended because its
   * time ran out starts running again on its schedule; a finished one-time job stays finished.
   */
  extendJob(id: string, days: number = this.config.agentJobLimits().lifetimeDays): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.getJob(id)
      if (!job) return null
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      const ended = job.state === 'completed' && job.schedule.kind !== 'once' && isExpired(job)
      const nextRunAt = ended ? computeNextRun(job.schedule, job.lastRunAt) : undefined
      return this.updateJob(id, {
        expiresAt,
        ...(ended ? { state: 'scheduled' as const, nextRunAt: nextRunAt ?? null, lastError: undefined } : {})
      })
    })
  }

  /**
   * Keep (a person's choice): an automation an agent added loses only its end, the lifetime limit. Its access, its
   * frequency and the agent's right to add more are untouched. One that ended because its time ran out starts again on
   * its schedule; a finished one-time job stays finished. A job a person made has no end and is refused.
   */
  keepJob(id: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const job = this.getJob(id)
      if (!job) return null
      if (!job.createdBy) throw new Error('Only an automation an agent added has an end to remove.')
      const ended = job.state === 'completed' && job.schedule.kind !== 'once' && isExpired(job)
      const nextRunAt = ended ? computeNextRun(job.schedule, job.lastRunAt) : undefined
      return this.updateJob(id, {
        expiresAt: undefined,
        ...(ended ? { state: 'scheduled' as const, nextRunAt: nextRunAt ?? null, lastError: undefined } : {})
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
    if (current?.draft) throw new Error(DRAFT_REFUSAL)
    return this.updateJob(id, {
      enabled: true,
      state: 'scheduled',
      pausedAt: undefined,
      pausedReason: undefined,
      resumeAt: undefined,
      nextRunAt: new Date().toISOString()
    })
  }

  /**
   * Atomically claim due jobs for execution. Each claimed job receives a durable
   * runClaim (pid + process instance + token). Live running claims are never stolen.
   */
  claimDueJobs(now = new Date(), options: { limit?: number; skipJobIds?: ReadonlySet<string>; downtime?: SchedulerDowntime } = {}): ScheduledJob[] {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      // Reconcile dead running owners before taking new claims (same lock section).
      this.reconcileStaleRunningJobsUnlocked(now)

      const jobs = this.listJobs()
      const due: ScheduledJob[] = []
      const lifetimeDays = this.config.agentJobLimits().lifetimeDays
      // An occurrence whose run ended (or can never start) is released before its job is considered.
      const released: Array<{ jobId: string; threadId: string; runId: string }> = []
      let dirty = this.reconcilePendingOccurrences(jobs, now.toISOString(), released)
      const droppedDeliveries: Array<{ jobId: string; occurrenceId: string }> = []

      for (const job of jobs) {
        // A pause with an end is over once its time has come: the job resumes on its schedule from now.
        if (job.state === 'paused' && job.resumeAt && Date.parse(job.resumeAt) <= now.getTime() && !job.runClaim) {
          Object.assign(job, resumeFields(job), { updatedAt: now.toISOString() })
          dirty = true
        }
        // A delivery that was accepted and then the job was paused does not run later, when it is stale.
        if (job.pendingTrigger && (!job.enabled || job.state === 'paused') && job.state !== 'running' && !job.runClaim) {
          droppedDeliveries.push({ jobId: job.id, occurrenceId: job.pendingTrigger.occurrenceId })
          job.pendingTrigger = undefined
          dirty = true
        }
        // Pull request events waiting when the job was paused do not run later either.
        if (job.pendingEvent && (!job.enabled || job.state === 'paused') && job.state !== 'running' && !job.runClaim) {
          job.pendingEvent = undefined
          dirty = true
        }
        // An idle job an agent created ends once its time is up; it does not start again by itself, so a person keeps it.
        if (job.state !== 'running' && !job.runClaim && !job.pendingOccurrence) {
          if (job.expiresAt && job.state !== 'completed' && isExpired(job, now)) {
            job.state = 'completed'
            job.nextRunAt = null
            job.lastError = agentJobExpiredReason(lifetimeDays)
            dirty = true
            continue
          }
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
        // Pull request events start a run once the rate limit allows it; it does not move the job's own timer.
        if (job.pendingEvent && Date.parse(job.pendingEvent.dueAt) <= now.getTime()) {
          const { kinds, firstAt } = job.pendingEvent
          job.pendingEvent = undefined
          job.lastEventRunAt = now.toISOString()
          job.state = 'running'
          job.runClaim = newRunClaim(threadEventOccurrenceKey(firstAt, kinds))
          due.push({ ...job, runClaim: { ...job.runClaim } })
          dirty = true
          continue
        }
        if (!job.nextRunAt) continue
        if (new Date(job.nextRunAt).getTime() > now.getTime()) continue
        const resumedWaiting = job.lastStatus === 'waiting'
        const missed = resumedWaiting || job.waitingBehind ? undefined : missedWhileOffline(job, job.nextRunAt, now, options.downtime)
        job.state = 'running'
        job.runClaim = { ...newRunClaim(job.nextRunAt), ...(resumedWaiting ? { resumedWaiting: true } : {}), ...(missed ? { missed } : {}) }
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
    // A usage limit makes the job wait for the reset instead of taking its next slot inside the window. After
    // `SCHEDULED_USAGE_LIMIT_WAIT_CAP` waits in a row the next one is an error, so a limit that never lifts is seen.
    if (result.status === 'waiting') {
      let waits = 0
      const earlier = job.runHistory ?? []
      for (let index = earlier.length - 1; index >= 0 && earlier[index].usageLimitUntil; index -= 1) waits += 1
      if (waits >= SCHEDULED_USAGE_LIMIT_WAIT_CAP)
        result = { status: 'error', error: `Usage limit reached ${waits + 1} times in a row; the job did not run. ${result.error ?? ''}`.trim() }
    }
    const waiting = result.status === 'waiting'
    const record: ScheduledJobRunRecord = {
      runAt: nowIso,
      status: result.status,
      output: result.status === 'ok' ? result.text : undefined,
      error: result.status === 'ok' ? undefined : result.error,
      silent: result.silent,
      ...(waiting && result.retryAt ? { usageLimitUntil: result.retryAt } : {}),
      ...(occurrenceKey ? { occurrenceKey } : {}),
      ...(job.runClaim?.missed ? { missed: job.runClaim.missed } : {}),
      ...(job.runClaim?.claimedAt ? { startedAt: job.runClaim.claimedAt } : {}),
      endedAt: nowIso,
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
    // A wait is not an error: the job shows it as waiting, with no error text to repeat.
    job.lastError = result.status === 'ok' || waiting ? undefined : result.error
    job.runClaim = undefined
    job.pendingOccurrence = undefined
    job.waitingBehind = undefined
    job.updatedAt = nowIso

    // A webhook delivery ends with its occurrence: its log row gets the outcome and its payload is deleted.
    const webhook = webhookIdOfOccurrence(occurrenceKey) !== undefined
    if (webhook) this.settleWebhookDelivery(job.id, occurrenceKey, deliveryOutcomeOf(result, hadRun), { missingPlaceholders: details?.missingPlaceholders })

    // Waiting for a usage limit spends no repeat. The job runs again at the reset (a delivery never moves the job's own timer).
    if (waiting) {
      if (!webhook) {
        // A manual job has no timer: it runs when it is triggered again.
        job.nextRunAt = job.schedule.kind === 'manual'
          ? null
          : result.retryAt && Date.parse(result.retryAt) > Date.parse(nowIso) ? result.retryAt : computeNextRun(job.schedule, nowIso)
      }
      if (job.state !== 'paused') job.state = 'scheduled'
      return
    }
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
    return this.updateClaim(id, claimToken, (claim, job) => {
      claim.runId = runId
      job.waitingBehind = undefined
    })
  }

  private updateClaim(id: string, claimToken: string, write: (claim: ScheduledJobRunClaim, job: ScheduledJob) => void): boolean {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || job.runClaim?.token !== claimToken) return false
      write(job.runClaim, job)
      this.saveJobs(jobs)
      return true
    })
  }

  /**
   * The claimed occurrence could not start because its bound thread is running a turn (#404). The claim goes back
   * without a run record: the job stays due with the same occurrence, keeps its repeat, and says it waits behind that
   * thread's run until a tick finds the thread free. A webhook delivery goes back to waiting to start.
   */
  deferBusyClaim(id: string, claimToken: string, threadId: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      const claim = job?.runClaim
      if (!job || !claim || job.state !== 'running' || claim.token !== claimToken || claim.runId) return null
      const now = new Date().toISOString()
      if (claim.webhookOccurrenceId) job.pendingTrigger = { occurrenceId: claim.webhookOccurrenceId, receivedAt: now }
      // Pull request events go back to waiting, due at once: the rate limit already let them start.
      const events = threadEventsOfOccurrence(claim.occurrenceKey)
      if (events?.length) job.pendingEvent = { kinds: events, firstAt: claim.claimedAt, dueAt: now }
      job.runClaim = undefined
      job.state = 'scheduled'
      job.waitingBehind = { threadId, since: job.waitingBehind?.threadId === threadId ? job.waitingBehind.since : now }
      job.updatedAt = now
      this.saveJobs(jobs)
      return job
    })
  }

  /**
   * A bot's occurrence was handed to the bot, whose run lane runs it, or was skipped (`skipped` says why). The claim
   * ends without a run record (the bot's activations are its runs) and the schedule moves on; occurrences missed while
   * Mousse was closed collapse into this one, so a backlog never runs.
   */
  finishBotClaim(id: string, claimToken: string, outcome: { skipped?: string }, now: Date = new Date()): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      const claim = job?.runClaim
      if (!job?.bot || !claim || job.state !== 'running' || claim.token !== claimToken) return null
      const occurrenceAt = claim.occurrenceKey
      job.runClaim = undefined
      job.botSkip = outcome.skipped ? { at: occurrenceAt, reason: outcome.skipped } : undefined
      if (!outcome.skipped) {
        job.lastRunAt = occurrenceAt
        job.lastStatus = 'ok'
        job.lastError = undefined
      }
      job.nextRunAt = nextOccurrenceAfter(job.schedule, occurrenceAt, now)
      job.state = job.nextRunAt ? 'scheduled' : 'error'
      if (!job.nextRunAt) job.lastError = 'Failed to compute next run'
      job.updatedAt = now.toISOString()
      this.saveJobs(jobs)
      return job
    })
  }

  /** A claim that could not be handled yet (the bots are still starting) goes back as it was: the same occurrence stays due. */
  releaseClaim(id: string, claimToken: string): ScheduledJob | null {
    return withFileLock(join(this.homeDir, 'scheduled', '.jobs.lock'), () => {
      const jobs = this.listJobs()
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.state !== 'running' || job.runClaim?.token !== claimToken || job.runClaim.runId) return null
      job.runClaim = undefined
      job.state = 'scheduled'
      job.updatedAt = new Date().toISOString()
      this.saveJobs(jobs)
      return job
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
        { runAt: now, status: 'queued' as const, occurrenceKey: claim.occurrenceKey, startedAt: claim.claimedAt, ...(claim.missed ? { missed: claim.missed } : {}), ...details, threadId, runId, ...(queueItemId ? { queueItemId } : {}) }
      ].slice(-20)
      job.pendingOccurrence = {
        occurrenceKey: claim.occurrenceKey,
        threadId,
        runId,
        ...(queueItemId ? { queueItemId } : {}),
        state: queueItemId ? 'queued' : 'admitted'
      }
      job.runClaim = undefined
      job.waitingBehind = undefined
      job.state = 'scheduled'
      job.updatedAt = now
      this.settleWebhookDelivery(job.id, claim.occurrenceKey, { outcome: 'queued' }, { missingPlaceholders: details?.missingPlaceholders })
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
        const record: ScheduledJobRunRecord = { runAt: now, status: 'waiting', output, silent, ...(job.runClaim.missed ? { missed: job.runClaim.missed } : {}) }
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
