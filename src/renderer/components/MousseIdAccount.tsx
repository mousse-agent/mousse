import { useEffect, useState, type ReactNode } from 'react'
import type { PlusStatus } from '../../shared/net/local'
import { formatCountdown, secondsLeft } from '../lib/plusSignIn'
import { mousseIdName, mousseIdSignedIn, mousseIdPreparation, mousseIdSetupStep, useMousseId, useMousseIdStore, type SignInStart } from '../stores/mousseIdStore'
import { MousseIdAvatar } from './MousseIdAvatar'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import { ExternalLink, Logout, X } from '../lib/icons'
import './account-section.css'
import './profiles/profile-switcher.css'

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** Signed out is a normal state: this computer still syncs with the devices nearby. */
export const SIGNED_OUT_LINE = 'This computer is still one of your devices and syncs directly with the others when they’re nearby. Sign in to connect them over the internet and add phones.'

/** The plain account state the row shows; a lapsed device pass reads as Reconnecting, never as an error. */
export function accountState(plus: PlusStatus | undefined, lapsed: boolean): 'connected' | 'reconnecting' | 'disconnected' | 'signed-out' {
  // A computer whose pass lapsed stays signed in; the computer that manages your devices brings it back.
  if (plus?.configured && lapsed) return 'reconnecting'
  if (plus?.reconnecting) return 'reconnecting'
  if (plus?.connected) return 'connected'
  return plus?.configured ? 'disconnected' : 'signed-out'
}

/**
 * The account row at the top of Settings → Devices: who is signed in to Mousse ID and one plain status
 * (Connected, Reconnecting or not signed in), with Sign in or a quiet Sign out. Shown only when this build has
 * the service. `lapsed` is this computer's expired device pass; `onSetUp` brings the step this device needs into
 * view. `children` (the reconnecting note) sits under the row on the same surface.
 */
export function MousseIdAccount({ onSetUp, lapsed = false, children }: { onSetUp: () => void; lapsed?: boolean; children?: ReactNode }) {
  const state = useMousseId()
  const { plus, net, pending, busy, error, loaded } = state
  const [notice, setNotice] = useState(''), [needsSetup, setNeedsSetup] = useState('')
  const now = useNow(!!pending)

  const start = async () => {
    setNotice('')
    setNeedsSetup('')
    const result: SignInStart = await state.signIn()
    // A locked profile needs its passphrase first, which is entered further down this page.
    if (result === 'needs-setup') setNeedsSetup(mousseIdSetupStep(useMousseIdStore.getState().net))
    if (result === 'no-service') setNotice('This build has no Mousse ID service address. Set MOUSSE_ID_ORIGIN and restart Mousse.')
  }

  const signedIn = mousseIdSignedIn(plus)
  const status = accountState(plus, lapsed)
  const who = plus?.email ?? (plus?.accountId ? `Account ${plus.accountId}` : undefined)
  const title = signedIn || status !== 'signed-out' ? mousseIdName(plus) : pending ? 'Signing in…' : 'Not signed in to Mousse ID'
  const description = !loaded && !plus ? 'Checking Mousse ID…'
    : status === 'connected' ? <>{[who, plus?.plan].filter(Boolean).join(' · ')}{who || plus?.plan ? ' · ' : ''}<span className="settings-status-ok">Connected</span></>
      : status === 'reconnecting' ? <>{who ? `${who} · ` : ''}<span className="settings-status-warn">Reconnecting</span>{lapsed ? ' · waiting for your other computer to reconnect this one' : ''}</>
        : status === 'disconnected' ? `${who ? `${who} · ` : ''}Disconnected · sign in again to reconnect`
          : SIGNED_OUT_LINE
  const setupStep = !signedIn && !pending && loaded && mousseIdPreparation(net) === 'manual' ? mousseIdSetupStep(net) : ''
  // A step asked for by Sign in goes once this device is ready or signed in.
  const setupNote = (!signedIn && mousseIdPreparation(net) !== 'ready' ? needsSetup : '') || setupStep
  const locked = !!net?.self && net.keystore !== 'unlocked'

  return (
    <SettingsGroup anchor="account-mousse-id" className="account-group">
      <SettingsRow
        leading={<MousseIdAvatar plus={plus} />}
        title={title}
        description={description}
        control={
          signedIn || status === 'reconnecting' ? (
            <button type="button" className="settings-btn" disabled={busy || !net?.enabled} onClick={() => void state.signOut()}>
              <Logout size={14} />Sign out
            </button>
          ) : !pending && (
            <button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy} onClick={() => void start()}>Sign in</button>
          )
        }
      />
      {pending && (
        <SettingsRow
          indent
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
      {children}
    </SettingsGroup>
  )
}
