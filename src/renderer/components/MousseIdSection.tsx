import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlusStatus } from '../../mms/net/plus/contracts'
import type { NetStatus, PlusEnrollmentOffer, PlusEnrollmentRequestView } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import { qrSvgPath } from '../lib/plusQr'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { mousseIdName } from '../stores/mousseIdStore'

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
    <svg className="net-plus-qr" viewBox={`0 0 ${size} ${size}`} width={224} height={224} role="img" aria-label="Phone sign-in QR code" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

/** Mousse ID phone codes and phone requests (issue #98). Sign-in lives under Settings → Account. */
export function MousseIdSection({
  status,
  plus,
  onChanged,
  onOpenAccount
}: {
  status?: NetStatus
  plus?: PlusStatus
  onChanged: () => Promise<void>
  onOpenAccount: () => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [offer, setOffer] = useState<PlusEnrollmentOffer>()
  const [requests, setRequests] = useState<PlusEnrollmentRequestView[]>([])
  const alive = useRef(true)
  const now = useNow(!!offer)
  const ready = !!status?.enabled && !!status.self && status.keystore === 'unlocked' && !!status.protected
  const authority = !!status?.self?.isAuthority
  const canEnroll = ready && authority && !!plus?.connected

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
      request<{ requests: PlusEnrollmentRequestView[] }>('net.plus.enrollment.requests')
        .then((value) => {
          if (active) setRequests(value.requests)
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
      await request(approve ? 'net.plus.enrollment.approve' : 'net.plus.enrollment.deny', { id })
      if (!alive.current) return
      setRequests((rows) => rows.filter((row) => row.id !== id))
      if (approve) await onChanged()
    })

  return (
    <section className="net-plus">
      <h3>Mousse ID</h3>
      {error && <p role="alert" className="chat-error">{error}</p>}

      <p>
        {plus?.connected
          ? <>Signed in as <strong>{plus.email ?? mousseIdName(plus)}</strong>. {authority ? 'Add phones to reach this computer from them.' : 'Phones can be added from the device that owns this identity.'}</>
          : 'Sign in to Mousse ID to add phones.'}{' '}
        <button type="button" className="account-link" onClick={onOpenAccount}>Account settings</button>
      </p>

      {canEnroll && (
        <div className="net-plus-phones">
          <h3>Phones</h3>
          {offer ? (
            <div className="net-plus-offer">
              <QrCode text={offer.url} />
              <p>Scan with the Mousse app on your phone. This code works once and expires in {formatCountdown(secondsLeft(offer.expiresAt, now))}.</p>
              <button type="button" onClick={() => setOffer(undefined)}>Hide code</button>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => void addPhone()}>Add phone</button>
          )}
          {requests.map((row) => (
            <div className="net-device-row" key={row.id}>
              <div>
                <strong>{row.deviceName}</strong>
                <span>
                  Wants to join · match code <strong>{row.matchCode.slice(0, 3)} {row.matchCode.slice(3)}</strong> · approve only if the phone shows the same code
                </span>
              </div>
              <button type="button" disabled={busy} onClick={() => void decide(row.id, true)}>Approve</button>
              <button type="button" disabled={busy} onClick={() => void decide(row.id, false)}>Deny</button>
            </div>
          ))}
        </div>
      )}

    </section>
  )
}
