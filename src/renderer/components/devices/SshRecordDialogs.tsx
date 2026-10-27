import { useState, type FormEvent } from 'react'
import { Modal } from '../ui/Modal'
import { CommandLine, UndoReport } from './SshParts'
import { HostKeyConfirm } from './HostKeyConfirm'
import { useDaemonCall } from './useDaemonCall'
import type { SshCheckResult, SshRecordView, SshTrustResult, SshUndoResult, SshUpdateResult } from '../../../shared/net/local'

interface RecordDialogProps {
  record: SshRecordView
  /** The device name, or the SSH endpoint for a setup that never joined. */
  name: string
  onClose: () => void
  /** Reload devices after a change. */
  onDone: () => void
}

const btn = 'settings-btn devices-dialog-btn'

/** Confirms undoing a remote machine setup, then shows what came off the machine. */
export function UndoSetupDialog({ record, name, onClose, onDone }: RecordDialogProps) {
  const { busy, error, call } = useDaemonCall()
  const [result, setResult] = useState<SshUndoResult>()
  const undo = async () => {
    const answer = await call<SshUndoResult>('net.ssh.undo', { id: record.id })
    if (answer) { setResult(answer.value); onDone() }
  }
  return (
    <Modal
      open
      title={`Undo setup on ${name}?`}
      onClose={onClose}
      footer={result
        ? <button type="button" className={`${btn} primary`} onClick={onClose}>Close</button>
        : <button type="button" className={`${btn} danger-fill`} disabled={busy} onClick={() => void undo()}>Undo setup</button>}
    >
      <div className="devices-dialog">
        {result ? <UndoReport result={result} /> : (
          <p>This stops Mousse on {name} (<code className="devices-code">{record.endpoint}</code>) and removes what setup installed or changed there. Its data and identity stay on the machine.</p>
        )}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}

/**
 * Changes the SSH address this computer uses to reach a remote machine. The new address is checked
 * first: its host key must be the machine's own and trusted here before anything is changed.
 */
export function RenameEndpointDialog({ record, name, onClose, onDone }: RecordDialogProps) {
  const { busy, error, setError, call } = useDaemonCall()
  const [endpoint, setEndpoint] = useState(record.endpoint)
  const [pending, setPending] = useState<SshCheckResult>()
  const next = endpoint.trim()
  const rename = async () => {
    const answer = await call<{ ok: boolean; detail?: string }>('net.ssh.rename', { id: record.id, endpoint: next })
    if (!answer) return
    if (!answer.value.ok) { setError(answer.value.detail || 'The address was not changed.'); return }
    onDone(); onClose()
  }
  const check = async () => {
    setPending(undefined)
    const answer = await call<SshCheckResult>('net.ssh.check', { host: next })
    if (!answer) return
    const result = answer.value
    if (result.problem) { setError(result.detail || 'Could not check the address.'); return }
    if (result.hostKey && result.hostKey.state !== 'trusted') { setPending(result); return }
    await rename()
  }
  const trust = async (fingerprint: string, acknowledgeChanged: boolean) => {
    const answer = await call<SshTrustResult>('net.ssh.trust', { host: next, fingerprint, ...(acknowledgeChanged ? { acknowledgeChanged: true } : {}) })
    if (!answer) return
    if (!answer.value.ok) { setError(answer.value.detail || 'The host key was not trusted.'); return }
    setPending(undefined)
    await rename()
  }
  const hostKey = pending?.hostKey
  return (
    <Modal
      open
      title={`SSH address for ${name}`}
      onClose={onClose}
      footer={hostKey ? undefined : <button type="submit" form={`ssh-rename-${record.id}`} className={`${btn} primary`} disabled={busy || !next || next === record.endpoint}>Save</button>}
    >
      <form id={`ssh-rename-${record.id}`} className="devices-dialog" onSubmit={(event) => { event.preventDefault(); if (next && !busy) void check() }}>
        <p className="settings-muted">What this computer types after ssh to reach {name}: a host or SSH config alias. It must reach the same machine.</p>
        <label className="devices-field">
          <span>SSH address</span>
          <input value={endpoint} maxLength={253} spellCheck={false} onChange={(event) => { setEndpoint(event.target.value); setPending(undefined) }} />
        </label>
        {hostKey && <HostKeyConfirm key={`${hostKey.fingerprint}-${hostKey.state}`} hostKey={hostKey} busy={busy} onConfirm={(fingerprint, acknowledgeChanged) => void trust(fingerprint, acknowledgeChanged)} />}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </form>
    </Modal>
  )
}

/** Updates Mousse on a remote machine this computer set up. */
export function UpdateRemoteDialog({ record, name, onClose, onDone }: RecordDialogProps) {
  const { busy, error, call } = useDaemonCall()
  const [result, setResult] = useState<SshUpdateResult>()
  const update = async () => {
    const answer = await call<SshUpdateResult>('net.ssh.update', { id: record.id })
    if (answer) { setResult(answer.value); onDone() }
  }
  return (
    <Modal
      open
      title={`Update Mousse on ${name}?`}
      onClose={onClose}
      footer={result
        ? <button type="button" className={`${btn} primary`} onClick={onClose}>Close</button>
        : <button type="button" className={`${btn} primary`} disabled={busy} onClick={() => void update()}>Update</button>}
    >
      <div className="devices-dialog">
        {!result && <p>Threads running on {name} will be interrupted while Mousse restarts there.{record.version ? ` It runs ${record.version} now.` : ''}</p>}
        {busy && <p role="status" className="settings-muted">Updating…</p>}
        {result?.ok && <p role="status" className="settings-status-ok">{result.version ? `${name} now runs Mousse ${result.version}.` : `${name} is up to date.`}</p>}
        {result && !result.ok && <p role="alert" className="chat-error">{result.detail || 'The update did not finish.'}</p>}
        {result?.command && (
          <>
            <p>Run this on {name} to update it:</p>
            <CommandLine command={result.command} />
          </>
        )}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
