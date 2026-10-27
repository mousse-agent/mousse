import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { Switch } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import { describePermissionMode, PERMISSION_MODES, type PermissionMode } from '../../../shared/permissionMode'
import type { BridgeNodePolicy } from '../../../shared/net/local'
import type { NodeId } from '../../../shared/net'

const btn = 'settings-btn devices-dialog-btn'

/**
 * What a computer may do on this one, set on this computer alone: the most permissive mode a
 * person on it can run a turn or an "Always" rule in, and whether it can open terminals here.
 */
export function DeviceLimitsDialog({ node, name, policy, onClose, onDone }: {
  node: NodeId
  name: string
  policy: BridgeNodePolicy
  onClose: () => void
  /** Reload devices after a change. */
  onDone: () => void
}) {
  const { busy, error, call } = useDaemonCall()
  const [mode, setMode] = useState<PermissionMode>(policy.maxPermissionMode)
  const [terminal, setTerminal] = useState(policy.terminal)
  const changed = mode !== policy.maxPermissionMode || terminal !== policy.terminal
  const save = async () => {
    const answer = await call('bridge.policy', {
      node,
      ...(mode !== policy.maxPermissionMode ? { maxPermissionMode: mode } : {}),
      ...(terminal !== policy.terminal ? { terminal } : {})
    })
    if (answer) { onDone(); onClose() }
  }
  return (
    <Modal
      open
      title={`Limits for ${name} on this computer`}
      onClose={onClose}
      footer={<button type="button" className={`${btn} primary`} disabled={busy || !changed} onClick={() => void save()}>Save</button>}
    >
      <div className="devices-dialog">
        <p className="settings-muted">These apply here only. {name} keeps its own limits for what this computer may do there.</p>
        <label className="devices-field">
          <span>Highest permission mode</span>
          <select className="settings-input" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as PermissionMode)}>
            {PERMISSION_MODES.map((value) => <option key={value} value={value}>{describePermissionMode(value)}</option>)}
          </select>
        </label>
        <div className="devices-field">
          <span>Terminals from this device</span>
          <Switch checked={terminal} label={`Terminals from ${name}`} disabled={busy} onChange={setTerminal} />
        </div>
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
