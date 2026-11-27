import { Segmented, SettingsRow, type SegmentedOption } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import type { Device } from '../../lib/netDevices'
import type { BotLevel } from '../../../shared/net/local'

/** What each level lets the device do, for the row's line and each choice's tooltip. */
export function deviceBotsTip(name: string, level: BotLevel): string {
  if (level === 'off')
    return `${name} sees none of this computer's bots: none is in its lists, and no chat, card or notification reaches it. Work they are doing carries on.`
  if (level === 'use')
    return `${name} chats with this computer's bots, answers their questions, stops them, and reads their chat, memory, browser and applets. It can't rename, set up, pause, delete or make one.`
  return `${name} does everything with this computer's bots, setting them up, pausing, deleting and making them included. Each bot's Devices choice in its About still applies.`
}

/** The row's short line; the tooltip says what the device then may do. */
export function deviceBotsLine(name: string, level: BotLevel) {
  const words = { off: 'Sees none of them', use: 'Chats and answers', full: 'Uses and sets them up' }[level]
  return <span title={deviceBotsTip(name, level)}>{words}</span>
}

/**
 * "Bots on this computer" for one device, beside its other switches in Devices: Off (it reaches no bot here), Use
 * (chat, answers, stop, reading) or Full (every remote bot action). Set on this computer alone (`bridge.policy`); a
 * service from before the level sends none, and no row shows.
 */
export function DeviceBotsRow({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const { busy, error, call } = useDaemonCall()
  const level = device.policy?.bots
  if (level === undefined) return null
  const set = async (bots: BotLevel) => {
    if (await call('bridge.policy', { node: device.node, bots })) onChanged()
  }
  const options: ReadonlyArray<SegmentedOption<BotLevel>> = [
    { value: 'off', label: 'Off', title: deviceBotsTip(device.name, 'off') },
    { value: 'use', label: 'Use', title: deviceBotsTip(device.name, 'use') },
    { value: 'full', label: 'Full', title: deviceBotsTip(device.name, 'full') }
  ]
  return <>
    <SettingsRow
      indent
      title="Bots on this computer"
      description={deviceBotsLine(device.name, level)}
      control={<Segmented value={level} options={options} disabled={busy} ariaLabel={`Bots on this computer for ${device.name}`} onChange={(next) => void set(next)} />}
    />
    {error && <p role="alert" className="chat-error devices-error">{error}</p>}
  </>
}
