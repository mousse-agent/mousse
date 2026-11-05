import { useEffect, useState } from 'react'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { mousseIdName, mousseIdOrigin, mousseIdSignedIn, mousseIdPreparation, mousseIdSetupStep, useMousseId, useMousseIdStore, type SignInStart } from '../stores/mousseIdStore'
import { MousseIdSection } from './MousseIdSection'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import { ExternalLink, Logout, UserCircle, X } from '../lib/icons'
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

/**
 * The top of Settings → Devices: Mousse ID sign-in, then adding phones once signed in. Shown only
 * when this build has the service. `onSetUp` brings the control this device needs first into view.
 */
export function MousseIdAccount({ onSetUp }: { onSetUp: () => void }) {
  const state = useMousseId()
  const { plus, net, pending, busy, error, loaded } = state
  const [notice, setNotice] = useState(''), [needsSetup, setNeedsSetup] = useState('')
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
    setNeedsSetup('')
    const result: SignInStart = await state.signIn()
    // A locked profile needs its passphrase first, which is entered further down this page.
    if (result === 'needs-setup') setNeedsSetup(mousseIdSetupStep(useMousseIdStore.getState().net))
    if (result === 'no-service') setNotice('This build has no Mousse ID service address. Set MOUSSE_ID_ORIGIN and restart Mousse.')
  }

  const signedIn = mousseIdSignedIn(plus)
  const title = signedIn ? mousseIdName(plus) : pending ? 'Signing in…' : 'Not signed in'
  const description = plus?.connected
    ? [plus.email ?? `Account ${plus.accountId ?? ''}`, plus.plan, host].filter(Boolean).join(' · ')
    : plus?.reconnecting ? [plus.email ?? `Account ${plus.accountId ?? ''}`, 'Reconnecting…'].join(' · ')
      : !loaded ? 'Checking Mousse ID…'
        : plus?.configured ? 'Disconnected. Sign in again to reconnect.'
          : 'Optional. Sign in to reach this computer from your phone and from your other computers signed in to it.'
  const setupStep = !signedIn && !pending && loaded && mousseIdPreparation(net) === 'manual' ? mousseIdSetupStep(net) : ''
  // A step asked for by Sign in goes once this device is ready or signed in.
  const setupNote = (!signedIn && mousseIdPreparation(net) !== 'ready' ? needsSetup : '') || setupStep
  const locked = !!net?.self && net.keystore !== 'unlocked'

  return (
    <>
      <SettingsGroup title="Mousse ID" icon={UserCircle} className="account-group">
        <SettingsRow
          title={title}
          description={description}
          control={
            <>
              {plus?.configured && (
                <button type="button" className="settings-btn" disabled={busy || !net?.enabled} onClick={() => void state.signOut()}>
                  <Logout size={14} />Sign out
                </button>
              )}
              {!signedIn && !pending && (
                <button type="button" className="settings-btn" disabled={busy} onClick={() => void start()}>
                  {busy ? 'Connecting…' : 'Sign in'}
                </button>
              )}
            </>
          }
        />
        {pending && (
          <SettingsRow
            title="Finish signing in in your browser"
            description={<>Check that it shows code <strong>{pending.userCode}</strong> · {formatCountdown(secondsLeft(pending.expiresAt, now))} left</>}
            control={
              <span className="settings-icon-actions">
                <a className="settings-icon-btn primary account-link-btn" href={pending.verificationUri} target="_blank" rel="noreferrer"
                  title="Open page" aria-label="Open page"><ExternalLink size={14} /></a>
                <button type="button" className="settings-icon-btn" title="Cancel sign-in" aria-label="Cancel sign-in" onClick={state.cancelSignIn}>
                  <X size={14} />
                </button>
              </span>
            }
          />
        )}
        {error && <p role="alert" className="chat-error account-error">{error}</p>}
        {setupNote ? (
          <div className="account-note-row">
            <p role="status" className="settings-muted account-note">{setupNote}</p>
            <button type="button" className="settings-btn" onClick={onSetUp}>{locked ? 'Unlock' : 'Set up'}</button>
          </div>
        ) : notice && <p role="status" className="settings-muted account-note">{notice}</p>}
      </SettingsGroup>
      {plus?.connected && <MousseIdSection status={net} plus={plus} onChanged={state.refresh} />}
    </>
  )
}
