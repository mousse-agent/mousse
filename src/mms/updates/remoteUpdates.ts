import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isFinishedPhase,
  remoteUpdateLimits,
  type RemoteUpdateError,
  type RemoteUpdateJob,
  type RemoteUpdateLimits,
  type RemoteUpdatePhase,
  type RemoteUpdateStatus
} from '../../shared/remoteUpdates'

/** The computer asking, as the Net method saw it. */
export interface UpdateRequester {
  node: string
  name: string
  /** Asked again right before installing: the requester still has Full control here and is not blocked. */
  stillAllowed(): boolean
}

interface Job extends RemoteUpdateJob {
  node: string
  rollout?: string
  expiresAt: number
  stillAllowed(): boolean
}

/** What the app's main process may report while it prepares a request. */
export type AppProgress =
  | { phase: 'preparing'; percent?: number }
  | { phase: 'ready' }
  | { phase: 'failed'; error: RemoteUpdateError }

export type BeginAnswer =
  /** Install now. */
  | { go: true }
  /** Not now: the countdown has not ended, or more turns run than were confirmed (`waiting`). Ask again later. */
  | { go: false; wait: true; job: RemoteUpdateJob }
  /** Never: the request is over (`job.error` says why). */
  | { go: false; wait: false; job: RemoteUpdateJob | null }

/**
 * Update requests from the user's other computers, for one Mousse home (#476). The service keeps the request; the
 * desktop app, which alone can install, takes requests only while it holds a registration on its own connection
 * (`attach`), so a computer whose app is not running says it does not take them, and a request fails if the app goes.
 * One request at a time. Running turns are counted across every profile of the service.
 */
export class RemoteUpdates {
  private app: string | null = null
  private job: Job | null = null
  private readonly now: () => number
  private readonly limits: RemoteUpdateLimits
  private readonly newId: () => string
  activeTurns: () => number = () => 0
  /** Tells the app to read the request again. */
  notify: () => void = () => undefined

  constructor(opts: { now?: () => number; limits?: RemoteUpdateLimits; newId?: () => string } = {}) {
    this.now = opts.now ?? Date.now
    this.limits = opts.limits ?? remoteUpdateLimits()
    this.newId = opts.newId ?? randomUUID
  }

  /** The desktop app is running and takes requests now. */
  accepts(): boolean {
    return this.app !== null
  }

  // ------------------------------------------------------------------ the app on this computer

  /** The app takes requests until its connection closes (`detach`). */
  attach(connection: string): RemoteUpdateJob | null {
    this.app = connection
    return this.current()
  }

  /** The app stopped taking requests: one under way fails, so it never installs without the app's countdown. */
  detach(connection: string): void {
    if (this.app !== connection) return
    this.app = null
    const job = this.live()
    if (job && job.phase !== 'installing') this.finish(job, 'failed', 'not_accepting')
  }

  /** The request, as the app shows it; null when there is none or it is over. */
  current(): RemoteUpdateJob | null {
    const job = this.live()
    return job && !isFinishedPhase(job.phase) ? this.view(job) : null
  }

  progress(connection: string, id: string, report: AppProgress): RemoteUpdateJob | null {
    const job = this.live()
    if (this.app !== connection || !job || job.id !== id || job.phase !== 'preparing' && job.phase !== 'ready') return this.current()
    if (report.phase === 'failed') this.finish(job, 'failed', report.error)
    else if (report.phase === 'ready') this.set(job, { phase: 'ready', percent: 100 })
    else if (report.percent !== undefined && report.percent !== job.percent) job.percent = report.percent
    return this.current()
  }

  /**
   * The countdown ended: install now? Not before `installAt`; not while more turns run than the asking computer
   * confirmed; never once the request is over, expired, or the asking computer lost Full control here.
   */
  begin(connection: string, id: string): BeginAnswer {
    const job = this.live()
    if (this.app !== connection || !job || job.id !== id) return { go: false, wait: false, job: job ? this.view(job) : null }
    if (job.phase !== 'countdown' && job.phase !== 'waiting') return { go: false, wait: false, job: this.view(job) }
    if (!this.allowed(job)) {
      this.finish(job, 'failed', 'forbidden')
      return { go: false, wait: false, job: this.view(job) }
    }
    if (this.now() < (job.installAt ?? 0)) return { go: false, wait: true, job: this.view(job) }
    if (this.turns() > (job.consentedTurns ?? 0)) {
      if (job.phase !== 'waiting') this.set(job, { phase: 'waiting' })
      return { go: false, wait: true, job: this.view(job) }
    }
    this.set(job, { phase: 'installing' })
    return { go: true }
  }

