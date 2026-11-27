import { useEffect, useState } from 'react'
import type { BotDeviceAccess, BotDeviceAccessMode, BotDeviceChoice, BotDevicesView } from '../../../shared/bots/personal/deviceAccess'
import { BOT_DEVICES_TIP } from '../../../shared/bots/personal/deviceAccess'
import { botsClient } from '../../stores/botsStore'
import { errorText } from '../../services/personalBotsClient'
import { Switch } from '../settings/SettingsRow'
import '../../styles/botDevices.css'

/** The service (or this app's bridge) does not know the methods: an older one, which has no such choice. */
const missingMethod = (cause: unknown): boolean =>
  /method not allowed|not allowlisted|unknown method|domain method is unavailable/i.test(errorText(cause)) ||
  ['platform_method_not_allowed', 'method_not_available', 'method_not_found', 'unknown_method'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))

/** The devices ticked, as a choice: none ticked is this computer alone. */
export function accessOf(nodes: readonly string[]): BotDeviceAccess {
  return nodes.length ? { mode: 'chosen', nodes: [...nodes] } : { mode: 'this_computer' }
}

/** Why a device reaches no bot here whatever is ticked: its own switch for bots is off (Settings, Devices). */
const botsOffTip = (device: BotDeviceChoice) => `Bots on this computer are off for ${device.name} (Settings, Devices), so it reaches none of them.`

/**
 * One switch per other device of the owner's, after this computer, which is always on: New bot's Devices step and
 * About → Devices. A device whose own switch for bots is off (Settings, Devices) reaches no bot here whatever is picked,
 * and says so.
 */
export function BotDeviceSwitches({ name, devices, chosen, onTick }: { name: string; devices: BotDeviceChoice[]; chosen: readonly string[]; onTick(node: string, on: boolean): void }) {
  return <>
    <div className="bot-about-row bot-device-pick" data-testid="bot-device-here">
      <span>This computer</span>
      <Switch label={`This computer reaches ${name}`} checked disabled onChange={() => undefined} />
    </div>
    {devices.map((device) => (
      <div className="bot-about-row bot-device-pick" key={device.node} data-testid="bot-about-device">
        <span title={device.botsOff ? botsOffTip(device) : undefined}>
          {device.name}
          {device.botsOff && <small className="bot-about-next">Bots off for this device</small>}
        </span>
        <Switch label={`${device.name} reaches ${name}`} checked={chosen.includes(device.node)} onChange={(on) => onTick(device.node, on)} />
      </div>
    ))}
  </>
}

/**
 * About → Devices: which of the owner's devices reach this bot. This computer always does; each other device (phones
 * too) has its own switch, off until the owner turns it on, so a device linked later reaches no bot. A device left out
 * sees nothing of the bot (the tooltip). An older service has no such choice, and the row is not shown.
 */
export function BotDevicesRow({ botId, name, reach }: { botId: string; name: string; reach?: BotDeviceAccessMode | undefined }) {
  const [view, setView] = useState<BotDevicesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const client = botsClient()
  // Another bot: nothing of the last one's choice shows while its own is read.
  useEffect(() => { setView(null) }, [botId])
  // Read again when the list says the choice changed elsewhere (Make private in the bot's menu).
  useEffect(() => {
    let live = true
    client.devices(botId).then(
      (next) => { if (live) setView(next) },
      (cause) => {
        if (!live) return
        if (missingMethod(cause)) setMissing(true)
        else setError(errorText(cause))
      }
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, reach])
  if (missing) return null
  if (!view) return error ? <p className="bot-about-empty" role="alert">{error}</p> : null
  const save = async (access: BotDeviceAccess) => {
    const before = view
    setError(null)
    setView({ ...view, access })
    try {
      setView(await client.setDevices(botId, access))
    } catch (cause) {
      setView(before)
      setError(errorText(cause))
    }
  }
  const chosen = view.access.mode === 'chosen' ? view.access.nodes : []
  const tick = (node: string, on: boolean) => void save(accessOf(on ? [...chosen, node] : chosen.filter((id) => id !== node)))
  const tip = view.unreadable ? 'What was saved could not be read, so only this computer reaches this bot until you pick again.' : BOT_DEVICES_TIP
  return <>
    <div className="bot-about-row" data-testid="bot-about-devices">
      <span title={tip}>Devices</span>
      {!view.devices.length && <small className="bot-about-next" title={tip}>Only this computer</small>}
    </div>
    {view.devices.length > 0 && <BotDeviceSwitches name={name} devices={view.devices} chosen={chosen} onTick={tick} />}
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}
