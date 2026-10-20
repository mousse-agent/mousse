import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlusConfiguration, PlusStatus } from '../../mms/net/plus/contracts'
import type { NetStatus, PlusEnrollmentOffer, PlusEnrollmentRequestView } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import { qrSvgPath } from '../lib/plusQr'
import {
  DEFAULT_PLUS_ORIGIN,
  formatCountdown,
  normalizePlusOrigin,
  PLUS_ORIGIN_OVERRIDE_KEY,
  pollPlusSignIn,
  PlusSignInError,
  resolvePlusOrigin,
  secondsLeft
} from '../lib/plusSignIn'

interface PendingLogin {
  id: string
  userCode: string
  verificationUri: string
  expiresAt: number
  pollIntervalMs?: number
}
interface DeviceSummary {
  node: string
  name: string
  self: boolean
  revoked: boolean
}

const request = <T,>(method: PlatformRequestMethod, params: unknown = {}) =>
  window.mousse.platformRequest.request<T>(method, params)
const message = (cause: unknown) => String((cause as Error | null)?.message ?? cause)
const readOverride = () => {
  try {
    return localStorage.getItem(PLUS_ORIGIN_OVERRIDE_KEY) ?? ''
  } catch {
    return ''
  }
}

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

/** Mousse ID sign-in, phone codes and phone requests (issue #98). */
export function MousseIdSection({
  status,
  plus,
  devices,
  deviceName,
  onChanged
}: {
  status?: NetStatus
  plus?: PlusStatus
  devices: DeviceSummary[]
  deviceName: string
  onChanged: () => Promise<void>
}) {
  const [override, setOverride] = useState(readOverride)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [login, setLogin] = useState<PendingLogin>()
  const [offer, setOffer] = useState<PlusEnrollmentOffer>()
  const [requests, setRequests] = useState<PlusEnrollmentRequestView[]>([])
  const signIn = useRef<AbortController | undefined>(undefined),
    alive = useRef(true)
  const now = useNow(!!login || !!offer)
  const origin = resolvePlusOrigin(override)
  const overrideInvalid = !!override.trim() && !normalizePlusOrigin(override)
  const ready = !!status?.enabled && !!status.self && status.keystore === 'unlocked' && !!status.protected
  const authority = !!status?.self?.isAuthority
  const canEnroll = ready && authority && !!plus?.connected

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      signIn.current?.abort()
    }
  }, [])

  // The daemon polls the Plus mailbox; this only reads its cache.
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
      if (alive.current && !(cause instanceof PlusSignInError && cause.code === 'cancelled')) setError(message(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const beginSignIn = () =>
    run(async () => {
      const configuration = await request<Omit<PlusConfiguration, 'accountId'>>('net.plus.discover', { apiOrigin: origin })
      const pending = await request<PendingLogin>('net.plus.login.begin', {
        configuration,
        deviceName: deviceName.trim() || 'My device',
        bindRoot: authority
      })
      if (!alive.current) return
      const controller = new AbortController()
      signIn.current = controller
      setLogin(pending)
      // The main process opens new windows in the system browser.
      window.open(pending.verificationUri, '_blank', 'noopener,noreferrer')
      try {
        await pollPlusSignIn(() => request<PlusStatus>('net.plus.login.finish', { id: pending.id }), {
          intervalMs: pending.pollIntervalMs ?? 2000,
          expiresAt: pending.expiresAt,
          signal: controller.signal
        })
        if (alive.current) await onChanged()
      } finally {
        if (signIn.current === controller) signIn.current = undefined
        if (alive.current) setLogin(undefined)
      }
    })

  const cancelSignIn = () => {
    signIn.current?.abort()
    setLogin(undefined)
    void request('net.plus.login.cancel').catch(() => undefined)
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

  const saveOverride = (value: string) => {
    setOverride(value)
    try {
      if (value.trim()) localStorage.setItem(PLUS_ORIGIN_OVERRIDE_KEY, value.trim())
      else localStorage.removeItem(PLUS_ORIGIN_OVERRIDE_KEY)
    } catch {
      // Storage can be unavailable; the value still applies to this window.
    }
  }

  let host: string | undefined
  try {
    host = plus?.audience ? new URL(plus.audience).host : undefined
  } catch {
    host = undefined
  }
  const listed = devices.filter((device) => !device.revoked)

  return (
    <section className="net-plus">
      <h3>Mousse ID · optional</h3>
      {error && <p role="alert" className="chat-error">{error}</p>}

      {plus?.connected ? (
        <div className="net-plus-account">
          <p>
            Signed in{plus.email ? <> as <strong>{plus.email}</strong></> : plus.accountId && <> · account {plus.accountId}</>}
            {plus.plan && <> · {plus.plan}</>}
            {host && <> · {host}</>}
          </p>
          {!!listed.length && <p>Devices: {listed.map((device) => device.name + (device.self ? ' (this device)' : '')).join(', ')}</p>}
        </div>
      ) : (
        <p>{plus?.configured ? 'Mousse ID selected · disconnected.' : 'Use Mousse locally without an account, or sign in to reach this computer from your phone.'}</p>
      )}

      {!plus?.connected && !login && (
        !origin ? (
          <p role="status">No Mousse Plus service is set for this build. Enter one under Advanced to sign in.</p>
        ) : !ready ? (
          <p role="status">
            {!status?.self ? 'Create a network identity above first.' : !status.enabled ? 'Enable networking for this profile first.' : status.keystore !== 'unlocked' ? 'Unlock this profile first.' : 'Protect network keys with a passphrase first.'}
          </p>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void beginSignIn()}>Sign in with Mousse ID</button>
            {authority && <p>Signing in links this profile’s network identity to the account you approve.</p>}
          </>
        )
      )}

      {login && (
        <div role="status" className="net-plus-login">
          <p>
            Approve code <strong>{login.userCode}</strong> in your browser. Waiting · {formatCountdown(secondsLeft(login.expiresAt, now))} left.
          </p>
          <a href={login.verificationUri} target="_blank" rel="noreferrer">Open the approval page again</a>
          <button type="button" onClick={cancelSignIn}>Cancel</button>
        </div>
      )}

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

      {plus?.configured && (
        <button type="button" disabled={busy || !status?.enabled} onClick={() => void run(async () => { await request('net.plus.disconnect'); await onChanged() })}>
          Sign out of Mousse ID for this profile
        </button>
      )}

      <details className="net-addon">
        <summary>Advanced</summary>
        <label>
          Mousse Plus service
          <input value={override} onChange={(e) => saveOverride(e.target.value)} placeholder={DEFAULT_PLUS_ORIGIN || 'https://plus.example'} spellCheck={false} />
        </label>
        <p>{overrideInvalid ? 'Enter an https:// address (http:// only for this computer).' : origin ? `Signing in to ${origin}.` : 'No service set.'}</p>
      </details>
    </section>
  )
}
