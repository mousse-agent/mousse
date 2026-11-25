import { useEffect, useRef, useState } from 'react'
import type { NetEngineCloudflare } from '../../../shared/netEngine/local'
import { useDaemonCall } from '../devices/useDaemonCall'
import { SettingsRow } from '../settings/SettingsRow'
import { ChoiceRow } from './pairingParts'

const STATE_TEXT: Record<NetEngineCloudflare['state'], string> = {
  off: 'Disconnected',
  preparing: 'Preparing Cloudflare…',
  sign_in: 'Finish signing in in your browser.',
  connecting: 'Checking your tunnel…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Needs attention'
}

const ACTION_STYLE = { gap: 'var(--space-8)', marginTop: 'var(--space-8)' }

/**
 * Let a device in → Cloudflare Tunnel: set one up on the owner's own domain (sign in, then Make code once it runs),
 * or use a tunnel they already run (its address is pasted in Reach this computer).
 */
export function CloudflareSetup({
  connection,
  onMake,
  onOwnTunnel
}: {
  connection: NetEngineCloudflare | undefined
  /** The tunnel runs: make a code for it. */
  onMake: () => void
  /** Use my own tunnel: Reach this computer takes its address. */
  onOwnTunnel: () => void
}) {
  const { busy, error, call } = useDaemonCall()
  const [confirmForget, setConfirmForget] = useState(false)
  const [own, setOwn] = useState(false)
  const opened = useRef<string | undefined>(undefined)
  const loginUrl = connection?.loginUrl
  useEffect(() => {
    if (!loginUrl || loginUrl === opened.current) return
    opened.current = loginUrl
    void window.mousse.providers?.openLoginUrl?.(loginUrl)
  }, [loginUrl])
  if (!connection) return <p role="status" className="settings-muted">Waiting for networking…</p>
  const { state, hostname, message, canForget } = connection
  const canConnect = state === 'off' || state === 'failed'
  if (confirmForget && canConnect && canForget) {
    return (
      <div>
        <p className="settings-muted">The tunnel and its DNS record will stay in Cloudflare.</p>
        {error && <p role="alert" className="chat-error">{error}</p>}
        <div className="devices-dialog-actions" style={ACTION_STYLE}>
          <button type="button" className="settings-btn" onClick={() => setConfirmForget(false)} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="settings-btn danger-fill"
            disabled={busy}
            onClick={() => {
              void call('netEngine.cloudflare.forget', {}).then((answer) => {
                if (answer) setConfirmForget(false)
              })
            }}
          >
            Forget connection
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="engine-choices">
      <div className="engine-choice-list" role="radiogroup" aria-label="Cloudflare Tunnel">
        <ChoiceRow
          selected={!own}
          label="Set one up"
          detail="On a domain you manage in Cloudflare."
          onPick={() => setOwn(false)}
        />
        <ChoiceRow
          selected={own}
          label="Use my own tunnel"
          detail="Paste its https:// address."
          onPick={() => setOwn(true)}
        />
      </div>
      {own ? (
        <div className="devices-dialog-actions">
          <button type="button" className="settings-btn ui-btn-primary" title="In Reach this computer" onClick={onOwnTunnel}>
            Paste address
          </button>
        </div>
      ) : (
        <>
          {state === 'connected' ? (
            <p role="status">
              <span className="engine-ready-dot" aria-hidden="true" />
              {hostname ? `${hostname} is running` : STATE_TEXT.connected}
            </p>
          ) : (
            (state !== 'off' || hostname) && (
              <p role="status" className="settings-muted">
                {hostname && state !== 'failed' ? `${hostname} · ` : ''}
                {STATE_TEXT[state]}
              </p>
            )
          )}
          {(error || message) && <p role="alert" className="chat-error">{error || message}</p>}
          <SetupActions
            state={state}
            hostname={hostname}
            loginUrl={loginUrl}
            canForget={canForget}
            busy={busy}
            call={call}
            onForget={() => setConfirmForget(true)}
            onMake={onMake}
          />
        </>
      )}
    </div>
  )
}

/** The one action for the tunnel's state (Sign in, Make code, Cancel, Stop), with Open Cloudflare and Forget. */
function SetupActions({
  state,
  hostname,
  loginUrl,
  canForget,
  busy,
  call,
  onForget,
  onMake
}: {
  state: NetEngineCloudflare['state']
  hostname?: string
  loginUrl?: string
  canForget?: boolean
  busy: boolean
  call: ReturnType<typeof useDaemonCall>['call']
  onForget: () => void
  onMake: () => void
}) {
  const canConnect = state === 'off' || state === 'failed'
  return (
    <div className="devices-dialog-actions">
      {state === 'sign_in' && loginUrl && (
        <button type="button" className="settings-btn" onClick={() => void window.mousse.providers?.openLoginUrl?.(loginUrl)}>
          Open Cloudflare
        </button>
      )}
      {canConnect && canForget && (
        <button type="button" className="settings-btn" disabled={busy} onClick={onForget}>
          Forget connection…
        </button>
      )}
      {state === 'connected' ? (
        <button type="button" className="settings-btn ui-btn-primary" onClick={onMake}>
          Make code
        </button>
      ) : canConnect ? (
        <button
          type="button"
          className="settings-btn ui-btn-primary"
          disabled={busy}
          onClick={() => void call('netEngine.cloudflare.connect', {})}
        >
          {state === 'failed' ? 'Try again' : hostname ? 'Reconnect' : 'Sign in to Cloudflare'}
        </button>
      ) : (
        <button type="button" className="settings-btn" disabled={busy} onClick={() => void call('netEngine.cloudflare.stop', {})}>
          {state === 'reconnecting' ? 'Stop' : 'Cancel'}
        </button>
      )}
    </div>
  )
}

export function CloudflareReachRow({
  connection,
  onSetup
}: {
  connection: NetEngineCloudflare
  onSetup: () => void
}) {
  const { busy, error, call } = useDaemonCall()
  const { state, hostname, message } = connection
  const canConnect = state === 'off' || state === 'failed'
  const signingIn = state === 'sign_in'
  return (
    <SettingsRow
      title="Cloudflare Tunnel"
      description={
        <span className="engine-row-line">
          {hostname && <>{hostname} · </>}
          <span role="status">{STATE_TEXT[state]}</span>
          {(error || message) && <span className="settings-status-warn" role="alert"> · {error || message}</span>}
        </span>
      }
      control={
        <button
          type="button"
          className="settings-btn"
          disabled={busy}
          onClick={canConnect || signingIn ? onSetup : () => void call('netEngine.cloudflare.stop', {})}
        >
          {state === 'connected' || state === 'reconnecting'
            ? 'Stop'
            : signingIn ? 'Continue setup' : canConnect ? 'Set up' : 'Cancel'}
        </button>
      }
    />
  )
}
