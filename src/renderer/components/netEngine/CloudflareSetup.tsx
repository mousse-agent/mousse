import { useEffect, useRef, useState } from 'react'
import type { NetEngineCloudflare } from '../../../shared/netEngine/local'
import { useDaemonCall } from '../devices/useDaemonCall'
import { SettingsRow } from '../settings/SettingsRow'

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

export function CloudflareSetup({ connection }: { connection: NetEngineCloudflare | undefined }) {
  const { busy, error, call } = useDaemonCall()
  const [confirmForget, setConfirmForget] = useState(false)
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
    <div>
      {state === 'off' && !hostname ? (
        <p className="settings-muted">You’ll need a domain managed by Cloudflare.</p>
      ) : (
        <p role="status" className="settings-muted">{STATE_TEXT[state]}</p>
      )}
      {(error || message) && <p role="alert" className="chat-error">{error || message}</p>}
      <div className="devices-dialog-actions" style={ACTION_STYLE}>
        {state === 'sign_in' && loginUrl && (
          <button type="button" className="settings-btn" onClick={() => void window.mousse.providers?.openLoginUrl?.(loginUrl)}>
            Open Cloudflare
          </button>
        )}
        {canConnect && canForget && (
          <button type="button" className="settings-btn" disabled={busy} onClick={() => setConfirmForget(true)}>
            Forget connection…
          </button>
        )}
        {canConnect ? (
          <button
            type="button"
            className="settings-btn primary"
            disabled={busy}
            onClick={() => void call('netEngine.cloudflare.connect', {})}
          >
            {state === 'failed' ? 'Try again' : hostname ? 'Reconnect' : 'Connect Cloudflare'}
          </button>
        ) : state !== 'connected' && (
          <button type="button" className="settings-btn" disabled={busy} onClick={() => void call('netEngine.cloudflare.stop', {})}>
            {state === 'reconnecting' ? 'Stop' : 'Cancel'}
          </button>
        )}
      </div>
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
