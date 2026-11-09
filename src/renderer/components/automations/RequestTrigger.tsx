import { useEffect, useRef, useState, type RefObject } from 'react'
import { Check, Copy, X } from '../../lib/icons'
import type { AutomationDelivery, AutomationItem } from '../../../shared/automations'
import type { ScheduledJob, ScheduledWebhookGrant } from '../../../shared/types'
import { curlLine, deliveryWord, fieldPath, fieldToken, requestFields, requestRefusal, withoutField } from '../../../shared/requestTrigger'
import { Modal } from '../ui/Modal'
import { errorText } from '../scheduled/scheduledLabels'

/** What the Request trigger does through the daemon (`scheduled.webhook.*`). */
export interface RequestApi {
  enable(id: string): Promise<ScheduledWebhookGrant>
  rotate(id: string): Promise<ScheduledWebhookGrant>
  disable(id: string): Promise<ScheduledJob>
  copy(text: string): Promise<void>
}

/** A secret leaves the screen on its own after this long, so a detail left open does not hold it. */
export const SECRET_VISIBLE_MS = 5 * 60_000

/**
 * + Field, beside the prompt: inserts a request field as a token where the cursor is (`{{body.pr.number}}`, filled from
 * the request body when a request starts the run). The fields the prompt uses show under it, each with ×.
 */
export function RequestFields({ prompt, promptRef, onChange }: { prompt: string; promptRef: RefObject<HTMLTextAreaElement | null>; onChange: (prompt: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const fields = requestFields(prompt)
  const path = fieldPath(text)
  useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  const insert = () => {
    if (!path) return
    const area = promptRef.current
    const token = fieldToken(path)
    const at = area ? area.selectionStart ?? prompt.length : prompt.length
    const end = area ? area.selectionEnd ?? at : at
    onChange(`${prompt.slice(0, at)}${token}${prompt.slice(end)}`)
    setText('')
    setAdding(false)
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  return (
    <div className="automation-fields" data-testid="request-fields">
      {fields.map((field) => (
        <span key={field} className="automation-field-token" data-testid="request-field" title={`Filled from the request's ${field}`}>
          {field}
          <button type="button" aria-label={`Remove field ${field}`} title="Remove" onClick={() => onChange(withoutField(prompt, field))}><X size={11} /></button>
        </span>
      ))}
      {adding ? (
        <span className="automation-field-add">
          <input
            ref={inputRef}
            className="scheduled-input narrow mono"
            aria-label="Request field"
            data-testid="request-field-input"
            placeholder="pr.number"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); insert() }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false) }
            }}
          />
          <button type="button" className="settings-btn" disabled={!path} onClick={insert} title={path ? `Insert ${fieldToken(path)}` : 'A field of the JSON body, like pr.number'}>Insert</button>
        </span>
      ) : (
        <button type="button" className="scheduled-link-btn" data-testid="request-field-add" title="Insert a field of the request's JSON body" onClick={() => setAdding(true)}>+ Field</button>
      )}
    </div>
  )
}

