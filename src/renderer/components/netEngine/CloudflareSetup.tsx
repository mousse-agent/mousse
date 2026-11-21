import type { NetEngineCloudflare } from '../../../shared/netEngine/local'
import { useDaemonCall } from '../devices/useDaemonCall'
import { SettingsRow } from '../settings/SettingsRow'

const STATE_TEXT: Record<NetEngineCloudflare['state'], string> = {
  off: 'Disconnected',
  preparing: 'Preparing Cloudflare…',
  sign_in: 'Finish signing in in your browser.',
  connecting: 'Checking your tunnel…',
  connected: 'Connected',
  failed: 'Needs attention'
}

export function CloudflareSetup({ connection }: { connection: NetEngineCloudflare | undefined }) {
  const { busy, error, call } = useDaemonCall()
  if (!connection) return <p role="status" className="settings-muted">Waiting for networking…</p>
  const { state, hostname, message, loginUrl } = connection
  const canConnect = state === 'off' || state === 'failed'
  return (
    <div>
      {state === 'off' && !hostname ? (
        <p className="settings-muted">You’ll need a domain managed by Cloudflare.</p>
      ) : (
        <p role="status" className="settings-muted">{STATE_TEXT[state]}</p>
      )}
      {(error || message) && <p role="alert" className="chat-error">{error || message}</p>}
      <div className="devices-dialog-actions" style={{ gap: 'var(--space-8)', marginTop: 'var(--space-8)' }}>
        {state === 'sign_in' && loginUrl && (
          <button type="button" className="settings-btn" onClick={() => void window.mousse.providers?.openLoginUrl?.(loginUrl)}>
            Open Cloudflare
          </button>
        )}
        {canConnect ? (
          <button
            type="button"
            className="settings-btn primary"
            disabled={busy}
            onClick={() => void call('netEngine.cloudflare.connect', {})}
          >
            {state === 'failed' ? 'Try again' : 'Connect Cloudflare'}
          </button>
        ) : state !== 'connected' && (
          <button type="button" className="settings-btn" disabled={busy} onClick={() => void call('netEngine.cloudflare.stop', {})}>
            Cancel
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
          {state === 'connected' ? 'Stop' : signingIn ? 'Continue setup' : canConnect ? 'Set up' : 'Cancel'}
        </button>
      }
    />
  )
}
