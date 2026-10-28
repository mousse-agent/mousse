import { SettingsRow, Switch } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import { useEditorAskStore } from '../../stores/editorAskStore'
import type { EditorAskView } from '../../../shared/bridge/editorAsk'
import type { BridgeNodePolicy } from '../../../shared/net/local'
import type { Device } from '../../lib/netDevices'

export interface DeviceAccessViewProps {
  name: string
  policy: BridgeNodePolicy
  busy: boolean
  /** The device's ask for editor connections, while it waits for an answer. */
  ask?: EditorAskView
  onSetTerminal(on: boolean): void
  onSetEditor(on: boolean): void
  onAllow(): void
  onNotNow(): void
}

/** One short phrase; the longer words are the tooltip. */
const line = (state: string, detail: string) => <span title={detail}>{state}</span>
const terminalLine = (name: string, on: boolean) =>
  line(`${on ? 'On' : 'Off'} · shell access`, `${name} can open, type into and stop terminals on this computer. They end at once when you block ${name}, turn this off or turn Mousse Net off.`)
const editorLine = (name: string, on: boolean, asked: boolean) =>
  line(
    asked ? 'Asked · shell access' : `${on ? 'On' : 'Off'} · shell access`,
    `${name}'s editor signs in to this computer's own SSH server as you, so one needs to be running. It ends at once when you block ${name}, turn this off or turn Mousse Net off.`
  )

/**
 * The two ways another computer gets a shell here, side by side under its row in Devices: terminals and
 * editor connections. A waiting ask for editor connections is answered in the same row.
 */
export function DeviceAccessView({ name, policy, busy, ask, onSetTerminal, onSetEditor, onAllow, onNotNow }: DeviceAccessViewProps) {
  return <>
    <SettingsRow
      indent
      title="Terminals from this device"
      description={terminalLine(name, policy.terminal)}
      control={<Switch checked={policy.terminal} label={`Terminals from ${name}`} disabled={busy} onChange={onSetTerminal} />}
    />
    <SettingsRow
      indent
      title="Editor connections from this device"
      description={editorLine(name, policy.editor, !!ask)}
      control={<>
        {ask && <>
          <button type="button" className="settings-btn" data-action="decline-editor-ask" disabled={busy} onClick={onNotNow}>Not now</button>
          <button type="button" className="settings-btn" data-action="allow-editor-ask" disabled={busy} onClick={onAllow}>Allow</button>
        </>}
        <Switch checked={policy.editor} label={`Editor connections from ${name}`} disabled={busy} onChange={onSetEditor} />
      </>}
    />
  </>
}

/** Sets the switches on this computer and answers a waiting ask, then has the screen read devices again. */
export function DeviceAccessRows({ device, ask, onChanged }: {
  device: Device
  ask?: EditorAskView
  onChanged: () => void
}) {
  const { busy, error, call } = useDaemonCall()
  const answering = useEditorAskStore((s) => s.busy)
  const askError = useEditorAskStore((s) => (s.errorNode === device.node ? s.error : ''))
  const answer = useEditorAskStore((s) => s.answer)
  const node = device.node
  if (!device.policy) return null

  const set = async (change: { terminal: boolean } | { editor: boolean }) => {
    if (await call('bridge.policy', { node, ...change })) onChanged()
  }
  const decide = async (allow: boolean) => {
    if (await answer(node, allow)) onChanged()
  }
  const shown = error || askError
  return <>
    <DeviceAccessView
      name={device.name}
      policy={device.policy}
      busy={busy || answering}
      ask={ask}
      onSetTerminal={(terminal) => void set({ terminal })}
      onSetEditor={(editor) => void set({ editor })}
      onAllow={() => void decide(true)}
      onNotNow={() => void decide(false)}
    />
    {shown && <p role="alert" className="chat-error devices-error">{shown}</p>}
  </>
}
