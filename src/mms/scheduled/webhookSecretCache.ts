import type { IntegrationSecretAdapter } from '../integrations/secrets'
import type { ScheduledJobStore } from './ScheduledJobStore'

/**
 * The signing secrets of the jobs that have a webhook, held in memory so a request to the listener (signed or
 * not) never takes the jobs lock or reads a file. The table is rebuilt at most once per `ttlMs` and whenever the
 * scheduler reports a change (`invalidate`: enable, rotate, disable, delete), so a rotation applies at once.
 *
 * Jobs an agent created never have an entry. A rebuild that fails (the jobs lock is busy) keeps the last table;
 * the store re-checks the job's webhook under the lock before anything is accepted.
 */
export class WebhookSecretCache {
  private table = new Map<string, string>()
  private loadedAt = 0

  constructor(
    private readonly store: Pick<ScheduledJobStore, 'listJobs'>,
    private readonly secrets: Pick<IntegrationSecretAdapter, 'resolveSecretRef'>,
    private readonly ttlMs = 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** The job's signing secret, or undefined for an unknown job, a job without a webhook, or an unreadable secret. */
  resolve(jobId: string): string | undefined {
    if (this.now() - this.loadedAt >= this.ttlMs) this.reload()
    return this.table.get(jobId)
  }

  /** The next `resolve` rebuilds the table. */
  invalidate(): void {
    this.loadedAt = 0
  }

  private reload(): void {
    this.loadedAt = this.now()
    try {
      const next = new Map<string, string>()
      for (const job of this.store.listJobs()) {
        const webhook = !job.createdBy ? job.trigger?.webhook : undefined
        if (!webhook) continue
        const secret = this.secrets.resolveSecretRef?.(webhook.secretRef)
        if (secret) next.set(job.id, secret)
      }
      this.table = next
    } catch {
      /* keep the last table; the next request after the interval tries again */
    }
  }
}
