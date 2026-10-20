import { useEffect, useState } from 'react'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { mousseIdName, mousseIdOrigin, mousseIdPreparation, mousseIdSetupStep, useMousseId, type SignInStart } from '../stores/mousseIdStore'
import { MousseIdAvatar } from './MousseIdAvatar'
import './account-section.css'

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** Mousse ID sign-in and account details, shown under Settings → Account. */
export function AccountSection({ onOpenDevices }: { onOpenDevices: () => void }) {
  const state = useMousseId()
  const { plus, net, pending, busy, error, loaded } = state
  const [notice, setNotice] = useState('')
  const now = useNow(!!pending)
  const origin = mousseIdOrigin(state)

  let host: string | undefined
  try {
    host = plus?.audience ? new URL(plus.audience).host : new URL(origin).host
  } catch {
    host = undefined
  }

  const start = async () => {
    setNotice('')
    const result: SignInStart = await state.signIn()
    // Only a locked profile needs Devices: unlocking takes the passphrase.
    if (result === 'needs-setup') onOpenDevices()
    if (result === 'no-service') setNotice('This build has no Mousse ID service address. Set MOUSSE_ID_ORIGIN and restart Mousse.')
  }

  return (
    <div className="account-section">
      <div className="account-card">
        <MousseIdAvatar plus={plus} large />
        <div className="account-card-text">
          {plus?.connected ? (
            <>
              <strong>{mousseIdName(plus)}</strong>
              <span>{plus.email ?? `Account ${plus.accountId ?? ''}`}</span>
              <span>{[plus.plan, host].filter(Boolean).join(' · ')}</span>
            </>
          ) : (
            <>
              <strong>{pending ? 'Signing in…' : 'Not signed in'}</strong>
              <span>
                {!loaded ? 'Checking Mousse ID…'
                  : plus?.configured ? 'Mousse ID is selected but disconnected. Sign in again to reconnect.'
                    : 'Mousse works without an account. Sign in to reach this computer from your phone.'}
              </span>
            </>
          )}
        </div>
        <div className="account-card-actions">
          {plus?.configured ? (
            <button type="button" className="settings-btn-secondary" disabled={busy || !net?.enabled} onClick={() => void state.signOut()}>
              Sign out
            </button>
          ) : null}
          {!plus?.connected && !pending && (
            <button type="button" className="settings-add-btn" disabled={busy} onClick={() => void start()}>
              {busy ? 'Connecting…' : 'Sign in with Mousse ID'}
            </button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="chat-error">{error}</p>}

      {pending && (
        <div role="status" className="account-pending">
          <p>
            Finish signing in in your browser. Check that it shows code <strong>{pending.userCode}</strong> · {formatCountdown(secondsLeft(pending.expiresAt, now))} left.
          </p>
          <a href={pending.verificationUri} target="_blank" rel="noreferrer">Open the sign-in page again</a>
          <button type="button" className="settings-btn-secondary" onClick={state.cancelSignIn}>Cancel</button>
        </div>
      )}

      {!plus?.connected && !pending && loaded && mousseIdPreparation(net) === 'manual' && (
        <p role="status" className="account-note">
          {mousseIdSetupStep(net)}{' '}
          <button type="button" className="account-link" onClick={onOpenDevices}>Open Devices</button>
        </p>
      )}
      {notice && <p role="alert" className="account-note">{notice}</p>}
      {plus?.connected && net?.self?.isAuthority && <p className="account-note">This profile’s network identity is linked to this account. Add phones under Devices.</p>}
    </div>
  )
}
