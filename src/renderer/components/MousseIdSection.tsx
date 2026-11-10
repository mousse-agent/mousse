import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlusEnrollmentOffer, PlusEnrollmentRequestView } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import { qrSvgPath } from '../lib/plusQr'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { decideEnrollmentRequest, formatMatchCode, listEnrollmentRequests } from '../lib/plusEnrollment'
import { SettingsRow } from './settings/SettingsRow'
import { Modal } from './ui/Modal'
import { Check, Smartphone, X } from '../lib/icons'

const request = <T,>(method: PlatformRequestMethod, params: unknown = {}) =>
  window.mousse.platformRequest.request<T>(method, params)
const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => qrSvgPath(text), [text])
  // Always dark on white with a quiet zone so phone cameras read it in either theme.
  return (
    <svg className="net-plus-qr" viewBox={`0 0 ${size} ${size}`} width={192} height={192} role="img" aria-label="Phone sign-in QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

/**
 * Phones waiting to join through Mousse ID (issue #98), read while `enabled`. The daemon polls the
 * Mousse ID mailbox; this only reads its cache. `decide` approves or denies one and drops its row.
 */
export function useEnrollmentRequests(enabled: boolean, onApproved: () => void) {
  const [requests, setRequests] = useState<PlusEnrollmentRequestView[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!enabled) {
      setRequests([])
      return
    }
    let active = true
    const load = () =>
      listEnrollmentRequests()
        .then((value) => { if (active) setRequests(value) })
        .catch(() => undefined)
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [enabled])
  const decide = async (id: string, approve: boolean) => {
    setBusy(true)
    setError('')
    try {
      await decideEnrollmentRequest(id, approve)
      if (!alive.current) return
      setRequests((rows) => rows.filter((row) => row.id !== id))
      if (approve) onApproved()
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return { requests, busy, error, decide }
}

/** A join request at the top of My devices, answered with Deny or Approve. */
export function EnrollmentRequestRow({ row, busy, onDecide }: {
  row: PlusEnrollmentRequestView
  busy: boolean
  onDecide: (approve: boolean) => void
}) {
  return (
    <SettingsRow
      leading={<Smartphone size={16} />}
      title={`${row.deviceName} wants to join`}
      description={<>Match code <strong>{formatMatchCode(row.matchCode)}</strong> · approve only if the {row.kind === 'computer' ? 'computer' : 'phone'} shows it</>}
      control={
        <>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => onDecide(false)}><X size={14} />Deny</button>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => onDecide(true)}>
            <Check size={14} className="settings-status-ok" />Approve
          </button>
        </>
      }
    />
  )
}

/** Add device → A phone: a one-time code to scan with the Mousse app, made when the dialog opens. */
export function AddPhoneDialog({ onClose }: { onClose: () => void }) {
  const [offer, setOffer] = useState<PlusEnrollmentOffer>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const now = useNow(!!offer)
  useEffect(() => {
    let active = true
    setError('')
    request<PlusEnrollmentOffer>('net.plus.enrollment.offer', { name: 'Phone' })
      .then((value) => { if (active) setOffer(value) })
      .catch((cause) => { if (active) setError(message(cause)) })
    return () => { active = false }
  }, [attempt])
  const expired = !!offer && offer.expiresAt <= now
  return (
    <Modal
      open
      title="Add a phone"
      onClose={onClose}
      footer={(expired || error) && (
        <button type="button" className="settings-btn devices-dialog-btn primary" onClick={() => { setOffer(undefined); setAttempt((n) => n + 1) }}>New code</button>
      )}
    >
      <div className="devices-dialog">
        {offer && !expired && <>
          <p className="settings-muted">Scan with the Mousse app on your phone. Works once · expires in {formatCountdown(secondsLeft(offer.expiresAt, now))}</p>
          <QrCode text={offer.url} />
        </>}
        {expired && <p className="settings-muted">This code expired.</p>}
        {!offer && !error && <p className="settings-muted">Making a code…</p>}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