  /** Cancel on this computer (the countdown's Cancel), or the app could not install. */
  cancelHere(id: string, error: RemoteUpdateError = 'cancelled'): void {
    const job = this.live()
    if (job?.id === id && !isFinishedPhase(job.phase)) this.finish(job, error === 'cancelled' ? 'cancelled' : 'failed', error)
  }

  // ------------------------------------------------------------------ the asking computer (`update.*`)

  /** `update.prepare`: answers at once; the app downloads, and `update.status` shows how far. */
  prepare(from: UpdateRequester, version: string, rollout?: string): RemoteUpdateStatus {
    const running = this.live()
    if (running && !isFinishedPhase(running.phase)) {
      // The same ask again (a retry) gets the same request.
      if (running.node === from.node && running.version === version && running.rollout === rollout) return this.status(from.node, running.id)
      return this.refusal('busy')
    }
    if (!this.accepts()) return this.refusal('not_accepting')
    const job: Job = {
      id: this.newId(),
      version,
      from: from.name,
      node: from.node,
      ...(rollout ? { rollout } : {}),
      phase: 'preparing',
      expiresAt: this.now() + this.limits.requestTtlMs,
      stillAllowed: from.stillAllowed
    }
    this.job = job
    this.notify()
    return this.status(from.node, job.id)
  }

  /** `update.status`: what changes, for the computer that asked only. */
  status(node: string, id: string): RemoteUpdateStatus {
    const job = this.live()
    if (!job || job.id !== id || job.node !== node) return this.refusal('unknown_job', id)
    return {
      job: job.id,
      phase: job.phase,
      runningTurns: this.turns(),
      ...(job.percent !== undefined && job.phase === 'preparing' ? { percent: job.percent } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.installAt !== undefined ? { installAt: job.installAt } : {})
    }
  }

  /**
   * `update.install`: the asking computer confirmed, having seen `consentedTurns` running. The countdown starts here;
   * the call's ledger saves the answer before it is sent, and the app stops the service only once the countdown ends.
   */
  install(node: string, id: string, consentedTurns: number): RemoteUpdateStatus {
    const job = this.live()
    if (!job || job.id !== id || job.node !== node) return this.refusal('unknown_job', id)
    // The service stops only when the countdown ends, long after this answer is saved and sent.
    if (job.phase === 'ready')
      this.set(job, { phase: 'countdown', installAt: this.now() + this.limits.countdownMs, consentedTurns })
    return this.status(node, id)
  }

  /** `update.cancel` from the asking computer; an install under way can't be taken back. */
  cancel(node: string, id: string): RemoteUpdateStatus {
    const job = this.live()
    if (!job || job.id !== id || job.node !== node) return this.refusal('unknown_job', id)
    if (job.phase !== 'installing' && !isFinishedPhase(job.phase)) this.finish(job, 'cancelled', 'cancelled')
    return this.status(node, id)
  }

  // ------------------------------------------------------------------ internals

  /** The request, after its time ran out if it did. */
  private live(): Job | null {
    const job = this.job
    if (job && !isFinishedPhase(job.phase) && job.phase !== 'installing' && this.now() > job.expiresAt)
      this.finish(job, 'failed', 'expired')
    return this.job
  }

  private allowed(job: Job): boolean {
    try {
      return job.stillAllowed()
    } catch {
      return false
    }
  }

  private turns(): number {
    try {
      return Math.max(0, this.activeTurns())
    } catch {
      return 0
    }
  }

  private refusal(error: RemoteUpdateError, job = ''): RemoteUpdateStatus {
    return { job, phase: 'failed', error, runningTurns: this.turns() }
  }

  private finish(job: Job, phase: Extract<RemoteUpdatePhase, 'failed' | 'cancelled'>, error: RemoteUpdateError): void {
    this.set(job, { phase, error })
  }

  private set(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch)
    this.notify()
  }

  private view(job: Job): RemoteUpdateJob {
    return {
      id: job.id,
      version: job.version,
      from: job.from,
      phase: job.phase,
      ...(job.percent !== undefined ? { percent: job.percent } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.installAt !== undefined ? { installAt: job.installAt } : {}),
      ...(job.consentedTurns !== undefined ? { consentedTurns: job.consentedTurns } : {})
    }
  }
}

const hubs = new Map<string, RemoteUpdates>()

/** The one hub of a Mousse home in this process: every profile's Net and the app's registration share it. */
export function remoteUpdatesFor(home: string): RemoteUpdates {
  let key: string
  try {
    key = realpathSync.native(home)
  } catch {
    key = resolve(home)
  }
  let hub = hubs.get(key)
  if (!hub) hubs.set(key, (hub = new RemoteUpdates()))
  return hub
}
