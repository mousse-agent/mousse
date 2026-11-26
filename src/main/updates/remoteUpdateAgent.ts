import {
  REMOTE_UPDATE_APP_METHODS,
  REMOTE_UPDATE_EVENT,
  remoteUpdateLimits,
  type RemoteUpdateError,
  type RemoteUpdateJob,
  type RemoteUpdateLimits,
  type RemoteUpdateToast
} from '../../shared/remoteUpdates'
import type { DesktopUpdater } from './DesktopUpdater'

/** The app's connection to its own service: requests, and the events and state it sends. */
export interface AgentService {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

type BeginAnswer = { go: true } | { go: false; wait: boolean; job: RemoteUpdateJob | null }

/**
 * Carries out update requests from the user's other computers on this one (#476). It registers with the service
 * while the service is ready (so this computer says it takes requests only while the app runs), downloads exactly
 * the version asked for, shows the countdown with Cancel, and installs once the service says the countdown ended,
 * the asking computer still has Full control here and no more turns run than it confirmed.
 */
export class RemoteUpdateAgent {
  private preparing: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private shown: string | null = null
  private installing = false
  private syncing: Promise<void> | null = null
  private again = false
  private stopped = false
  private readonly limits: RemoteUpdateLimits
  private readonly now: () => number
  private readonly onEvent = (event: { type?: string; profileId?: string } | null): void => {
    if (event?.type === REMOTE_UPDATE_EVENT && !event.profileId) this.sync()
  }
  private readonly onState = (state: string): void => {
    if (state === 'ready') void this.attach()
  }

  constructor(
    private readonly opts: {
      service: AgentService
      updater: Pick<DesktopUpdater, 'prepareExact' | 'installExact' | 'getState'>
      /** Shows the countdown (or hides it with null) in every window. */
      toast: (toast: RemoteUpdateToast | null) => void
      limits?: RemoteUpdateLimits
      now?: () => number
    }
  ) {
    this.limits = opts.limits ?? remoteUpdateLimits()
    this.now = opts.now ?? Date.now
  }

  /** Starts taking requests; the service may already be ready. */
  start(ready: boolean): void {
    this.opts.service.on('event', this.onEvent)
    this.opts.service.on('state', this.onState)
    if (ready) void this.attach()
  }

  stop(): void {
    this.stopped = true
    this.opts.service.off('event', this.onEvent)
    this.opts.service.off('state', this.onState)
    this.clearTimer()
    this.hide()
  }

  /** Cancel on the countdown. */
  async cancel(job: string): Promise<void> {
    this.clearTimer()
    this.hide()
    await this.opts.service.request(REMOTE_UPDATE_APP_METHODS.cancel, { job }).catch(() => undefined)
  }

  private async attach(): Promise<void> {
    if (this.stopped) return
    try {
      const { job } = await this.opts.service.request<{ job: RemoteUpdateJob | null }>(REMOTE_UPDATE_APP_METHODS.attach, {})
      await this.act(job)
    } catch (error) {
      console.warn('Update requests are not taken now:', error instanceof Error ? error.message : String(error))
    }
  }

  /** Reads the request again; calls that arrive meanwhile run once more after it. */
  private sync(): void {
    if (this.syncing) {
      this.again = true
      return
    }
    this.syncing = (async () => {
      do {
        this.again = false
        try {
          const { job } = await this.opts.service.request<{ job: RemoteUpdateJob | null }>(REMOTE_UPDATE_APP_METHODS.job, {})
          await this.act(job)
        } catch {
          // The service went away: it fails the request, and this reads it again once it is back.
        }
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.syncing = null
    })
  }

  private async act(job: RemoteUpdateJob | null): Promise<void> {
    if (this.stopped || this.installing) return
    if (!job) {
      this.clearTimer()
      this.hide()
      return
    }
    if (job.phase === 'preparing' && this.preparing !== job.id) void this.prepare(job)
    if (job.phase === 'countdown' || job.phase === 'waiting') {
      this.show(job)
      this.at(job.installAt ?? this.now(), () => void this.begin(job))
    } else if (job.phase !== 'installing') {
      this.clearTimer()
      this.hide()
    }
  }

  private async prepare(job: RemoteUpdateJob): Promise<void> {
    this.preparing = job.id
    const report = (body: Record<string, unknown>) =>
      this.opts.service.request(REMOTE_UPDATE_APP_METHODS.progress, { job: job.id, ...body }).catch(() => undefined)
    // Progress goes to the service about once a second while the download runs.
    const ticker = setInterval(() => {
      const percent = this.opts.updater.getState().downloadPercent
      if (percent !== undefined) void report({ phase: 'preparing', percent })
    }, this.limits.pollMs)
    try {
      const result = await this.opts.updater.prepareExact(job.version)
      await report(result.ok ? { phase: 'ready' } : { phase: 'failed', error: result.error })
    } catch {
      await report({ phase: 'failed', error: 'download_failed' satisfies RemoteUpdateError })
    } finally {
      clearInterval(ticker)
      if (this.preparing === job.id) this.preparing = null
    }
  }

  private async begin(job: RemoteUpdateJob): Promise<void> {
    if (this.stopped || this.installing) return
    let answer: BeginAnswer
    try {
      answer = await this.opts.service.request<BeginAnswer>(REMOTE_UPDATE_APP_METHODS.begin, { job: job.id })
    } catch {
      return
    }
    if (!answer.go) {
      if (!answer.wait || !answer.job) {
        this.hide()
        return
      }
      const next = answer.job
      this.show(next)
      // Still counting down, or more turns run than were confirmed: ask again later.
      const at = next.phase === 'waiting' ? this.now() + this.limits.busyRetryMs : (next.installAt ?? this.now())
      this.at(at, () => void this.begin(next))
      return
    }
    this.installing = true
    this.hide()
    const result = await this.opts.updater.installExact(job.version).catch(() => ({ ok: false as const, error: 'install_failed' as const }))
    if (result.ok) return
    this.installing = false
    await this.opts.service.request(REMOTE_UPDATE_APP_METHODS.cancel, { job: job.id, error: result.error }).catch(() => undefined)
  }

  private at(time: number, run: () => void): void {
    this.clearTimer()
    this.timer = setTimeout(run, Math.max(0, time - this.now()))
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private show(job: RemoteUpdateJob): void {
    this.shown = job.id
    this.opts.toast({ job: job.id, from: job.from, installAt: job.installAt ?? this.now(), ...(job.phase === 'waiting' ? { waiting: true } : {}) })
  }

  private hide(): void {
    if (this.shown === null) return
    this.shown = null
    this.opts.toast(null)
  }
}
