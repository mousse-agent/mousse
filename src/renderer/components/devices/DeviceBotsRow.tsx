import { SettingsRow, Switch } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import type { Device } from '../../lib/netDevices'

/** The row's short line; the tooltip says what the device then sees. */
export function deviceBotsLine(name: string, on: boolean) {
  return on
    ? <span title={`${name} lists and uses this computer's personal bots, each within the Devices choice in its About.`}>On · reaches this computer's bots</span>
    : <span title={`${name} sees none of this computer's bots: none is in its lists, and no chat, card or notification reaches it. Work they are doing carries on.`}>Off · sees none of this computer's bots</span>
}

/**
 * "Bots on this computer" for one device, beside its other switches in Devices: on (as before the switch), or off, so
 * the device reaches no bot here whatever each bot's Devices says. Set on this computer alone (`bridge.policy`); a
 * service from before the switch sends none, and no row shows.
 */
export function DeviceBotsRow({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const { busy, error, call } = useDaemonCall()
  const on = device.policy?.bots
  if (on === undefined) return null
  const set = async (bots: boolean) => {
    if (await call('bridge.policy', { node: device.node, bots })) onChanged()
  }
  return <>
    <SettingsRow
      indent
      title="Bots on this computer"
      description={deviceBotsLine(device.name, on)}
      control={<Switch checked={on} label={`Bots on this computer for ${device.name}`} disabled={busy} onChange={(next) => void set(next)} />}
    />
    {error && <p role="alert" className="chat-error devices-error">{error}</p>}
  </>
}
