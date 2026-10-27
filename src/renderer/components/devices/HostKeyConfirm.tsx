import { useState } from 'react'
import { CopyButton } from '../settings/IconButtons'
import type { SshHostKeyView } from '../../../shared/net/local'

/** Whether this host key can be trusted from the dialog at all. */
export const canTrustHostKey = (hostKey: SshHostKeyView) => hostKey.state === 'unknown' || hostKey.state === 'changed'

/**
 * The host key a remote machine offered, and the explicit confirmation before Mousse trusts it.
 * `onConfirm` gets the fingerprint shown here, never one read again later.
 */
export function HostKeyConfirm({ hostKey, busy, onConfirm }: {
  hostKey: SshHostKeyView
  busy: boolean
  onConfirm: (fingerprint: string, acknowledgeChanged: boolean) => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const changed = hostKey.state === 'changed'
  const ready = canTrustHostKey(hostKey) && (!changed || acknowledged)
  const others = hostKey.knownByOtherTypes?.filter(Boolean) ?? []
  return (
    <div className="devices-host-key">
      {hostKey.state === 'trusted' && <p className="settings-status-ok">Host key already trusted.</p>}
      {hostKey.state === 'revoked' && <p role="alert" className="chat-error">This host key was revoked. Mousse will not connect to this machine.</p>}
      {hostKey.state === 'unknown' && <p>Mousse has not seen this machine before. Check that the host key fingerprint matches the remote machine before you trust it.</p>}
      {changed && <p role="alert" className="chat-error"><strong>The host key has changed.</strong> Someone may be pretending to be this machine. Trust the new key only if you know why it changed.</p>}
      <div className="devices-fingerprint">
        <span className="settings-muted">{changed ? `New ${hostKey.type} key` : `${hostKey.type} key`}</span>
        <code className="devices-code" aria-label="Host key fingerprint">{hostKey.fingerprint}</code>
        <CopyButton text={hostKey.fingerprint} label="Copy fingerprint" />
      </div>
      {changed && hostKey.changed && (
        <div className="devices-fingerprint">
          <span className="settings-muted">Previous key, in {hostKey.changed.file}</span>
          <code className="devices-code" aria-label="Previous host key fingerprint">{hostKey.changed.previousFingerprint}</code>
        </div>
      )}
      {hostKey.state === 'unknown' && others.length > 0 && (
        <p className="settings-muted">Your terminal already knows this host by a {others.join(' or ')} key; this is its {hostKey.type} key.</p>
      )}
      {hostKey.stale?.map((old) => (
        <p key={old.file + old.previousFingerprint} className="settings-muted">An older key for this host is still in {old.file}: <code className="devices-code">{old.previousFingerprint}</code></p>
      ))}
      {changed && (
        <label className="devices-check">
          <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
          I know why the host key changed
        </label>
      )}
      {canTrustHostKey(hostKey) && (
        <div className="devices-dialog-actions">
          <button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy || !ready} onClick={() => onConfirm(hostKey.fingerprint, changed)}>
            Trust this host key
          </button>
        </div>
      )}
    </div>
  )
}
