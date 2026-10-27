import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { SchedulerStatus, ScheduledJob, ScheduledOccurrenceResult, ScheduledWebhookDelivery } from '../../shared/types'
import { join } from 'node:path'
import { TERMINAL_RUN_STATUSES } from '../run/types'
import { isSilentOutput } from './computeNextRun'
import { FileLockBusyError, tryAcquireTickLock } from './fileLock'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import {
  ScheduledJobStore,
  TICKER_INTERVAL_MS,
  recordTickerHeartbeat,
  readTickerHeartbeat,
  type ScheduledRunDetails
} from './ScheduledJobStore'
import type { BackgroundWorkflowTurnResult, ScheduledJobIngress } from '../platform/MmsWorkflowChat'
import { hasPlaceholders, renderPrompt } from './promptPlaceholders'

/** Runs one tick starts at most; a catch-up after downtime follows over the next ticks instead of in one second. */
const MAX_STARTS_PER_TICK = 3
/** How soon the next tick follows a tick that left due jobs behind. */
const CATCH_UP_DELAY_MS = 10_000

export interface ScheduledJobRunner {
  runIsolated(prompt: string, ingress?: ScheduledJobIngress): Promise<BackgroundWorkflowTurnResult>
}

/** How often stored webhook payloads nothing references are swept. */
const PAYLOAD_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Where job webhook secrets are kept (the profile secret store). */
export interface ScheduledWebhookSecrets {
  write(ref: string, value: string): void
  delete(ref: string): void
}

/** A webhook request the job's state or kind cannot take; the message says why and is shown to the person. */
export class ScheduledWebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduledWebhookError'
  }
}

export function webhookSecretRef(jobId: string): string {
  return `scheduled-webhook-${jobId}`
}

/** 256 random bits; the whole string is the HMAC key. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/** What the orchestrator reports when a scheduled turn's Run Engine run ends. */
export interface ScheduledOccurrenceSettled {
  jobId: string
  occurrenceKey: string
  runId: string
  status: ScheduledOccurrenceResult['status']
  /** With `waiting`: when the usage limit the run hit resets. */
  retryAt?: string
  text?: string
  error?: string
  /** The model the run's binding used. */
  selection?: ScheduledRunDetails['selection']
  /** The permission mode the run's binding enforced. */
  permissionMode?: ScheduledRunDetails['permissionMode']
}

export class ScheduledJobService extends EventEmitter {
  private readonly lifecycle = new OwnedWorkBarrier()
  private shutdownPromise?: Promise<void>
  private ticker: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  /** Jobs this service is running now, concurrently; the claim, not this map, decides who owns a run. */
  private inFlight = new Map<string, Promise<void>>()
  /** A wake that arrived during a tick: one more tick runs after it. */
  private wakeRequested = false
  private catchUpTimer: NodeJS.Timeout | null = null
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
  private webhookSecrets: ScheduledWebhookSecrets | null = null
  /** Why the webhook listener is not up (a taken port), shown with the scheduler's errors. */
  private webhookListenerError: string | null = null
  private lastPayloadSweepAt = 0

  constructor(
    private runner: ScheduledJobRunner,
    private store: ScheduledJobStore,
    private threadStore?: ThreadDataStore,
    private projectManager?: ProjectManager
  ) {
    super()
    // A claim that died before its run was admitted may leave an empty per-run thread behind.
    this.store.setOrphanedThreadHandler((orphan) => this.discardOrphanedThread(orphan))
    // A job that is gone (deleted, or its repeat spent) takes its webhook secret with it.
    this.store.setJobRemovedHandler((job) => {
      if (job.trigger?.webhook) this.webhookSecrets?.delete(job.trigger.webhook.secretRef)
    })
  }

  /** True while the scheduler is started: only then does anything start a webhook delivery. */
  isRunning(): boolean {
    return !this.stopped && !this.lifecycle.stopping
  }

  /** Where webhook secrets live; without it a job cannot get a webhook. */
  setWebhookSecrets(secrets: ScheduledWebhookSecrets | null): void {
    this.webhookSecrets = secrets
  }

  /** The webhook listener could not start (or started again); shown in the scheduler status. */
  setWebhookListenerError(message: string | null): void {
    this.webhookListenerError = message
  }