function CopyButton({ text, label, api, testId }: { text: string; label: string; api: Pick<RequestApi, 'copy'>; testId?: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      className="settings-icon-btn"
      data-testid={testId}
      title={failed ? 'Copying failed. Select the text and copy it by hand.' : copied ? 'Copied' : label}
      aria-label={label}
      onClick={() => { api.copy(text).then(() => { setCopied(true); setFailed(false) }, () => setFailed(true)) }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

/**
 * The Request trigger in More: off, with Set up (or why it cannot have one); on, with the URL, a ready-to-copy `curl`
 * line built from the fields the prompt uses and signed as the listener expects, the secret right after it is issued
 * (once, then never again), Rotate and Turn off.
 */
export function RequestSetup({ job, request, prompt, api }: { job: ScheduledJob; request?: AutomationItem['request']; prompt: string; api: RequestApi }) {
  const [secret, setSecret] = useState<{ value: string; rotated: boolean } | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const on = Boolean(job.trigger?.webhook) || secret !== null
  // The request URL going away (turned off here or by the CLI) drops a secret still on screen.
  useEffect(() => { if (!job.trigger?.webhook) setSecret(null) }, [job.trigger?.webhook])
  useEffect(() => {
    if (!secret) return
    const timer = setTimeout(() => setSecret(null), SECRET_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [secret])

  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const apply = (grant: ScheduledWebhookGrant, rotated: boolean) => {
    setUrl(grant.url)
    setNotice([grant.error, grant.warning].filter(Boolean).join(' ') || null)
    setSecret(grant.secret ? { value: grant.secret, rotated } : null)
  }

  const refusal = requestRefusal(job)
  if (!on) {
    return (
      <div className="automation-request" data-testid="request-setup">
        <div className="automation-request-line">
          <span className="scheduled-detail-desc">Off</span>
          <button type="button" className="settings-btn" data-testid="request-enable" disabled={Boolean(refusal) || busy} title={refusal ?? 'A signed request to a private address on this computer runs it'} onClick={() => void act(async () => apply(await api.enable(job.id), false))}>Set up</button>
        </div>
        {refusal ? <p className="scheduled-note" data-testid="request-refusal">{refusal}</p> : null}
        {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
      </div>
    )
  }

  const address = url ?? request?.url ?? ''
  const curl = address ? curlLine({ url: address, fields: requestFields(prompt), ...(secret ? { secret: secret.value } : {}) }) : ''
  return (
    <div className="automation-request" data-testid="request-setup" data-on="true">
      {address ? (
        <div className="scheduled-copy-row">
          <code className="scheduled-code" data-testid="request-url">{address}</code>
          <CopyButton text={address} label="Copy URL" api={api} />
        </div>
      ) : null}
      {secret ? (
        <div className="scheduled-copy-row" role="group" aria-label="Secret">
          <code className="scheduled-code" data-testid="request-secret">{secret.value}</code>
          <CopyButton text={secret.value} label="Copy secret" api={api} />
        </div>
      ) : null}
      {secret ? <p className="scheduled-note" role="status">{`Copy it now. It is shown once.${secret.rotated ? ' The old secret stopped working.' : ''}`}</p> : null}
      {curl ? (
        <div className="scheduled-copy-row">
          <code className="scheduled-code automation-curl" data-testid="request-curl" title={secret ? 'Signed with the new secret' : 'Set MOUSSE_SECRET to the secret first'}>{curl}</code>
          <CopyButton text={curl} label="Copy curl" api={api} testId="request-curl-copy" />
        </div>
      ) : null}
      {notice ? <p className="scheduled-note" role="status">{notice}</p> : null}
      <div className="automation-request-line">
        <button type="button" className="settings-btn" disabled={busy} title="A new secret; the old one stops working at once" onClick={() => void act(async () => apply(await api.rotate(job.id), true))}>Rotate secret</button>
        <button type="button" className="settings-btn danger" disabled={busy} onClick={() => setConfirmOff(true)}>Turn off</button>
      </div>
      {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
      {confirmOff ? (
        <Modal
          open
          title="Turn off its request URL?"
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <button type="button" className="settings-btn" onClick={() => setConfirmOff(false)}>Keep it</button>
              <button type="button" className="settings-btn danger" data-testid="request-disable-confirm" disabled={busy} onClick={() => { setConfirmOff(false); void act(async () => { await api.disable(job.id); setSecret(null); setUrl(null) }) }}>Turn off</button>
            </>
          }
        >
          <p className="scheduled-note">Requests stop working at once, and its secret and stored requests are deleted.</p>
        </Modal>
      ) : null}
    </div>
  )
}

/** One line of a delivery: the outcome in the log's words, and why. */
export function deliveryText(delivery: Pick<AutomationDelivery, 'outcome' | 'detail' | 'missing' | 'resent'>): { word: string; detail: string; refused: boolean } {
  const word = deliveryWord(delivery.outcome)
  const missing = delivery.missing?.length ? `Missing fields: ${delivery.missing.join(', ')}` : ''
  return {
    word: delivery.resent ? `${word} · resent` : word,
    detail: [missing, delivery.detail ?? ''].filter(Boolean).join(' · '),
    refused: word !== 'Accepted'
  }
}

/** The delivery log in detail: every request and what became of it, with Resend on one that ran. */
export function DeliveryLog({ deliveries, when, onResend }: { deliveries: AutomationDelivery[]; when: (iso: string) => string; onResend: (occurrenceId: string) => void }) {
  return (
    <section className="automation-runs" aria-label="Requests" data-testid="automation-deliveries">
      <h3 className="automation-runs-head">Requests</h3>
      {deliveries.length === 0 ? <p className="scheduled-note">No requests yet.</p> : (
        <ul>
          {deliveries.map((delivery, index) => {
            const text = deliveryText(delivery)
            return (
              <li key={`${delivery.at}-${delivery.occurrenceId ?? index}`} className="automation-run" data-testid="automation-delivery" data-outcome={delivery.outcome}>
                <span className={`scheduled-outcome${text.refused ? ' refused' : ''}`}>{text.word}</span>
                <span className="automation-run-when">{when(delivery.at)}</span>
                <span className="automation-run-text" title={`${delivery.bytes} bytes`}>{text.detail}</span>
                {delivery.resendable && delivery.occurrenceId ? (
                  <button type="button" className="scheduled-link-btn" data-testid="automation-resend" title="Run it again with this request's stored body" onClick={() => onResend(delivery.occurrenceId!)}>Resend</button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
