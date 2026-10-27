import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, RefreshCw } from '../../lib/icons'
import { Modal } from '../ui/Modal'
import type {
  ScheduledJob,
  ScheduledWebhookDelivery,
  ScheduledWebhookDeliveryLog,
  ScheduledWebhookGrant
} from '../../../shared/types'
import { describeDelivery, errorText } from './scheduledLabels'

export interface WebhookApi {
  enable(id: string): Promise<ScheduledWebhookGrant>
  rotate(id: string): Promise<ScheduledWebhookGrant>
  disable(id: string): Promise<ScheduledJob>
  deliveries(id: string): Promise<ScheduledWebhookDeliveryLog>
  copy(text: string): Promise<void>
}

/** The secret leaves the screen on its own after this long, so a dialog left open does not hold it. */
export const SECRET_VISIBLE_MS = 5 * 60_000

/** Why a job cannot take a webhook, or null. */
export function webhookRefusal(job: ScheduledJob): string | null {
  if (job.createdBy) return 'Agent-created jobs cannot have a webhook.'
  if (job.schedule.kind === 'once') return 'A one-time job runs once, so it cannot have a webhook. Change its schedule to Manual first.'
  return null
}

interface IssuedSecret {
  secret: string
  rotated: boolean
}

/**
 * A job's webhook: where senders post, the signing secret (shown once, right after it is enabled or rotated),
 * and the recent requests with what became of each. The secret lives only in this dialog's state: it is
 * dropped when the dialog closes, when you press Done, when the webhook is disabled, and after a few minutes.
 */
