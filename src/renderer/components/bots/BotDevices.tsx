import { useEffect, useState } from 'react'
import type { BotDeviceAccess, BotDeviceAccessMode, BotDevicesView } from '../../../shared/bots/personal/deviceAccess'
import { BOT_DEVICES_TIP } from '../../../shared/bots/personal/deviceAccess'
import { botsClient } from '../../stores/botsStore'
import { errorText } from '../../services/personalBotsClient'
import { Select, type SelectOption } from '../ui/Select'
import '../../styles/botDevices.css'

/** The service (or this app's bridge) does not know the methods: an older one, which has no such choice. */
const missingMethod = (cause: unknown): boolean =>
  /method not allowed|not allowlisted|unknown method|domain method is unavailable/i.test(errorText(cause)) ||
  ['platform_method_not_allowed', 'method_not_available', 'method_not_found', 'unknown_method'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))

/** The Devices row's three choices; Chosen devices needs a device to pick. */
export function botDeviceOptions(view: Pick<BotDevicesView, 'devices'>): SelectOption<BotDeviceAccessMode>[] {
  return [
    { value: 'all', label: 'All my devices' },
    { value: 'this_computer', label: 'Only this computer' },
    { value: 'chosen', label: 'Chosen devices', ...(view.devices.length ? {} : { disabled: true, description: 'No other devices yet' }) }
  ]
}

/** What picking `mode` saves: Chosen devices starts from the devices already picked, or none. */
export function accessFor(mode: BotDeviceAccessMode, current: BotDeviceAccess): BotDeviceAccess {
  if (mode !== 'chosen') return { mode }
  return { mode: 'chosen', nodes: current.mode === 'chosen' ? current.nodes : [] }
}

/**
 * About → Devices: which of the owner's devices reach this bot. All my devices (as every bot did before), Only this
 * computer, or Chosen devices, ticked one by one. A device left out sees nothing of the bot (the tooltip). A device whose
 * own switch for bots is off (Settings, Devices) reaches no bot here whatever is ticked, and says so. An older service has
 * no such choice, and the row is not shown.
 */
export function BotDevicesRow({ botId, name }: { botId: string; name: string }) {
  const [view, setView] = useState<BotDevicesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const client = botsClient()
  useEffect(() => {
    let live = true
    setView(null)
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
  }, [botId])
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
  const access = view.access
  const chosen = access.mode === 'chosen' ? access.nodes : []
  const tick = (node: string, on: boolean) => void save({ mode: 'chosen', nodes: on ? [...chosen, node] : chosen.filter((id) => id !== node) })
  return <>
    <div className="bot-about-row" data-testid="bot-about-devices">
      <span title={BOT_DEVICES_TIP}>Devices</span>
      <Select
        ariaLabel={`Devices that reach ${name}`}
        size="small"
        value={access.mode}
        options={botDeviceOptions(view)}
        title={view.unreadable ? 'What was saved could not be read, so only this computer reaches this bot until you pick again.' : BOT_DEVICES_TIP}
        onChange={(mode) => void save(accessFor(mode, access))}
      />
    </div>
    {access.mode === 'chosen' && view.devices.map((device) => (
      <label className="bot-about-row bot-device-pick" key={device.node} data-testid="bot-about-device">
        <input type="checkbox" checked={chosen.includes(device.node)} onChange={(event) => tick(device.node, event.target.checked)} />
        <span title={device.botsOff ? `Bots on this computer are off for ${device.name} (Settings, Devices), so it reaches none of them.` : undefined}>
          {device.name}
          {device.botsOff && <small className="bot-about-next">Bots off for this device</small>}
        </span>
      </label>
    ))}
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}
