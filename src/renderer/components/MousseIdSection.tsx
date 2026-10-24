import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlusStatus } from '../../shared/net/local'
import type { NetStatus, PlusEnrollmentOffer, PlusEnrollmentRequestView } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import { qrSvgPath } from '../lib/plusQr'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { decideEnrollmentRequest, listEnrollmentRequests, phonesBlocked } from '../lib/plusEnrollment'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import { Check, Plus, Smartphone, X } from '../lib/icons'

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

/** Mousse ID phones (issue #98): add a phone with a one-time code, approve or deny requests. */
export function MousseIdSection({
  status,
  plus,
  onChanged
}: {
  status?: NetStatus
  plus?: PlusStatus
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [offer, setOffer] = useState<PlusEnrollmentOffer>()
  const [requests, setRequests] = useState<PlusEnrollmentRequestView[]>([])
  const alive = useRef(true)
  const now = useNow(!!offer)
  const blocked = phonesBlocked(status, plus)
  const canEnroll = !blocked

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The daemon polls the Mousse ID mailbox; this only reads its cache.
  useEffect(() => {
    if (!canEnroll) {
      setRequests([])
      return
    }
    let active = true
    const load = () =>
      listEnrollmentRequests()
        .then((value) => {
          if (active) setRequests(value)
        })
        .catch(() => undefined)
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [canEnroll])

  useEffect(() => {
    if (offer && offer.expiresAt <= now) setOffer(undefined)
  }, [offer, now])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const addPhone = () =>
    run(async () => {
      const value = await request<PlusEnrollmentOffer>('net.plus.enrollment.offer', { name: 'Phone' })
      if (alive.current) setOffer(value)
    })

  const decide = (id: string, approve: boolean) =>
    run(async () => {
      await decideEnrollmentRequest(id, approve)
      if (!alive.current) return
      setRequests((rows) => rows.filter((row) => row.id !== id))
      if (approve) await onChanged()
    })

  return (
    <SettingsGroup
      title="Phones"
      icon={Smartphone}
      className="account-group"
      description={blocked}
      action={canEnroll && !offer && (
        <button type="button" className="settings-btn" disabled={busy} onClick={() => void addPhone()}><Plus size={14} />Add phone</button>
      )}
    >
      {error && <p role="alert" className="chat-error account-error">{error}</p>}
      {offer && (
        <SettingsRow
          title="Scan with the Mousse app on your phone"
          description={`Works once · expires in ${formatCountdown(secondsLeft(offer.expiresAt, now))}`}
          control={<button type="button" className="settings-icon-btn" title="Hide code" aria-label="Hide code" onClick={() => setOffer(undefined)}><X size={14} /></button>}
        >
          <QrCode text={offer.url} />
        </SettingsRow>
      )}
      {requests.map((row) => (
        <SettingsRow
          key={row.id}
          title={row.deviceName}
          description={<>Match code <strong>{row.matchCode.slice(0, 3)} {row.matchCode.slice(3)}</strong> · approve only if the phone shows it</>}
          control={
            <>
              <button type="button" className="settings-btn" disabled={busy} onClick={() => void decide(row.id, false)}><X size={14} />Deny</button>
              <button type="button" className="settings-btn" disabled={busy} onClick={() => void decide(row.id, true)}>
                <Check size={14} className="settings-status-ok" />Approve
              </button>
            </>
          }
        />
      ))}
      {canEnroll && !offer && !requests.length && <p className="settings-muted account-empty">No phones waiting to join.</p>}
    </SettingsGroup>
  )
}