export function WebhookDialog({ job, api, onClose }: { job: ScheduledJob; api: WebhookApi; onClose: () => void }) {
  const hasWebhook = Boolean(job.trigger?.webhook)
  const [issued, setIssued] = useState<IssuedSecret | null>(null)
  // The answer to Enable can arrive before the job update that carries the trigger; the secret is shown either way.
  const enabled = hasWebhook || issued !== null
  const [expired, setExpired] = useState(false)
  const [copied, setCopied] = useState<'secret' | 'url' | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'enable' | 'rotate' | 'disable' | null>(null)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [deliveries, setDeliveries] = useState<ScheduledWebhookDelivery[] | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const loadTicket = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const loadLog = useCallback(async () => {
    const ticket = ++loadTicket.current
    try {
      const log = await api.deliveries(job.id)
      if (!mounted.current || ticket !== loadTicket.current) return
      setDeliveries(log.deliveries)
      setUrl(log.url)
      setLogError(null)
    } catch (cause) {
      if (mounted.current && ticket === loadTicket.current) setLogError(errorText(cause))
    }
  }, [api, job.id])

  // The log follows the job: a request that starts a run, or a run that ends, changes the job.
  useEffect(() => {
    if (enabled) void loadLog()
    else setDeliveries(null)
  }, [enabled, loadLog, job.updatedAt, job.lastRunAt, job.state])

  // The webhook going away (disabled here, or by the CLI) drops any secret still on screen.
  useEffect(() => {
    if (!hasWebhook) setIssued(null)
  }, [hasWebhook])

  useEffect(() => {
    if (!issued) return
    const timer = setTimeout(() => { setIssued(null); setExpired(true) }, SECRET_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [issued])

  const apply = (grant: ScheduledWebhookGrant, rotated: boolean) => {
    setUrl(grant.url)
    setNotice([grant.error, grant.warning].filter(Boolean).join(' ') || null)
    setIssued(grant.secret ? { secret: grant.secret, rotated } : null)
    setExpired(false)
    setCopied(null)
  }

  const run = async (kind: 'enable' | 'rotate' | 'disable', action: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const copy = async (what: 'secret' | 'url', text: string) => {
    try {
      await api.copy(text)
      setCopied(what)
    } catch {
      setError('Copying failed. Select the text and copy it by hand.')
    }
  }

  const refusal = webhookRefusal(job)

  return (
    <Modal open title={`Webhook for ${job.name}`} onClose={onClose} footer={<button type="button" className="scheduled-btn" onClick={onClose}>{issued ? 'Done' : 'Close'}</button>}>
      <div className="scheduled-webhook" data-testid="webhook-dialog">
        {!enabled ? (
          <>
            <p>A signed request to a private address on this computer starts this job. Requests are checked with a secret that is shown once.</p>
            {refusal ? <p className="scheduled-note" role="note">{refusal}</p> : null}
            <div className="scheduled-form-actions">
              <button
                type="button"
                className="scheduled-btn primary"
                disabled={Boolean(refusal) || busy !== null}
                onClick={() => void run('enable', async () => apply(await api.enable(job.id), false))}
              >
                Enable webhook
              </button>
            </div>
          </>
        ) : (
          <>
            {url ? (
              <div className="scheduled-field">
                <span className="scheduled-label">Address</span>
                <div className="scheduled-copy-row">
                  <code className="scheduled-code" data-testid="webhook-url">{url}</code>
                  <button type="button" className="scheduled-icon-btn" title="Copy address" aria-label="Copy address" onClick={() => void copy('url', url)}>
                    {copied === 'url' ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                  </button>
                </div>
              </div>
            ) : null}
            {issued ? (
              <div className="scheduled-field scheduled-secret" role="group" aria-label="New webhook secret">
                <span className="scheduled-label">{issued.rotated ? 'New secret' : 'Secret'}</span>
                <div className="scheduled-copy-row">
                  <code className="scheduled-code" data-testid="webhook-secret">{issued.secret}</code>
                  <button type="button" className="scheduled-btn" onClick={() => void copy('secret', issued.secret)}>
                    {copied === 'secret' ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                    {copied === 'secret' ? 'Copied' : 'Copy secret'}
                  </button>
                </div>
                <p className="scheduled-note" role="status">
                  Copy it now. It is shown only this once and cannot be looked up later.
                  {issued.rotated ? ' The old secret no longer works.' : ''}
                </p>
              </div>
            ) : (
              <p className="scheduled-note" data-testid="webhook-secret-hidden">
                {expired ? 'The secret was hidden. ' : ''}The secret is not shown again. Rotate it to get a new one.
              </p>
            )}
            {notice ? <p className="scheduled-note" role="status">{notice}</p> : null}
            <div className="scheduled-form-actions start">
              <button type="button" className="scheduled-btn" disabled={busy !== null} onClick={() => void run('rotate', async () => apply(await api.rotate(job.id), true))}>
                Rotate secret
              </button>
              <button type="button" className="scheduled-btn danger" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
                Disable webhook
              </button>
            </div>
            <section className="scheduled-requests" aria-label="Recent requests">
              <div className="scheduled-requests-head">
                <h4>Recent requests</h4>
                <button type="button" className="scheduled-icon-btn" title="Refresh requests" aria-label="Refresh requests" onClick={() => void loadLog()}>
                  <RefreshCw size={14} strokeWidth={2} />
                </button>
              </div>
              {logError ? <p className="scheduled-item-error" role="alert">{logError}</p> : null}
              {deliveries === null ? (
                <p className="scheduled-empty">Loading…</p>
              ) : deliveries.length === 0 ? (
                <p className="scheduled-empty">No requests yet.</p>
              ) : (
                <ul className="scheduled-request-list">
                  {deliveries.map((delivery, index) => {
                    const text = describeDelivery(delivery)
                    return (
                      <li key={`${delivery.receivedAt}-${delivery.occurrenceId ?? index}`} className="scheduled-request" data-outcome={delivery.outcome} data-refused={text.refused ? 'true' : 'false'}>
                        <span className={`scheduled-outcome${text.refused ? ' refused' : ''}`}>{text.label}</span>
                        <span className="scheduled-request-time">{new Date(delivery.receivedAt).toLocaleString()}</span>
                        <span className="scheduled-request-size">{text.bytes}</span>
                        <span className="scheduled-request-detail">{text.detail}</span>
                        {text.missing ? <span className="scheduled-request-missing">Missing fields: {text.missing}</span> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </>
        )}
        {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
      </div>
      {confirmDisable ? (
        <Modal
          open
          title="Disable this webhook?"
          onClose={() => setConfirmDisable(false)}
          footer={
            <>
              <button type="button" className="scheduled-btn" onClick={() => setConfirmDisable(false)}>Keep webhook</button>
              <button
                type="button"
                className="scheduled-btn danger"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmDisable(false)
                  void run('disable', async () => {
                    await api.disable(job.id)
                    setIssued(null)
                    setUrl(null)
                  })
                }}
              >
                Disable webhook
              </button>
            </>
          }
        >
          <p>Requests to its address stop working right away and its secret is deleted. A request that is waiting to start is dropped. You can enable it again later, with a new secret.</p>
        </Modal>
      ) : null}
    </Modal>
  )
}
