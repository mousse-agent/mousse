import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { Switch } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import { describePermissionMode, PERMISSION_MODES, type PermissionMode } from '../../../shared/permissionMode'
import type { AgentReach, BridgeNodePolicy } from '../../../shared/net/local'
import type { NodeId } from '../../../shared/net'

const btn = 'settings-btn devices-dialog-btn'

/** The choices for what a device's agents may change here, in the order shown. */
export const AGENT_REACH_CHOICES: ReadonlyArray<{ value: AgentReach; label: string }> = [
  { value: 'none', label: 'Nothing' },
  { value: 'launched', label: 'Threads they started' },
  { value: 'all', label: 'All threads' }
]

/**
 * What a computer may do on this one, set on this computer alone: the most permissive mode a
 * person on it can run a turn or an "Always" rule in, whether it can open terminals here, and whether
 * it can open its editor on this computer's folders (an SSH login here, so shell access like a terminal), and
 * which threads here its agents may change. A service from before that setting sends no `agentReach`, and the
 * choice is left out.
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
  const [editor, setEditor] = useState(policy.editor)
  const [reach, setReach] = useState<AgentReach | undefined>(policy.agentReach)
  const [work, setWork] = useState<boolean | undefined>(policy.work)
  const changed = mode !== policy.maxPermissionMode || terminal !== policy.terminal || editor !== policy.editor || reach !== policy.agentReach || work !== policy.work
  const save = async () => {
    const answer = await call('bridge.policy', {
      node,
      ...(work !== policy.work ? { work } : {}),
      ...(mode !== policy.maxPermissionMode ? { maxPermissionMode: mode } : {}),
      ...(terminal !== policy.terminal ? { terminal } : {}),
      ...(editor !== policy.editor ? { editor } : {}),
      ...(reach !== policy.agentReach ? { agentReach: reach } : {})
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
      <div className="devices-dialog" data-mousse-guarded="">
        <p className="settings-muted">These apply here only. {name} keeps its own limits for what this computer may do there.</p>
        {work !== undefined && <div className="devices-field">
          <span title={`Off, ${name} reads threads here, and can't start, send to, change or stop threads, or see files or Git. Its bot level is separate.`}>Work on threads from this device</span>
          <Switch checked={work} label={`Work on threads from ${name}`} disabled={busy} onChange={setWork} />
        </div>}
        <label className="devices-field">
          <span>Highest permission mode</span>
          <select className="settings-input" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as PermissionMode)}>
            {PERMISSION_MODES.map((value) => <option key={value} value={value}>{describePermissionMode(value)}</option>)}
          </select>
        </label>
        <p className="settings-muted">Subagents that {name}&rsquo;s agents start on this computer run no higher than this either.</p>
        {reach !== undefined && <>
          <label className="devices-field">
            <span>Agents on {name} may change</span>
            <select className="settings-input" data-field="agent-reach" value={reach} disabled={busy} onChange={(event) => setReach(event.target.value as AgentReach)}>
              {AGENT_REACH_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </label>
          <p className="settings-muted">
            What {name}&rsquo;s agents may start, message, steer and stop on this computer. They read threads here as {name} does.
            This is a rule for a computer that works as it should, not a barrier: for one you do not trust, block it or lower its highest permission mode.
          </p>
        </>}
        <div className="devices-field">
          <span>Terminals from this device</span>
          <Switch checked={terminal} label={`Terminals from ${name}`} disabled={busy} onChange={setTerminal} />
        </div>
        <div className="devices-field">
          <span>Editor connections from this device</span>
          <Switch checked={editor} label={`Editor connections from ${name}`} disabled={busy} onChange={setEditor} />
        </div>
        <p className="settings-muted">
          An editor connection is shell access: {name} signs in to this computer's own SSH server, as you, for as long as the editor stays connected. It ends at once when you block {name}, turn this off or turn Mousse Net off. This computer needs an SSH server running.
        </p>
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