  /**
   * Gives a job a webhook trigger and returns its signing secret, the only time it is shown. Refused for a job
   * that cannot take one (a one-time job, an agent-created job) and for a job that already has one.
   */
  enableWebhook(id: string): { job: ScheduledJob; secret: string } {
    this.lifecycle.assertAccepting()
    const secrets = this.requireWebhookSecrets()
    const job = this.store.getJob(id)
    if (!job) throw new ScheduledWebhookError(`Job not found: ${id}`)
    if (job.createdBy) throw new ScheduledWebhookError('Agent-created jobs cannot have a webhook trigger.')
    if (job.schedule.kind === 'once') throw new ScheduledWebhookError('A one-time job runs once and cannot have a webhook; use a manual job for a webhook-only trigger.')
    if (job.trigger?.webhook) throw new ScheduledWebhookError('This job already has a webhook. Rotate its secret to get a new one.')
    const secretRef = webhookSecretRef(id)
    const secret = generateWebhookSecret()
    secrets.write(secretRef, secret)
    let updated: ScheduledJob | null
    try {
      updated = this.store.setWebhookTrigger(id, { scheme: 'mousse', secretRef, createdAt: new Date().toISOString() })
    } catch (error) {
      secrets.delete(secretRef)
      throw error instanceof Error ? new ScheduledWebhookError(error.message) : error
    }
    if (!updated) {
      secrets.delete(secretRef)
      throw new ScheduledWebhookError(`Job not found: ${id}`)
    }
    this.emitUpdated()
    return { job: updated, secret }
  }

  /** Replaces the job's signing secret at once (the old one stops verifying) and returns the new one, shown only now. */
  rotateWebhook(id: string): { job: ScheduledJob; secret: string } {
    this.lifecycle.assertAccepting()
    const secrets = this.requireWebhookSecrets()
    const trigger = this.store.getJob(id)?.trigger?.webhook
    if (!trigger) throw new ScheduledWebhookError('This job has no webhook to rotate.')
    const secret = generateWebhookSecret()
    secrets.write(trigger.secretRef, secret)
    const updated = this.store.setWebhookTrigger(id, { ...trigger, rotatedAt: new Date().toISOString() })
    if (!updated) throw new ScheduledWebhookError(`Job not found: ${id}`)
    this.emitUpdated()
    return { job: updated, secret }
  }

  /** Takes the webhook off the job: requests stop verifying at once, the secret is deleted, a waiting delivery is dropped. */
  disableWebhook(id: string): ScheduledJob {
    this.lifecycle.assertAccepting()
    const secrets = this.requireWebhookSecrets()
    const trigger = this.store.getJob(id)?.trigger?.webhook
    if (!trigger) throw new ScheduledWebhookError('This job has no webhook.')
    const updated = this.store.setWebhookTrigger(id, undefined)
    if (!updated) throw new ScheduledWebhookError(`Job not found: ${id}`)
    secrets.delete(trigger.secretRef)
    this.emitUpdated()
    return updated
  }

  /** The job's recent webhook requests and what became of each, newest first. */
  listWebhookDeliveries(id: string): ScheduledWebhookDelivery[] {
    if (!this.store.getJob(id)) throw new ScheduledWebhookError(`Job not found: ${id}`)
    return this.store.listWebhookDeliveries(id)
  }

  private requireWebhookSecrets(): ScheduledWebhookSecrets {
    if (!this.webhookSecrets) throw new ScheduledWebhookError('Webhooks are not available in this profile.')
    return this.webhookSecrets
  }

