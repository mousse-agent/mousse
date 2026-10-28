import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { HostKeyConfirm, canTrustHostKey } from './HostKeyConfirm'
import { useDaemonCall } from './useDaemonCall'
import type { SshCheckResult, SshTrustResult } from '../../../shared/net/local'
import type { NodeId } from '../../../shared/net'

type Approval = SshCheckResult & { approved: boolean }

/**
 * A device offers a route over SSH that this computer has not approved. Checking it reads the
 * host key; an unknown or changed key is confirmed here before the route is approved.
 */
export function ApproveSshRouteDialog({ node, name, endpoint: offered, title, intro, onClose, onDone }: {
  node: NodeId
  name: string
  endpoint: string
  /** Replaces the heading, where the dialog is opened for an editor and not from the device list. */
  title?: string
  /** Replaces the opening paragraph. */
  intro?: string
  onClose: () => void
  onDone: () => void
}) {
  const { busy, error, setError, call } = useDaemonCall()
  // The device's own address may mean another host, or nothing, on this computer: it can be changed.
  const [typed, setTyped] = useState(offered)
  const endpoint = typed.trim()
  const [result, setResult] = useState<Approval>()
  const approve = async () => {
    setResult(undefined)
    const answer = await call<Approval>('net.ssh.approve', { node, endpoint })
    if (!answer) return
    setResult(answer.value)
    if (answer.value.approved) onDone()
  }
  const trust = async (fingerprint: string, acknowledgeChanged: boolean) => {
    const answer = await call<SshTrustResult>('net.ssh.trust', { host: endpoint, fingerprint, ...(acknowledgeChanged ? { acknowledgeChanged: true } : {}) })
    if (!answer) return
    if (!answer.value.ok) { setError(answer.value.detail || 'The host key was not trusted.'); return }
    await approve()
  }
  const hostKey = result?.hostKey
  const confirming = result?.phase === 'untrusted' && !!hostKey && canTrustHostKey(hostKey) && !result.problem
  const stopped = result?.problem === 'host_key_revoked' || hostKey?.state === 'revoked'
  const btn = 'settings-btn devices-dialog-btn'
  const footer = result?.approved ? <button type="button" className={`${btn} primary`} onClick={onClose}>Done</button>
    : confirming || stopped ? undefined
      : <button type="button" className={`${btn} primary`} disabled={busy || !endpoint} onClick={() => void approve()}>{result ? 'Retry' : 'Check and approve'}</button>
  return (
    <Modal open title={title ?? `Use SSH route to ${name}`} onClose={onClose} footer={footer}>
      <div className="devices-dialog">
        <p>{intro ?? `${name} offers an SSH address. Use an address that reaches it from this computer, then Mousse checks the host key and the login before it approves the route.`}</p>
        <label className="devices-field">
          <span>SSH address</span>
          <input value={typed} maxLength={253} spellCheck={false} disabled={busy || !!result?.approved} onChange={(event) => { setTyped(event.target.value); setResult(undefined); setError('') }} />
        </label>
        {busy && !result && <p role="status" className="settings-muted">Checking the remote machine…</p>}
        {result?.approved && <p role="status" className="settings-status-ok">This computer now reaches {name} over SSH.</p>}
        {result && !result.approved && result.problem && (
          <p role="alert" className="chat-error">{result.detail || 'Could not check the remote machine.'}</p>
        )}
        {result?.problem === 'proxy_refused' && <p className="settings-muted">Mousse can’t use a ProxyJump or ProxyCommand yet. Use a host entry that reaches the machine directly.</p>}
        {result && !result.approved && !result.problem && result.phase === 'probed' && result.detail && <p role="alert" className="chat-error">{result.detail}</p>}
        {hostKey && !result?.approved && (
          <HostKeyConfirm key={`${hostKey.fingerprint}-${hostKey.state}`} hostKey={hostKey} busy={busy} onConfirm={(fingerprint, acknowledgeChanged) => void trust(fingerprint, acknowledgeChanged)} />
        )}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