  /** Stored webhook payloads nothing references are removed about once a day. */
  private sweepWebhookPayloadsIfDue(): void {
    const now = Date.now()
    if (now - this.lastPayloadSweepAt < PAYLOAD_SWEEP_INTERVAL_MS) return
    this.lastPayloadSweepAt = now
    try {
      this.store.sweepWebhookPayloads(now)
    } catch {
      /* the next day's sweep retries; leftover files are harmless */
    }
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
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer)
      this.catchUpTimer = null
    }
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

  updateJob(id: string, patch: Partial<ScheduledJob>, options?: Parameters<ScheduledJobStore['updateJob']>[2]): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.updateJob(id, patch, options)
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

  /** "Agents may create jobs" was turned off: the jobs agents created stop until a person resumes them. */
  pauseAgentJobs(): number {
    const paused = this.store.pauseAgentJobs()
    if (paused > 0) this.emitUpdated()
    return paused
  }

  extendJob(id: string, days?: number): ScheduledJob | null {
    this.lifecycle.assertAccepting()
    const job = this.store.extendJob(id, days)
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
   * Runs a tick now (Run now should start within seconds, not at the next minute), or once more after
   * the tick in progress. A no-op while stopped or shutting down.
   */
  wake(): void {
    if (this.stopped || this.lifecycle.stopping) return
    if (this.tickInProgress) {
      this.wakeRequested = true
      return
    }
    void this.tick()
  }

  /**
   * A scheduled turn's run ended (reported by the orchestrator, from whichever process drained the turn).
   * Releases the occurrence, records its outcome and settles a `[SILENT]` per-run thread now, not at the next tick.
   */
  occurrenceSettled(event: ScheduledOccurrenceSettled): void {
    try {
      const before = this.store.getJob(event.jobId)
      const threadId = before?.pendingOccurrence?.occurrenceKey === event.occurrenceKey ? before.pendingOccurrence.threadId : before?.runClaim?.threadId
      const silent = event.status === 'ok' && typeof event.text === 'string' && event.text.trim().startsWith('[SILENT]')
      const job = this.store.completeOccurrence(
        event.jobId,
        event.occurrenceKey,
        { status: event.status, text: event.text, error: event.error, silent, ...(event.retryAt ? { retryAt: event.retryAt } : {}) },
        { runId: event.runId, ...(event.selection ? { selection: event.selection } : {}), ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}) }
      )
      // A finished run on the project's checkout leaves nothing to keep open: its reply is in the run record and
      // the thread stays reachable from it. A new-worktree thread holds the run's work, so it stays open.
      if (threadId && (silent || (event.status === 'ok' && before?.workspace?.kind !== 'newWorktree'))) this.settlePerRunThread(event.jobId, threadId)
      if (job) this.emitUpdated()
    } catch (error) {
      this.lastTickError = error instanceof Error ? error.message : String(error)
    }
  }

  /** A per-run thread that is done leaves the sidebar and stops counting toward the job's cap; only a thread this job made is touched. */
  private settlePerRunThread(jobId: string, threadId: string): void {
    try {
      if (this.threadStore?.getThread(threadId)?.scheduledJobId === jobId) this.threadStore.setThreadSettled(threadId, true)
    } catch {
      /* best effort */
    }
  }

  /**
   * Discards the empty per-run thread of an occurrence that never produced anything. Only a thread this
   * job created, and never while the Run Engine may still start the run that was admitted on it.
   */
  discardOrphanedThread(orphan: { jobId: string; threadId: string; runId?: string }): void {
    try {
      if (this.threadStore?.getThread(orphan.threadId)?.scheduledJobId !== orphan.jobId) return
      if (orphan.runId) {
        const view = this.store.probeRun(orphan.runId)
        if (view === 'unavailable' || (view !== 'absent' && !TERMINAL_RUN_STATUSES.has(view.status))) return
      }
      this.threadStore.discardUnusedThread(orphan.threadId)
    } catch {
      /* the thread has content, or is already gone: it stays */
    }
  }

  /**
   * Status snapshot. Peer lock contention does not throw — preserves last known
   * counts and records lock-busy in lastTickError when needed.
   */
  getStatus(): SchedulerStatus {
    const persisted = readTickerHeartbeat(this.store.homeDir)
    const activeJobIds = [...this.inFlight.keys()]
    const activeJobId = activeJobIds[0] ?? null

    try {
      const jobs = this.store.listJobs()
      this.lastJobCount = jobs.length
      this.lastDueCount = this.store.getDueCount()
      return {
        running: this.ticker !== null && !this.stopped,
        lastHeartbeatAt: this.lastHeartbeatAt ?? persisted.heartbeatAt,
        lastSuccessAt: this.lastSuccessAt ?? persisted.successAt,
        lastTickError: this.lastTickError ?? this.webhookListenerError,
        activeJobId,
        activeJobIds,
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
          activeJobIds,
          jobCount: this.lastJobCount,
          dueCount: this.lastDueCount
        }
      }
      throw err
    }
  }

  private emitUpdated(): void {
    try {
      this.emit('updated', this.listJobs())
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

      // Jobs this process is already running are not claimed again, and a catch-up after downtime starts a few
      // runs per tick, not every overdue job in the same second; the rest stay due and follow shortly.
      this.sweepWebhookPayloadsIfDue()
      const dueJobs = this.store.claimDueJobs(new Date(), { limit: MAX_STARTS_PER_TICK, skipJobIds: new Set(this.inFlight.keys()) })
      if (dueJobs.length >= MAX_STARTS_PER_TICK) this.scheduleCatchUp()
      for (const job of dueJobs) {
        if (job.runClaim) this.ownedRunClaims.set(job.id, job.runClaim.token)
      }
      // Due jobs run concurrently: one long turn must not delay the others, nor the heartbeat.
      for (const job of dueJobs) {
        if (this.lifecycle.stopping) {
          if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted by profile shutdown before execution')
          continue
        }
        if (this.stopped) {
          if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted when scheduling stopped before execution')
          continue
        }
        this.startJob(job)
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
      // A wake that arrived while claims were being taken runs one more tick.
      if (this.wakeRequested) {
        this.wakeRequested = false
        void this.tick()
      }
    }
  }

  /** Another tick soon, for due jobs a bounded start left behind. */
  private scheduleCatchUp(): void {
    if (this.catchUpTimer || this.stopped) return
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null
      this.wake()
    }, CATCH_UP_DELAY_MS)
    this.catchUpTimer.unref?.()
  }

  /** Starts a claimed job without waiting for it; the claim, not the tick, owns the run until it is finalized. */
  private startJob(job: ScheduledJob): void {
    if (this.inFlight.has(job.id)) {
      // Not reachable through `claimDueJobs` (it skips these jobs), but a claim that is not run must not stay held.
      if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted: the previous run of this job was still finishing')
      return
    }
    let run: Promise<void>
    try {
      run = this.lifecycle.run('scheduled-run', () => this.executeJob(job))
    } catch (error) {
      // The profile started shutting down between the claim and its start.
      if (job.runClaim) this.interruptOwnedRun(job.id, job.runClaim.token, 'Interrupted by profile shutdown before execution')
      this.lastTickError = error instanceof Error ? error.message : String(error)
      return
    }
    const tracked = run.catch((error) => {
      this.lastTickError = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      if (this.inFlight.get(job.id) === tracked) this.inFlight.delete(job.id)
    })
    this.inFlight.set(job.id, tracked)
  }

  /**
   * The prompt this occurrence sends. Only a webhook delivery fills placeholders, from the body its request stored.
   * Whether the prompt is a workflow is decided on the template, never on the filled text; a workflow takes no
   * webhook data, so a workflow template with placeholders is refused rather than given untrusted arguments.
   */
  private promptFor(
    job: ScheduledJob,
    claim: ScheduledJob['runClaim']
  ): { error?: undefined; prompt: string; missing: string[] } | { error: string; prompt?: undefined; missing?: undefined } {
    const occurrenceId = claim?.webhookOccurrenceId
    if (!occurrenceId || !hasPlaceholders(job.prompt)) return { prompt: job.prompt, missing: [] }
    if (job.prompt.trimStart().startsWith('/')) return { error: 'A workflow prompt cannot use webhook placeholders.' }
    const bodyText = this.store.readWebhookBody(job.id, occurrenceId)
    if (bodyText === undefined) return { error: 'The webhook request this run needs is no longer stored.' }
    const rendered = renderPrompt(job.prompt, { bodyText })
    return { prompt: rendered.prompt, missing: rendered.missing }
  }

  /** Why the job cannot run because a thread it depends on is gone or archived; undefined when it can. Needs the thread store. */
  private goneThread(job: ScheduledJob): string | undefined {
    const store = this.threadStore
    if (!store) return undefined
    try {
      if (job.threadId) {
        const thread = store.getThread(job.threadId)
        if (!thread) return 'Its thread was deleted'
        if (thread.settledAt) return 'Its thread was archived'
      }
      if (job.createdBy && !store.getThread(job.createdBy.threadId)) return 'The thread that created it was deleted'
    } catch {
      return undefined
    }
    return undefined
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    this.emitUpdated()
    const claim = job.runClaim
    const claimToken = claim?.token

    try {
      // `occurrenceKey` is `nextRunAt` for a timed claim; a legacy claim written before it existed falls back to that.
      const occurrenceKey = claim?.occurrenceKey ?? job.nextRunAt
      if (!occurrenceKey) throw new Error('Scheduled job occurrence is missing')
      // An agent may not start a slash workflow, however the job reached the store.
      if (job.createdBy && job.prompt.trim().startsWith('/')) {
        if (claimToken && this.store.isRunClaimCurrent(job.id, claimToken)) {
          this.store.markJobRun(job.id, false, undefined, 'Agent-created jobs cannot run workflows', false, claimToken)
        }
        return
      }
      // A job whose thread is gone (or that an agent made from a thread that is gone) pauses with a reason once, instead of
      // failing on every tick for ever. A person resumes it after choosing another thread.
      const gone = this.goneThread(job)
      if (gone) {
        if (claimToken && this.store.isRunClaimCurrent(job.id, claimToken)) {
          this.store.markJobRun(job.id, false, undefined, gone, false, claimToken)
          this.store.pauseJob(job.id, gone)
          this.emitUpdated()
        }
        return
      }
      // A webhook delivery fills `{{body...}}` placeholders from its stored body; any other run leaves them as written.
      const rendered = this.promptFor(job, claim)
      if (rendered.error !== undefined) {
        if (claimToken && this.store.isRunClaimCurrent(job.id, claimToken)) {
          this.store.markJobRun(job.id, false, undefined, rendered.error, false, claimToken)
        }
        return
      }
      const missingPlaceholders = rendered.missing
      const result = await this.runner.runIsolated(rendered.prompt, {
        jobId: job.id,
        occurrenceAt: occurrenceKey,
        occurrenceKey,
        threadId: job.threadId,
        projectId: job.projectId,
        createThread: job.createThread,
        jobName: job.name,
        selection: job.selection,
        mode: job.mode,
        workspace: job.workspace,
        permissionMode: job.permissionMode,
        permissionCeiling: job.permissionCeiling,
        accessCap: job.accessCap,
        claim: { threadId: claim?.threadId, runId: claim?.runId },
        resumeWaiting: job.runClaim?.resumedWaiting === true,
        onWorkflowPrepared: (invocationId) => {
          if (!claimToken || !this.store.markWorkflowClaim(job.id, claimToken, invocationId)) {
            throw new Error('Scheduled workflow claim was lost before admission')
          }
        },
        onThreadChosen: (threadId) => {
          if (!claimToken || !this.store.markClaimThread(job.id, claimToken, threadId)) {
            throw new Error('Scheduled claim was lost before its thread was chosen')
          }
        },
        onAdmitted: (runId) => {
          if (!claimToken || !this.store.markOccurrenceAdmitted(job.id, claimToken, runId)) {
            throw new Error('Scheduled claim was lost before its run was recorded')
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

      // A turn on a thread: the run record says where it ran and with what.
      const missingDetails: ScheduledRunDetails = missingPlaceholders.length ? { missingPlaceholders } : {}
      const details: ScheduledRunDetails | undefined = result.threadId
        ? {
            threadId: result.threadId,
            ...(result.runId ? { runId: result.runId } : {}),
            ...(result.queueItemId ? { queueItemId: result.queueItemId } : {}),
            ...(result.selection ? { selection: result.selection } : {}),
            mode: job.mode ?? 'agent',
            ...(result.permissionMode ? { permissionMode: result.permissionMode } : {}),
            ...(job.workspace ? { workspace: job.workspace } : {}),
            ...missingDetails
          }
        : missingPlaceholders.length ? missingDetails : undefined

      if (result.status === 'queued' || result.status === 'replayed') {
        // Admitted, not finished: the job is held until its run is terminal.
        if (!this.store.markQueuedOccurrence(job.id, claimToken, result.queueItemId, details)) {
          this.store.markJobRun(job.id, false, undefined, 'The scheduled run was admitted without a recorded run', false, claimToken, undefined, details)
        }
        return
      }

      if (result.error && result.threadId) this.discardOrphanedThread({ jobId: job.id, threadId: result.threadId, runId: result.runId })

      const silent = result.silent || (!result.threadId && isSilentOutput(result.text))
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
        result.waiting ? 'waiting' : undefined,
        details
      )
      if (silent && result.threadId) this.settlePerRunThread(job.id, result.threadId)
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
